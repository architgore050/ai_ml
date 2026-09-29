export interface User {
  id: number;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  profile_picture?: string | null;
  profile_picture_url?: string | null;
  date_joined?: string;
  followers_count?: number;
  following_count?: number;
  uploads_count?: number;
}

export interface AuthTokens {
  access: string;
  refresh: string;
}

export interface AudioClip {
  id: string;
  title: string;
  category: string;
  creator: User;
  creator_name: string;
  creator_id?: number;
  hls_playlist_url: string | null;
  cover_image?: string | null;
  duration_ms: number;
  likes: number;
  shares: number;
  skips: number;
  comment_count: number;
  is_liked: boolean;
  tags: string[];
  status: 'processing' | 'ready' | 'failed';
  created_at?: string;
  description?: string;
  source_name?: string | null;
  source_url?: string | null;
  license?: string | null;
}

export interface FeedResponse {
  results: AudioClip[];
  next?: string | null;
  queue_health?: number;
  message?: string;
}

export interface Comment {
  id: string;
  clip: string;
  author_username: string;
  parent: string | null;
  text: string;
  likes: number;
  reply_count: number;
  created_at: string;
}

export interface ShareEvent {
  id: number;
  sender_name: string;
  clip: AudioClip;
  clip_title: string;
  clip_hls_url: string | null;
  created_at: string;
  is_read: boolean;
}

export interface UserProfile {
  id: number;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  profile_picture?: string | null;
  profile_picture_url?: string | null;
  followers_count: number;
  following_count: number;
  uploads_count: number;
  date_joined?: string;
  liked_clips?: AudioClip[];
  bio?: string;
}

export type ThemeMode = 'dark' | 'light' | 'system';

export interface ToastHandler {
  (msg: string, type?: 'success' | 'error' | 'info' | 'warn', ms?: number): void;
}

export interface PlayerState {
  active: AudioClip | null;
  playing: boolean;
  progress: number;
  duration: number;
  buffered: number;
  isBuffering: boolean;
  error: string | null;
  play: (clip: AudioClip) => void;
  pause: () => void;
  seek: (fraction: number) => void;
  skipForward: (seconds?: number) => void;
  skipBackward: (seconds?: number) => void;
  listenMs: () => number;
  destroy: () => void;
  loadHLSIfNeeded: (src: string) => void;
}
