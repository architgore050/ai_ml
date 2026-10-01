import { API_BASE_URL, ApiError, apiFetch, getTokenStore } from '../client';
import { z } from 'zod';

export type UploadAsset = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number | null;
  durationMs?: number | null;
};

export type UploadInput = {
  title: string;
  category: string;
  licenseType: 'Owned' | 'CC0' | 'CC-BY' | 'CC-BY-SA' | 'CC-BY-NC' | 'Public_Domain' | 'Unknown';
  copyrightOwnerName?: string;
  asset: UploadAsset;
};

export type UploadResult = { clipId: string; status: string };
export type CancellableUpload = { promise: Promise<UploadResult>; cancel: () => void };

const clipStatusSchema = z.object({ id: z.string(), status: z.string() });

/** Owner-scoped status used while the media worker produces the HLS rendition. */
export async function getClipStatus(clipId: string): Promise<{ id: string; status: string }> {
  return clipStatusSchema.parse(await apiFetch(`/clips/${clipId}/`));
}

const moderationResultSchema = z.object({ status: z.string(), clip_id: z.string() });

/** Starts the owner-authorized moderation and HLS processing workflow. */
export async function approveClipModeration(clipId: string): Promise<{ status: string; clipId: string }> {
  const result = moderationResultSchema.parse(await apiFetch(`/clips/${clipId}/approve-moderation/`, { method: 'POST' }));
  return { status: result.status, clipId: result.clip_id };
}

/**
 * Native fetch exposes neither byte progress nor a reliable cancellation state.
 * Uploads are user-created, potentially large work, so XHR is used only here.
 */
export function uploadClip(input: UploadInput, onProgress: (fraction: number) => void): CancellableUpload {
  const request = new XMLHttpRequest();
  let settled = false;
  const promise = new Promise<UploadResult>(async (resolve, reject) => {
    try {
      const access = await getTokenStore().getAccess();
      const form = new FormData();
      form.append('title', input.title.trim());
      form.append('category', input.category);
      form.append('license_type', input.licenseType);
      form.append('copyright_owner_name', input.copyrightOwnerName?.trim() ?? '');
      form.append('copyright_acknowledgement', 'true');
      form.append('original_file', {
        uri: input.asset.uri,
        name: input.asset.name,
        type: input.asset.mimeType,
      } as unknown as Blob);

      request.open('POST', `${API_BASE_URL}/clips/`);
      request.setRequestHeader('Accept', 'application/json');
      if (access) request.setRequestHeader('Authorization', `Bearer ${access}`);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.max(0, Math.min(1, event.loaded / event.total)));
      };
      request.onerror = () => {
        if (!settled) reject(new ApiError({ status: 0, body: null, message: 'Upload failed', isNetwork: true }));
      };
      request.onabort = () => {
        if (!settled) reject(new DOMException('Upload cancelled', 'AbortError'));
      };
      request.onload = () => {
        settled = true;
        let body: unknown = null;
        try { body = request.responseText ? JSON.parse(request.responseText) : null; } catch { body = request.responseText; }
        if (request.status < 200 || request.status >= 300) {
          reject(new ApiError({ status: request.status, body }));
          return;
        }
        const value = body as { clip_id?: unknown; status?: unknown };
        if (typeof value.clip_id !== 'string' || typeof value.status !== 'string') {
          reject(new Error('Upload response was missing clip status.'));
          return;
        }
        resolve({ clipId: value.clip_id, status: value.status });
      };
      request.send(form);
    } catch (cause) {
      reject(cause);
    }
  });
  return { promise, cancel: () => { if (!settled) request.abort(); } };
}
