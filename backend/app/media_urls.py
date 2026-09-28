"""
Playback URL generation for the browser.

WHY THIS FILE EXISTS — TWO SEPARATE PROBLEMS SOLVED HERE:

1. ENDPOINT MISMATCH. django-storages' `default_storage.url()` reuses the
   SAME boto3 client the app uses to talk to the bucket internally — which
   bakes the bucket's INTERNAL endpoint into any URL it returns (e.g.
   `http://minio:9000`, a hostname that only resolves inside the Docker
   network). A browser on the host has no DNS entry for it at all.

2. HLS IS A MULTI-FILE PROTOCOL, SIGNED URLS ARE SINGLE-FILE. A signed URL's
   signature lives in its query string. `master.m3u8` references variant
   playlists via RELATIVE paths, and those reference segment files the same
   way — and per RFC 3986, resolving a relative reference against a base URL
   does NOT carry the base URL's query string forward. So even a correctly
   signed `master.m3u8` succeeds while every file it points to gets
   requested with no signature at all, which a private bucket correctly
   rejects with 403. One signed URL cannot authorize a stream made of dozens
   of objects — this isn't a MinIO quirk, it's true against real S3 too.

   The fix used by every real HLS-over-object-storage deployment is an edge
   that does signed-COOKIE auth over a whole path prefix, instead of one
   object at a time. That is `backend.app.services.hls_token` on the Django
   side and the Cloudflare Worker (or nginx, locally) on the other: a
   short-lived HMAC cookie is issued per clip and validated on every /hls/*
   request, so a single authorization covers a stream made of dozens of
   objects.

   The ORIGINAL uploaded file — the one thing actually worth protecting — is a
   different matter and stays behind a real presigned URL; that is what
   get_signed_media_url() is for, kept separate and unused by anything
   HLS-related on purpose.

   HLS TOKEN PROTECTION: the `hls/` prefix is NOT public-read. Nothing runs
   `mc anonymous set download` on it any more — `minio-init` only creates the
   bucket and leaves the policy private. (An earlier version of this comment
   claimed otherwise, and `docker/nginx.conf`'s commented-out :9443 block
   still does; both are stale.)

   The URL handed to the browser is the EDGE origin, and it is bucket-less —
   an edge in front of the bucket (an R2 custom domain, or the Worker) does
   not expose the bucket as a path segment, so `{endpoint}/{bucket}/hls/...`
   would 404 there. That is not a local-only concern: the Worker rejects
   anything whose path does not start with `/hls/`, so the bucket-prefixed
   form is wrong in production too.

    This is why the edge origin is a separate setting,
    `PUBLIC_HLS_ENDPOINT_URL`, rather than reusing
    `PUBLIC_MEDIA_ENDPOINT_URL`: presigned `uploads/` URLs still need the
    bucket in the path and the edge serves nothing but /hls/*, so collapsing
    the two would break uploads. `HLS_URL_STYLE` picks between the
    bucket-prefixed and bucket-less forms. See
    `docs/EXPLAIN/storage/04-hls-token-protection.md` for the full design.
"""
import boto3
from django.conf import settings


def get_hls_playback_url(object_key):
    """Return a browser-playable URL for HLS content (master.m3u8 or
    anything under the same `hls/` prefix). Not signed, on purpose — see
    module docstring for why signing a multi-file HLS stream doesn't work
    and why the token cookie exists instead.

    Honors `HLS_URL_STYLE`:
      "edge"   -> {PUBLIC_HLS_ENDPOINT_URL}/{key}            (bucket-less)
      "bucket" -> {PUBLIC_MEDIA_ENDPOINT_URL}/{bucket}/{key} (path-style)

    Returns None if object_key is falsy.
    """
    if not object_key:
        return None

    if settings.HLS_URL_STYLE == "edge":
        endpoint = (settings.PUBLIC_HLS_ENDPOINT_URL or "").rstrip("/")
        return f"{endpoint}/{object_key}"

    bucket = settings.STORAGES["default"]["OPTIONS"]["bucket_name"]
    endpoint = (settings.PUBLIC_MEDIA_ENDPOINT_URL or "").rstrip("/")
    # addressing_style is "path" (see STORAGES config) — the bucket is a path
    # segment, not a subdomain, which is what MinIO and most non-AWS
    # S3-compatible endpoints require.
    return f"{endpoint}/{bucket}/{object_key}"


def get_signed_media_url(object_key):
    """Return a browser-playable, time-limited SIGNED url for a genuinely
    PRIVATE object (e.g. an original upload under `uploads/`). Do not use
    this for HLS content — see get_hls_playback_url() and the module
    docstring for why per-object signing doesn't work for a multi-file
    stream.

    Returns None if object_key is falsy.
    """
    if not object_key:
        return None

    client = boto3.client(
        "s3",
        endpoint_url=settings.PUBLIC_MEDIA_ENDPOINT_URL,
        aws_access_key_id=settings.STORAGES["default"]["OPTIONS"]["access_key"],
        aws_secret_access_key=settings.STORAGES["default"]["OPTIONS"]["secret_key"],
        region_name=settings.STORAGES["default"]["OPTIONS"]["region_name"],
        config=boto3.session.Config(
            s3={"addressing_style": settings.STORAGES["default"]["OPTIONS"]["addressing_style"]},
            signature_version="s3v4",
        ),
    )
    return client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.STORAGES["default"]["OPTIONS"]["bucket_name"],
            "Key": object_key,
        },
        ExpiresIn=settings.STORAGES["default"]["OPTIONS"]["querystring_expire"],
    )