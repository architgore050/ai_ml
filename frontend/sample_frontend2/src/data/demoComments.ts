import { Comment } from '../types';

export const DEMO_COMMENTS: Record<string, Comment[]> = {
  'demo-1': [
    { id: 'c1', clip: 'demo-1', author_username: 'ClaraVox', parent: null, text: 'This is exactly what I needed for writing tonight. Thank you.', likes: 42, reply_count: 3, created_at: '2024-08-19T10:00:00Z' },
    { id: 'c2', clip: 'demo-1', author_username: 'RohanK', parent: null, text: 'The vinyl crackle detail is chef\'s kiss.', likes: 18, reply_count: 0, created_at: '2024-08-19T08:30:00Z' },
    { id: 'c3', clip: 'demo-1', author_username: 'CosmicVoyager', parent: 'c1', text: 'Glad it helped! I have more like this coming.', likes: 8, reply_count: 0, created_at: '2024-08-19T10:30:00Z' },
    { id: 'c4', clip: 'demo-1', author_username: 'EchoLabs', parent: null, text: 'The acoustic embedding on this clip is fascinating. Very balanced spectrum.', likes: 12, reply_count: 1, created_at: '2024-08-18T16:00:00Z' },
    { id: 'c5', clip: 'demo-1', author_username: 'NovaBeats', parent: 'c4', text: 'Thanks for the analysis! I mixed this on my old Tascam.', likes: 5, reply_count: 0, created_at: '2024-08-18T18:45:00Z' },
  ],
  'demo-2': [
    { id: 'c6', clip: 'demo-2', author_username: 'TheSoundCollective', parent: null, text: 'That transition at 1:05 gave me chills. Beautiful.' , likes: 24, reply_count: 0, created_at: '2024-08-18T11:00:00Z' },
    { id: 'c7', clip: 'demo-2', author_username: 'RohanK', parent: null, text: 'The bassline is carrying me through this meeting.', likes: 9, reply_count: 2, created_at: '2024-08-17T10:00:00Z' },
  ],
  'demo-7': [
    { id: 'c8', clip: 'demo-7', author_username: 'RohanK', parent: null, text: 'OMG this is so relatable. The amount of times I\'ve lost work to WiFi drops...', likes: 180, reply_count: 12, created_at: '2024-08-19T00:00:00Z' },
    { id: 'c9', clip: 'demo-7', author_username: 'NovaBeats', parent: null, text: 'The bit about Bluetooth headphones is TRUTH.', likes: 95, reply_count: 3, created_at: '2024-08-19T01:00:00Z' },
    { id: 'c10', clip: 'demo-7', author_username: 'CosmicVoyager', parent: null, text: 'I literally rewatch this every Monday morning.', likes: 210, reply_count: 5, created_at: '2024-08-19T08:00:00Z' },
  ],
};

export function getDemoComments(clipId: string): Comment[] {
  return DEMO_COMMENTS[clipId] || [];
}
