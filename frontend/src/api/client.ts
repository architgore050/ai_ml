/// <reference types="vite/client" />

import {
  AuthTokens,
  Comment,
  CursorPaginated,
  FeedClip,
  FeedResponse,
  OwnProfile,
  PublicProfile,
  ShareEvent,
  User,
} from "../types/echoflow";

const STORAGE_KEY_ACCESS = "ef_access_token";
const STORAGE_KEY_REFRESH = "ef_refresh_token";
const STORAGE_KEY_USER = "ef_user";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:18000"
).replace(/\/+$/, "");

function apiUrl(endpoint: string): string {
  return endpoint.startsWith("http") ? endpoint : `${API_BASE_URL}${endpoint}`;
}

export function getStoredTokens(): AuthTokens | null {
  const access = sessionStorage.getItem(STORAGE_KEY_ACCESS);
  const refresh = sessionStorage.getItem(STORAGE_KEY_REFRESH);
  if (access && refresh) {
    return { access, refresh };
  }
  return null;
}

export function setStoredTokens(tokens: AuthTokens | null) {
  if (tokens) {
    sessionStorage.setItem(STORAGE_KEY_ACCESS, tokens.access);
    sessionStorage.setItem(STORAGE_KEY_REFRESH, tokens.refresh);
  } else {
    sessionStorage.removeItem(STORAGE_KEY_ACCESS);
    sessionStorage.removeItem(STORAGE_KEY_REFRESH);
  }
}

