// EchoFlow HLS Token Worker — storage backends
//
// WHY THIS FILE EXISTS
//
// The Worker originally fetched HLS objects exclusively through the R2
// binding (`env.MEDIA_BUCKET.get()`), which is correct for production. But a
// Cloudflare R2 *binding* has no S3 endpoint to point at: under `wrangler dev`
// it is served by miniflare's local blob store in `.wrangler/state/`, which is
// completely disconnected from the Docker MinIO instance. Verified before this
// file was written:
//
//   env.MEDIA_BUCKET.get("hls/<id>/master.m3u8")  ->  null   (always)
//
// so locally the Worker could gate requests but could never return a byte of
// real content. That makes it impossible to prove the two things that matter
// about a token gate: that it actually denies, and that it actually serves.
//
// So there are two backends behind one interface, selected purely by env:
//
//   MEDIA_S3_ENDPOINT unset  ->  R2 binding                      (production)
//   MEDIA_S3_ENDPOINT set    ->  S3/MinIO over signed fetch      (local dev)
//
// Selection is fail-loud: an unconfigured Worker throws rather than silently
// 404ing, so a missing .dev.vars surfaces as an obvious error instead of an
// auth-looking failure.
//
// WHY aws4fetch AND NOT A HAND-ROLLED SIGNER
//
// This was hand-rolled first, and it was wrong twice — in opposite directions.
// A hand-rolled implementation that is self-consistent passes every test
// written against itself while failing against the real server:
//
//   1. `UNSIGNED-PAYLOAD` is what boto3 and MinIO expect for a presigned GET,
//      not sha256("") — see UNSIGNED_PAYLOAD below.
//   2. The credential scope is `<date>/<region>/s3/aws4_request` WITHOUT the
//      access key id; the access key id belongs in X-Amz-Credential only.
//
// Each was found by a 403 from MinIO, not by a test. `aws4fetch` is ~4 kB,
// audited, and removes the entire class of bug, so the only thing this file
// does is construct the URL and forward the headers it returns.
//
// HACK: MinIO requires path-style addressing, so the bucket is always a path
// segment (`/<bucket>/<key>`), never a subdomain. That matches
// `addressing_style: "path"` in backend/EchoFlow/settings.py. Virtual-hosted
// addressing (AWS proper) is NOT supported here: this backend exists for
// MinIO, not for AWS S3.

import { AwsClient } from "aws4fetch";

// ---------------------------------------------------------------------------
// Env interface
//
// Declared here rather than in index.ts so storage.ts can type its own
// backends without importing from index.ts (which would be circular).
// index.ts imports and re-exports it.
// ---------------------------------------------------------------------------

export interface Env {
  // Production storage. Bound via [[r2_buckets]] in wrangler.toml.
  MEDIA_BUCKET?: R2Bucket;
  MEDIA_TOKEN_SECRET: string;
  MEDIA_TOKEN_TTL_SECONDS: string;

  // Local dev storage. Set together in .dev.vars (see .dev.vars.example);
  // when MEDIA_S3_ENDPOINT is present the S3 backend is used instead of R2.
  // The endpoint is the host-published MinIO port because `wrangler dev` runs
  // in the host network namespace, not on the Docker bridge.
  MEDIA_S3_ENDPOINT?: string;
  MEDIA_S3_BUCKET?: string;
  MEDIA_S3_REGION?: string;
  MEDIA_S3_ACCESS_KEY_ID?: string;
  MEDIA_S3_SECRET_ACCESS_KEY?: string;
}

/**
 * The literal payload marker aws4fetch/boto3 use for a bodyless presigned
 * GET. Exported only so the comment survives; the signer owns this value.
 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** Object metadata worth forwarding. Everything else is recomputed. */
const FORWARDED_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Content-Range",
  "Accept-Ranges",
  "Last-Modified",
];

export interface StoredObject {
  /** Response body, or null for a HEAD request. */
  body: ReadableStream | null;
  /** Upstream status: 200, 206, or 304. */
  status: number;
  /** The object's own metadata headers (Content-Type, Content-Length, ...). */
  headers: Headers;
  /** ETag as sent upstream, already quoted. */
  etag: string;
}

export interface StorageBackend {
  /** Backend name for /healthz. Never includes credentials. */
  readonly name: string;
  get(key: string, request: Request): Promise<StoredObject | null>;
}

/** Storage was reachable-but-broken, as opposed to a valid-but-missing object. */
export class StorageUnavailable extends Error {}

/**
 * Path-style object URL. Each key segment is encoded individually so the `/`
 * separators survive, and `!'()*` are escaped because aws4fetch encodes paths
 * with a single pass that leaves them literal.
 */
export function objectUrl(endpoint: string, bucket: string, key: string): string {
  const encode = (s: string) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
    );
  return (
    endpoint.replace(/\/+$/, "") + "/" + encode(bucket) + "/" + key.split("/").map(encode).join("/")
  );
}

