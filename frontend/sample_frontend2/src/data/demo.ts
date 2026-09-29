import { DEMO_CREATORS, DEMO_ME } from './creators';
import { DEMO_CLIPS, DEMO_CLIPS_PAGE_2, DEMO_CLIPS_PAGE_3 } from './demoClips';
import { DEMO_MESSAGES, DEMO_ACTIVITY } from './demoInbox';

export { DEMO_CREATORS, DEMO_ME };
export { DEMO_CLIPS, DEMO_CLIPS_PAGE_2, DEMO_CLIPS_PAGE_3 };
export { DEMO_MESSAGES, DEMO_ACTIVITY };

export const VIBE_TAGS = ['Deep Focus', 'Comedy', 'Morning Calm', 'Chill', 'Energy', 'Sleep', 'Motivation'];

export const DISCOVERY_HUBS = [
  { id: 'trending', title: 'New & Trending', subtitle: 'Fresh drops from creators', color: '#ff6b35' },
  { id: 'chill', title: 'Chill Lounge', subtitle: 'Smooth ambient & lo-fi', color: '#00e5a0' },
  { id: 'laugh', title: 'Laugh Out Loud', subtitle: 'Comedy & stand-up', color: '#f59e0b' },
  { id: 'motivation', title: 'Daily Motivation', subtitle: 'Fuel your grind', color: '#8b5cf6' },
  { id: 'science', title: 'Science Bytes', subtitle: 'Bite-sized learning', color: '#60a5fa' },
];

export const DEMO_MODE = import.meta.env?.VITE_DEMO_MODE === 'true' || false;
