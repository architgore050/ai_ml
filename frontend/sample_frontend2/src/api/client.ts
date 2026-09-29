import { AudioClip, FeedResponse, Comment, ShareEvent, UserProfile } from '../types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://localhost';

// --- Token management ---
export function setTokens(tokens: { access: string; refresh: string }) {
  sessionStorage.setItem('ef_access', tokens.access);
  sessionStorage.setItem('ef_refresh', tokens.refresh);
}

export function clearTokens() {
  sessionStorage.removeItem('ef_access');
  sessionStorage.removeItem('ef_refresh');
  sessionStorage.removeItem('ef_user');
}

export function getAccessToken(): string | null {
  return sessionStorage.getItem('ef_access');
}

export function getRefreshToken(): string | null {
  return sessionStorage.getItem('ef_refresh');
}

// --- Event-based session expiry ---
export function dispatchSessionExpired() {
  window.dispatchEvent(new CustomEvent('ef_session_expired'));
}

// --- Core API ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const accessToken = getAccessToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers as Record<string, string> || {}) };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  if (opts.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  } catch {
    throw { status: 0, message: 'Network error — is the backend running?' };
  }

  if (res.status === 401) {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        const r = await fetch(`${API_BASE}/auth/token/refresh/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh: refreshToken }),
        });
        if (r.ok) {
          const d = await r.json();
          setTokens({ access: d.access, refresh: d.refresh || refreshToken });
          headers['Authorization'] = `Bearer ${d.access}`;
          res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
        } else {
          clearTokens();
          dispatchSessionExpired();
          throw { status: 401, message: 'Session expired — please sign in again' };
        }
      } catch {
        clearTokens();
        dispatchSessionExpired();
        throw { status: 401, message: 'Session expired — please sign in again' };
      }
    } else {
      clearTokens();
      dispatchSessionExpired();
      throw { status: 401, message: 'Session expired — please sign in again' };
    }
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw { status: res.status, message: data.detail || data.error || 'Request failed', errors: data };
  }
  return data;
}

// --- Auth ---
export const authAPI = {
  login: (username: string, password: string) =>
    api('/auth/login/', { method: 'POST', body: JSON.stringify({ username, password }) }),
  // SECURITY / DPDP §6: consent_accepted and terms_version are REQUIRED by
  // RegisterSerializer (serializers.py:435-436). Omitting them returns 400,
  // so registration was entirely non-functional until this was fixed
  // (ISSUE-16). `dob` is omitted here because it stays optional for now —
  // see the age-gate item, which is tracked separately.
  //
  // termsVersion is read from GET /legal/compliance/ (A1) rather than
  // hardcoded, so adding a version to TERMS_VERSIONS does not silently
  // break every client.
  register: (email: string, username: string, password: string, termsVersion: string) =>
    api('/auth/register/', {
      method: 'POST',
      body: JSON.stringify({
        email, username, password,
        consent_accepted: true,
        terms_version: termsVersion,
      }),
    }),
  getCompliance: () =>
    api('/legal/compliance/') as Promise<{
      terms_versions: string[];
      current_terms_version: string;
      privacy_version: string;
      physical_address: string;
    }>,
  refresh: (refresh: string) =>
    api('/auth/token/refresh/', { method: 'POST', body: JSON.stringify({ refresh }) }),
};

// --- Feed ---
export const feedAPI = {
  getFeed: async (): Promise<{ status: number; degraded?: boolean; retry_after_ms?: number; message?: string; results?: AudioClip[]; next?: string | null; queue_health?: number }> => {
    const res = await fetch(API_BASE + '/feed/', {
      headers: { 'Authorization': 'Bearer ' + (getAccessToken() || ''), 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  },
  getSuggestions: (category: string): Promise<FeedResponse | AudioClip[]> =>
    api(`/suggestions/?category=${encodeURIComponent(category)}`),
};

// --- Clips ---
export const clipsAPI = {
  uploadClip: (fd: FormData) => api('/clips/', { method: 'POST', body: fd }),
  getUserClips: (userId: number): Promise<FeedResponse> => api(`/profile/${userId}/clips/`),
};

// --- Interactions ---
export const interactionsAPI = {
  toggleLike: (clipId: string) =>
    api(`/interactions/${clipId}/toggle-like/`, { method: 'POST' }),
  registerSkip: (clipId: string, data: { listen_duration_ms: number; reel_position_ms: number; reel_id: string }) =>
    api(`/interactions/${clipId}/register-skip/`, { method: 'POST', body: JSON.stringify(data) }),
  logTelemetry: (clipId: string, data: { action_type: 'view' | 'like' | 'share' | 'skip'; watch_time_ms: number }) =>
    api(`/interactions/${clipId}/log-telemetry/`, { method: 'POST', body: JSON.stringify(data) }),
};

// --- Comments ---
export const commentsAPI = {
  getComments: (clipId: string): Promise<{ results: Comment[] }> => api(`/comments/?clip=${clipId}`),
  postComment: (data: { clip: string; text: string; parent?: string }) =>
    api('/comments/', { method: 'POST', body: JSON.stringify(data) }),
  patchComment: (commentId: string, data: { text: string }) => api(`/comments/${commentId}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteComment: (commentId: string) => api(`/comments/${commentId}/`, { method: 'DELETE' }),
};

// --- Share ---
export const shareAPI = {
  getInbox: (): Promise<ShareEvent[]> => api('/share/inbox/'),
  getUnread: () => api('/share/unread-count/'),
  findUser: (username: string) => api(`/share/find-user/?username=${encodeURIComponent(username)}`),
  sendShare: (clipId: string, receiverId: number) =>
    api(`/share/${clipId}/send-share/`, { method: 'POST', body: JSON.stringify({ receiver_id: receiverId }) }),
  markRead: (id: number) => api(`/share/${id}/mark-read/`, { method: 'PATCH' }),
  deleteShare: (id: number) => api(`/share/${id}/share-delete/`, { method: 'DELETE' }),
};

// --- Follow ---
export const followAPI = {
  toggleFollow: (userId: number) => api(`/follow/${userId}/toggle-follow/`, { method: 'POST' }),
};

// --- Profile ---
export const profileAPI = {
  getMyProfile: (): Promise<UserProfile> => api('/profile/me/'),
  getProfile: (userId: number): Promise<UserProfile> => api(`/profile/${userId}/`),
  updateProfile: (fd: FormData) => api('/profile/me/update/', { method: 'PATCH', body: fd }),
};

// --- Media ---
// SECURITY: The ef_hls_token cookie is HttpOnly — JavaScript cannot read it.
// The browser auto-sends it on all /hls/* requests to the media endpoint.
export const mediaAPI = {
  // SECURITY: POST, not GET. Minting a playback credential must not be a
  // safe method — a GET is CSRF-able (the ef_hls_token cookie is
  // SameSite=Lax), prefetchable by browsers/proxies, and cacheable by
  // intermediaries, any of which would mint tokens nobody asked for.
  getPlaybackToken: (clipId: string): Promise<{ status: string }> =>
    fetch(`${API_BASE}/media/playback-token/${clipId}/`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (getAccessToken() || '') },
      credentials: 'include',  // Required for Set-Cookie to set the token
    }).then(res => {
      if (!res.ok) throw { status: res.status, message: 'Token issuance failed' };
      return res.json();
    }),
};

// --- Tags ---
export const tagsAPI = {
  initialize: (tags: string[]) => api('/tags/initialize/', { method: 'POST', body: JSON.stringify({ selected_tags: tags }) }),
};

export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${API_BASE}${url}`;
}
