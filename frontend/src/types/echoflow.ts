export interface FeedClip {
  id: string;
  title: string;
  creator_name: string;
  creator_id: number;
  category: string;
  hls_playlist_url: string | null;
  likes: number;
  shares: number;
  skips: number;
  comment_count: number;
  is_liked: boolean;
  // Added in commit 21846fe. Before this existed, ReelCard initialised its
  // follow state to a hardcoded `false`, so a creator you already followed
  // rendered "Follow" and tapping it called the *toggle* endpoint — silently
  // unfollowing them. The backend field shipped with no consumer; this is the
  // consumer.
  is_following: boolean;
  // Present in FeedClipSerializer (backend/app/serializers.py fields list) but
  // previously missing here, so every read of them type-checked against an
  // incomplete type. `duration_ms` is milliseconds, not seconds.
  duration_ms: number;
  tags: string[];
  cover_image: string | null;
}

export interface User {
  id: number;
  username: string;
  email?: string;
}

export interface OwnProfile {
  id: number;
  username: string;
  email: string;
  profile_picture: string | null;
  followers_count: number;
  following_count: number;
  uploads_count: number;
  liked_clips: FeedClip[];
  date_joined: string;
}

export interface PublicProfile {
  id: number;
  username: string;
  profile_picture: string | null;
  followers_count: number;
  following_count: number;
  uploads_count: number;
  date_joined: string;
}

export interface Comment {
  id: string;
  clip: string;
  author_username: string;
  parent: string | null;
  text: string;
  reply_count: number;
  created_at: string;
}

export interface ShareEvent {
  id: number;
  sender_name: string;
  clip: FeedClip;
  clip_title: string;
  clip_hls_url: string;
  created_at: string;
  is_read: boolean;
}

export interface FeedResponse {
  next?: string;
  queue_health?: number;
  results: FeedClip[];
  message?: string;
  retry_after_ms?: number;
  degraded?: boolean;
}

export interface CursorPaginated<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface AuthTokens {
  access: string;
  refresh: string;
}
