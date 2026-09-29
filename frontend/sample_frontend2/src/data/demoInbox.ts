import { ShareEvent } from '../types';
import { DEMO_CLIPS } from './demoClips';

export const DEMO_MESSAGES: ShareEvent[] = [
  {
    id: 1,
    sender_name: 'ClaraVox',
    clip: DEMO_CLIPS[6],
    clip_title: 'Why WiFi Always Dies During Meetings',
    clip_hls_url: '/media/hls/demo-7/master.m3u8',
    created_at: '2024-08-19T09:00:00Z',
    is_read: false,
  },
  {
    id: 2,
    sender_name: 'RohanK',
    clip: DEMO_CLIPS[4],
    clip_title: 'Monday Morning Pep Talk (No One Asked For)',
    clip_hls_url: '/media/hls/demo-5/master.m3u8',
    created_at: '2024-08-19T07:35:00Z',
    is_read: false,
  },
  {
    id: 3,
    sender_name: 'TheSoundCollective',
    clip: DEMO_CLIPS[8],
    clip_title: 'Late Night Vibes: Piano for Overthinkers',
    clip_hls_url: '/media/hls/demo-9/master.m3u8',
    created_at: '2024-08-18T23:50:00Z',
    is_read: true,
  },
  {
    id: 4,
    sender_name: 'CosmicVoyager',
    clip: DEMO_CLIPS[5],
    clip_title: '5-Minute Deep Breathing',
    clip_hls_url: '/media/hls/demo-6/master.m3u8',
    created_at: '2024-08-18T06:00:00Z',
    is_read: true,
  },
];

export const DEMO_ACTIVITY = [
  { id: 'a1', type: 'like', actor: 'ClaraVox', target: 'your Echo "Cosmic Drifter"', time: '2m ago', read: false },
  { id: 'a2', type: 'follow', actor: 'RohanK', target: 'started following you', time: '1h ago', read: false },
  { id: 'a3', type: 'share', actor: 'EchoLabs', target: 'shared your Echo "Quantum Podcast"', time: '3h ago', read: true },
  { id: 'a4', type: 'comment', actor: 'CosmicVoyager', target: 'replied to your comment on "Neon Horizon"', time: 'Yesterday', read: true },
  { id: 'a5', type: 'like', actor: 'TheSoundCollective', target: 'liked your Echo "Memory Palace"', time: 'Yesterday', read: true },
  { id: 'a6', type: 'follow', actor: 'NovaBeats', target: 'started following you', time: '2 days ago', read: true },
];
