import { AudioClip } from '../types';
import { DEMO_CREATORS } from './creators';

export const CAT_COLORS: Record<string, string> = {
  instrumental: '#00e5a0',
  funny: '#f59e0b',
  news: '#60a5fa',
  science: '#8b5cf6',
  music: '#ff6b35',
};

export const CATEGORIES = ['instrumental', 'funny', 'news', 'science', 'music'];

export function getCatColor(category: string): string {
  return CAT_COLORS[category] || '#ff6b35';
}

function makeClip(id: string, overrides: Partial<AudioClip>): AudioClip {
  const creator = overrides.creator ?? DEMO_CREATORS[0];
  return {
    id,
    title: overrides.title ?? 'Untitled',
    description: overrides.description ?? '',
    category: overrides.category ?? 'music',
    creator,
    creator_name: overrides.creator_name ?? creator.username,
    creator_id: overrides.creator_id ?? creator.id,
    hls_playlist_url: overrides.hls_playlist_url ?? '/demo/audio/tone.mp3',
    duration_ms: overrides.duration_ms ?? 120000,
    likes: overrides.likes ?? 0,
    shares: overrides.shares ?? 0,
    skips: overrides.skips ?? 0,
    comment_count: overrides.comment_count ?? 0,
    is_liked: overrides.is_liked ?? false,
    tags: overrides.tags ?? [],
    status: 'ready',
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

export { makeClip };