// ---------------------------------------------------------------------------
// S3 backend (local dev — MinIO)
// ---------------------------------------------------------------------------

export function createS3Backend(env: Env): StorageBackend {
  // Built once per Worker instance: the signer caches its derived keys.
  const client = new AwsClient({
    accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY!,
    service: "s3",
    region: env.MEDIA_S3_REGION ?? "auto",
  });

  return {
    name: "s3",
    async get(key: string, request: Request): Promise<StoredObject | null> {
      const url = objectUrl(env.MEDIA_S3_ENDPOINT!, env.MEDIA_S3_BUCKET!, key);

      // Header-based auth, not a presigned URL: the signature travels in the
      // Authorization header, so no signed URL is ever built, cannot leak into
      // a log line, and needs no expiry. `Range` is signed as part of the
      // canonical request, so it must be passed to the signer verbatim.
      const headers: Record<string, string> = {};
      const range = request.headers.get("Range");
      if (range) headers.Range = range;
      const ifNoneMatch = request.headers.get("If-None-Match");
      if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;

      let upstream: Response;
      try {
        upstream = await client.fetch(url, {
          method: "GET",
          headers,
          aws: { allHeaders: true },
        });
      } catch (err) {
        // Thrown rather than mapped to 404: the token was VALID and storage
        // was unreachable. Callers surface this as 502 so it can never be
        // mistaken for an auth failure.
        throw new StorageUnavailable(
          `S3 backend could not reach ${env.MEDIA_S3_ENDPOINT}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }

      if (upstream.status === 404) return null;

      if (upstream.status === 304) {
        return {
          body: null,
          status: 304,
          headers: new Headers(),
          etag: upstream.headers.get("ETag") ?? "",
        };
      }

      if (!upstream.ok) {
        throw new StorageUnavailable(
          `S3 backend returned ${upstream.status} for ${key}: ` +
            (await upstream.text()).slice(0, 200)
        );
      }

      const forwarded = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) forwarded.set(name, value);
      }

      return {
        body: request.method === "HEAD" ? null : upstream.body,
        status: upstream.status,
        headers: forwarded,
        etag: upstream.headers.get("ETag") ?? "",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// R2 backend (production)
// ---------------------------------------------------------------------------

export function createR2Backend(env: Env): StorageBackend {
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) {
    throw new Error("createR2Backend called without a MEDIA_BUCKET binding");
  }

  return {
    name: "r2",
    async get(key: string, request: Request): Promise<StoredObject | null> {
      // The binding honours Range natively, which is the whole reason the
      // production path uses a binding rather than an S3 fetch. Typed as
      // R2GetOptions rather than left to the overloaded `get` signature,
      // which has no overload accepting both Headers forms at once.
      const options: R2GetOptions = {
        range: request.headers.get("Range") ? request.headers : undefined,
        onlyIf: request.headers,
      };
      const object = await bucket.get(key, options);
      if (object === null) return null;

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (object.httpEtag) headers.set("ETag", object.httpEtag);

      return {
        body: request.method === "HEAD" ? null : object.body,
        status: object.range ? 206 : 200,
        headers,
        etag: object.httpEtag ?? "",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------

/** Throw if the token secret is missing, naming the file to fix. */
export function assertTokenSecret(env: Env): void {
  if (env.MEDIA_TOKEN_SECRET) return;
  // Without this, WebCrypto would sign with an EMPTY key and every token
  // would 403 with no diagnostic — indistinguishable from a Django bug.
  throw new Error(
    "MEDIA_TOKEN_SECRET is not set. Copy .dev.vars.example to .dev.vars (or run " +
      "scripts/run-hls-worker-local.sh, which generates it from .env.local)."
  );
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick a backend from env.
 *
 * Throws when no backend is fully configured. A Worker that silently served
 * nothing is indistinguishable from one whose auth always fails, which is the
 * most expensive failure mode to debug here.
 */
export function getStorage(env: Env): StorageBackend {
  assertTokenSecret(env);

  if (env.MEDIA_S3_ENDPOINT) {
    const missing = (
      [
        ["MEDIA_S3_BUCKET", env.MEDIA_S3_BUCKET],
        ["MEDIA_S3_ACCESS_KEY_ID", env.MEDIA_S3_ACCESS_KEY_ID],
        ["MEDIA_S3_SECRET_ACCESS_KEY", env.MEDIA_S3_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(
        `MEDIA_S3_ENDPOINT is set but ${missing.join(", ")} is missing — ` +
          `see workers/hls-token-worker/.dev.vars.example`
      );
    }
    return createS3Backend(env);
  }

  if (env.MEDIA_BUCKET) return createR2Backend(env);

  throw new Error(
    "No storage backend configured: set MEDIA_S3_ENDPOINT (plus MEDIA_S3_BUCKET, " +
      "MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY) for local MinIO, or bind " +
      "MEDIA_BUCKET for production R2."
  );
}
