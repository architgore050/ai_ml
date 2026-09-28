// Tests for the storage backends.
//
// Signer correctness is NOT asserted here. The signing is delegated to
// aws4fetch precisely because a self-consistent hand-rolled signer passes
// every test written against itself and still 403s in production — that
// happened twice while this was being built. What is asserted here is the
// glue: URL construction, backend selection, and the fail-loud config
// validation.
//
// The authoritative check for the signing path is live: a real MinIO in the
// local Docker stack must return 200 for a token-bearing request and 403
// without one. That sequence is in
// docs/EXPLAIN/storage/05-local-hls-worker-runbook.md.

import { describe, it, expect } from "vitest";
import {
  objectUrl,
  getStorage,
  assertTokenSecret,
  StorageUnavailable,
} from "./storage";
import type { Env } from "./storage";

const S3_ENV = {
  MEDIA_TOKEN_SECRET: "change-me-to-a-long-random-string",
  MEDIA_TOKEN_TTL_SECONDS: "600",
  MEDIA_S3_ENDPOINT: "http://127.0.0.1:19000",
  MEDIA_S3_BUCKET: "echoflow-media",
  MEDIA_S3_ACCESS_KEY_ID: "echoflow-dev",
  MEDIA_S3_SECRET_ACCESS_KEY: "echoflow-dev-secret",
} as unknown as Env;

// ---------------------------------------------------------------------------
// objectUrl
// ---------------------------------------------------------------------------

describe("objectUrl", () => {
  it("builds a path-style URL with the bucket as a path segment", () => {
    expect(objectUrl("http://127.0.0.1:19000", "echoflow-media", "hls/abc/master.m3u8")).toBe(
      "http://127.0.0.1:19000/echoflow-media/hls/abc/master.m3u8"
    );
  });

  it("strips a trailing slash from the endpoint", () => {
    expect(objectUrl("http://127.0.0.1:19000/", "b", "k")).toBe(
      "http://127.0.0.1:19000/b/k"
    );
  });

  it("keeps key separators but escapes the characters SigV4 requires escaped", () => {
    // encodeURIComponent leaves !'()* literal; the signer does not.
    expect(objectUrl("http://h:9000", "b", "hls/a b/c+d/e!f'g(h)i*j")).toBe(
      "http://h:9000/b/hls/a%20b/c%2Bd/e%21f%27g%28h%29i%2Aj"
    );
  });

  it("escapes the bucket name too", () => {
    expect(objectUrl("http://h:9000", "my bucket", "k")).toBe("http://h:9000/my%20bucket/k");
  });
});

// ---------------------------------------------------------------------------
// assertTokenSecret
// ---------------------------------------------------------------------------

describe("assertTokenSecret", () => {
  it("passes when the secret is present", () => {
    expect(() => assertTokenSecret(S3_ENV)).not.toThrow();
  });

  it("throws, naming the file, when the secret is missing", () => {
    const env = { ...S3_ENV, MEDIA_TOKEN_SECRET: "" } as unknown as Env;
    expect(() => assertTokenSecret(env)).toThrow(/MEDIA_TOKEN_SECRET is not set/);
    expect(() => assertTokenSecret(env)).toThrow(/\.dev\.vars/);
  });

  it("throws on an undefined secret rather than signing with an empty key", () => {
    const env = { ...S3_ENV, MEDIA_TOKEN_SECRET: undefined } as unknown as Env;
    expect(() => assertTokenSecret(env)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getStorage
// ---------------------------------------------------------------------------

describe("getStorage", () => {
  it("selects the S3 backend when MEDIA_S3_ENDPOINT is set", () => {
    expect(getStorage(S3_ENV).name).toBe("s3");
  });

  it("selects the R2 backend when only the binding is present", () => {
    const env = { MEDIA_TOKEN_SECRET: "s", MEDIA_TOKEN_TTL_SECONDS: "600" } as unknown as Env;
    (env as { MEDIA_BUCKET?: unknown }).MEDIA_BUCKET = {};
    expect(getStorage(env).name).toBe("r2");
  });

  it("prefers S3 when both are available", () => {
    const env = { ...S3_ENV, MEDIA_BUCKET: {} } as unknown as Env;
    expect(getStorage(env).name).toBe("s3");
  });

  it("throws, naming the missing var, when S3 is half-configured", () => {
    const env = { ...S3_ENV, MEDIA_S3_SECRET_ACCESS_KEY: "" } as unknown as Env;
    expect(() => getStorage(env)).toThrow(/MEDIA_S3_SECRET_ACCESS_KEY/);
  });

  it("throws when nothing is configured at all", () => {
    const env = { MEDIA_TOKEN_SECRET: "s", MEDIA_TOKEN_TTL_SECONDS: "600" } as unknown as Env;
    expect(() => getStorage(env)).toThrow(/No storage backend configured/);
  });

  it("reports a missing token secret before a missing backend", () => {
    // The secret is the more confusing failure, so it wins the error message.
    const env = { MEDIA_TOKEN_SECRET: "", MEDIA_TOKEN_TTL_SECONDS: "600" } as unknown as Env;
    expect(() => getStorage(env)).toThrow(/MEDIA_TOKEN_SECRET/);
  });
});

// ---------------------------------------------------------------------------
// StorageUnavailable
// ---------------------------------------------------------------------------

describe("StorageUnavailable", () => {
  it("exists as a distinct type so index.ts can map it to 502 rather than 403", () => {
    const err = new StorageUnavailable("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("boom");
  });
});