export function getStoredUser(): User | null {
  const raw = sessionStorage.getItem(STORAGE_KEY_USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setStoredUser(user: User | null) {
  if (user) {
    sessionStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  } else {
    sessionStorage.removeItem(STORAGE_KEY_USER);
  }
}

// Single-flight refresh token mutex
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens?.refresh) {
    return null;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch(apiUrl("/auth/token/refresh/"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: tokens.refresh }),
      });

      if (!res.ok) {
        setStoredTokens(null);
        setStoredUser(null);
        window.dispatchEvent(new CustomEvent("ef_session_expired"));
        return null;
      }

      const data = await res.json();
      const newTokens: AuthTokens = {
        access: data.access,
        refresh: data.refresh || tokens.refresh, // ROTATE_REFRESH_TOKENS
      };
      setStoredTokens(newTokens);
      return newTokens.access;
    } catch {
      setStoredTokens(null);
      setStoredUser(null);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export interface ApiRequestOptions extends RequestInit {
  skipAuth?: boolean;
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { skipAuth, headers: customHeaders, ...rest } = options;

  const headers = new Headers(customHeaders || {});
  const isFormData = rest.body instanceof FormData;

  if (!isFormData && !headers.has("Content-Type") && rest.method && rest.method !== "GET") {
    headers.set("Content-Type", "application/json");
  }

  let tokens = getStoredTokens();
  if (!skipAuth && tokens?.access) {
    headers.set("Authorization", `Bearer ${tokens.access}`);
  }

  let response = await fetch(apiUrl(endpoint), {
    ...rest,
    headers,
  });

  // Handle 401 with single-flight refresh rotation
  if (response.status === 401 && !skipAuth && tokens?.refresh) {
    const newAccess = await refreshAccessToken();
    if (newAccess) {
      headers.set("Authorization", `Bearer ${newAccess}`);
      response = await fetch(apiUrl(endpoint), {
        ...rest,
        headers,
      });
    }
  }

  if (response.status === 204) {
    return null as unknown as T;
  }

  let data: any = null;
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok && response.status !== 202) {
    const error: any = new Error(
      data?.detail ||
      data?.error ||
      (typeof data === "object" ? Object.values(data).flat().join(" ") : "Request failed")
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE API METHODS
// ---------------------------------------------------------------------------

export const authAPI = {
  async register(username: string, email: string, password: string): Promise<User> {
    const user = await apiRequest<User>("/auth/register/", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify({ username, email, password }),
    });
    return user;
  },

  async login(username: string, password: string): Promise<AuthTokens> {
    const tokens = await apiRequest<AuthTokens>("/auth/login/", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify({ username, password }),
    });
    setStoredTokens(tokens);
    return tokens;
  },

  async logout(): Promise<void> {
    const tokens = getStoredTokens();
    if (tokens?.refresh) {
      try {
        await apiRequest("/auth/logout/", {
          method: "POST",
          body: JSON.stringify({ refresh: tokens.refresh }),
        });
      } catch (err) {
        console.warn("Server logout notification failed:", err);
      }
    }
    setStoredTokens(null);
    setStoredUser(null);
  },
};

export const feedAPI = {
  async getFeed(): Promise<FeedResponse> {
    return apiRequest<FeedResponse>("/feed/");
  },

  async getSuggestions(category: string = "all"): Promise<CursorPaginated<FeedClip>> {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    return apiRequest<CursorPaginated<FeedClip>>(`/suggestions/${q}`);
  },

  async initializeTags(selected_tags: string[]): Promise<{ status: string }> {
    return apiRequest<{ status: string }>("/tags/initialize/", {
      method: "POST",
      body: JSON.stringify({ selected_tags }),
    });
  },
};

export const clipsAPI = {
  async uploadClip(formData: FormData): Promise<{ message: string; clip_id: string; status: string }> {
    return apiRequest<{ message: string; clip_id: string; status: string }>("/clips/", {
      method: "POST",
      body: formData,
    });
  },

  async updateClip(id: string, updates: { title?: string; category?: string }): Promise<FeedClip> {
    return apiRequest<FeedClip>(`/clips/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  },

  async deleteClip(id: string): Promise<void> {
    return apiRequest<void>(`/clips/${id}/`, {
      method: "DELETE",
    });
  },
};

export const interactionsAPI = {
  async toggleLike(clipId: string): Promise<{ status: "liked" | "unliked" }> {
    return apiRequest<{ status: "liked" | "unliked" }>(`/interactions/${clipId}/toggle-like/`, {
      method: "POST",
    });
  },

  async registerSkip(clipId: string, data: { listen_duration_ms: number; reel_position_ms: number; reel_id: string }): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`/interactions/${clipId}/register-skip/`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async logTelemetry(clipId: string, data: { action_type: "view" | "like" | "share" | "skip"; watch_time_ms: number }): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`/interactions/${clipId}/log-telemetry/`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
};

export const commentsAPI = {
  async getComments(clipId: string, parentId?: string | null): Promise<CursorPaginated<Comment>> {
    const params = new URLSearchParams();
    params.set("clip", clipId);
    if (parentId) {
      params.set("parent", parentId);
    }
    return apiRequest<CursorPaginated<Comment>>(`/comments/?${params.toString()}`);
  },

  async postComment(clip: string, text: string, parent?: string | null): Promise<Comment> {
    return apiRequest<Comment>("/comments/", {
      method: "POST",
      body: JSON.stringify({ clip, text, parent: parent || null }),
    });
  },

  async updateComment(id: string, text: string): Promise<Comment> {
    return apiRequest<Comment>(`/comments/${id}/`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    });
  },

  async deleteComment(id: string): Promise<void> {
    return apiRequest<void>(`/comments/${id}/`, {
      method: "DELETE",
    });
  },
};

export const shareAPI = {
  async findUser(username: string): Promise<{ id: number; username: string }> {
    return apiRequest<{ id: number; username: string }>(`/share/find-user/?username=${encodeURIComponent(username)}`);
  },

  async sendShare(clipId: string, receiverId: number): Promise<{ status: string }> {
    return apiRequest<{ status: string }>(`/share/${clipId}/send-share/`, {
      method: "POST",
      body: JSON.stringify({ receiver_id: receiverId }),
    });
  },

  async getInbox(): Promise<ShareEvent[]> {
    return apiRequest<ShareEvent[]>("/share/inbox/");
  },

  async getUnreadCount(): Promise<{ unread: number }> {
    return apiRequest<{ unread: number }>("/share/unread-count/");
  },

  // CRITICAL SPEC FIX: Method is POST per backend views/social.py:92-95
  async markRead(shareId: number): Promise<void> {
    return apiRequest<void>(`/share/${shareId}/mark-read/`, {
      method: "POST",
    });
  },

  async deleteShare(shareId: number): Promise<void> {
    return apiRequest<void>(`/share/${shareId}/share-delete/`, {
      method: "DELETE",
    });
  },
};

export const followAPI = {
  async toggleFollow(userId: number): Promise<{ status: "followed" | "unfollowed" }> {
    return apiRequest<{ status: "followed" | "unfollowed" }>(`/follow/${userId}/toggle-follow/`, {
      method: "POST",
    });
  },
};

export const profileAPI = {
  async getMyProfile(): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/profile/me/");
  },

  async updateMyProfile(formData: FormData): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/profile/me/update/", {
      method: "PATCH",
      body: formData,
    });
  },

  async getPublicProfile(userId: number): Promise<PublicProfile> {
    return apiRequest<PublicProfile>(`/profile/${userId}/`);
  },

  async getUserClips(userId: number): Promise<CursorPaginated<FeedClip>> {
    return apiRequest<CursorPaginated<FeedClip>>(`/profile/${userId}/clips/`);
  },
};
