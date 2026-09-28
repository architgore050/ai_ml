import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";

const app = express();
const PORT = 18001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const upload = multer({
  // The demo server must never become a second durable media store.
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// Helper to generate realistic PCM WAV audio buffers
function generateAudioWav(toneType: string, durationSec: number = 20): Buffer {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF identifier
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  // fmt subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // SubChunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(2, 32); // BlockAlign (NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(16, 34); // BitsPerSample
  // data subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Synthesize musical / voice-like patterns
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    if (toneType === "comedy") {
      // Funky walking bass + comedy accent
      const bassFreq = 65 + (Math.floor(t * 2) % 4) * 20;
      const kick = Math.exp(-((t % 0.5) * 20)) * Math.sin(2 * Math.PI * 60 * t);
      const bass = 0.4 * Math.sin(2 * Math.PI * bassFreq * t);
      const chord = 0.15 * Math.sin(2 * Math.PI * (bassFreq * 1.5) * t) * (t % 1 < 0.3 ? 1 : 0);
      sample = kick + bass + chord;
    } else if (toneType === "science") {
      // Cosmic atmospheric chime + ambient harmonics
      const note = [440, 554.37, 659.25, 880][Math.floor(t * 1.5) % 4];
      const env = Math.exp(-((t % 0.67) * 3));
      const chime = 0.35 * Math.sin(2 * Math.PI * note * t) * env;
      const drone = 0.2 * Math.sin(2 * Math.PI * 110 * t) + 0.1 * Math.sin(2 * Math.PI * 165 * t);
      sample = chime + drone;
    } else if (toneType === "motivation") {
      // Uplifting warm cinematic chord progression + pulse
      const rootFreq = [130.81, 164.81, 196.0, 220.0][Math.floor(t * 0.5) % 4];
      const pad = 0.3 * Math.sin(2 * Math.PI * rootFreq * t) + 0.2 * Math.sin(2 * Math.PI * rootFreq * 1.25 * t);
      const pulse = 0.25 * Math.sin(2 * Math.PI * 80 * t) * Math.sin(2 * Math.PI * 2 * t);
      sample = pad + pulse;
    } else if (toneType === "music") {
      // Lo-fi hip-hop beat + smooth rhodes chords
      const chordFreq = [261.63, 329.63, 392.0, 523.25][Math.floor(t * 0.75) % 4];
      const beat = Math.exp(-((t % 0.5) * 15)) * Math.sin(2 * Math.PI * 75 * t);
      const rhodes = 0.3 * Math.sin(2 * Math.PI * chordFreq * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
      sample = beat + rhodes;
    } else if (toneType === "quotes") {
      // Meditative Tibetan singing bowl + alpha wave
      const bowl = 0.4 * Math.sin(2 * Math.PI * 216 * t) * Math.exp(-((t % 3) * 0.8));
      const alpha = 0.15 * Math.sin(2 * Math.PI * 108 * t) + 0.1 * Math.sin(2 * Math.PI * 118 * t);
      sample = bowl + alpha;
    } else {
      // Default energetic instrumental
      const f = 220 + 20 * Math.sin(2 * Math.PI * 0.5 * t);
      sample = 0.3 * Math.sin(2 * Math.PI * f * t) + 0.1 * Math.sin(2 * Math.PI * f * 2 * t);
    }

    // Clamp to 16-bit signed integer [-32768, 32767]
    const clamped = Math.max(-1, Math.min(1, sample * 0.8));
    const intVal = Math.floor(clamped * 32767);
    buffer.writeInt16LE(intVal, 44 + i * 2);
  }

  return buffer;
}

// In-memory persistent database for EchoFlow
interface UserRecord {
  id: number;
  username: string;
  email: string;
  password?: string;
  profile_picture: string | null;
  followers_count: number;
  following_count: number;
  uploads_count: number;
  date_joined: string;
  following: number[];
  long_term_tags: string[];
}

interface AudioClipRecord {
  id: string;
  creator_id: number;
  creator_name: string;
  title: string;
  category: string;
  hls_playlist_url: string;
  likes: number;
  shares: number;
  skips: number;
  comment_count: number;
  status: "processing" | "ready" | "failed";
  duration_ms: number;
  engagement_velocity: number;
  avg_completion_rate: number;
  audio_type: string;
  filePath?: string;
  created_at: string;
}

interface CommentRecord {
  id: string;
  clip_id: string;
  author_id: number;
  author_username: string;
  parent_id: string | null;
  text: string;
  created_at: string;
}

interface ShareRecord {
  id: number;
  sender_id: number;
  sender_name: string;
  receiver_id: number;
  clip_id: string;
  is_read: boolean;
  created_at: string;
}

interface InteractionRecord {
  id: string;
  user_id: number;
  clip_id: string;
  interaction_type: "like" | "share" | "skip" | "view";
  is_active: boolean;
  watch_time_ms: number;
  completion_rate: number;
  updated_at: string;
}

// Seed Users
const users: Map<number, UserRecord> = new Map();
const usersByUsername: Map<string, UserRecord> = new Map();

function addUser(u: UserRecord) {
  users.set(u.id, u);
  usersByUsername.set(u.username.toLowerCase(), u);
}

addUser({
  id: 1,
  username: "alex_waves",
  email: "alex@echoflow.audio",
  password: "password123",
  profile_picture: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
  followers_count: 1420,
  following_count: 86,
  uploads_count: 12,
  date_joined: new Date(Date.now() - 90 * 86400000).toISOString(),
  following: [2, 3],
  long_term_tags: ["comedy", "roast", "tech"],
});

addUser({
  id: 2,
  username: "quantum_mind",
  email: "quantum@echoflow.audio",
  password: "password123",
  profile_picture: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80",
  followers_count: 3890,
  following_count: 140,
  uploads_count: 24,
  date_joined: new Date(Date.now() - 120 * 86400000).toISOString(),
  following: [1],
  long_term_tags: ["science", "physics", "mind"],
});

addUser({
  id: 3,
  username: "stoic_pulse",
  email: "stoic@echoflow.audio",
  password: "password123",
  profile_picture: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80",
  followers_count: 8520,
  following_count: 42,
  uploads_count: 31,
  date_joined: new Date(Date.now() - 180 * 86400000).toISOString(),
  following: [1, 2],
  long_term_tags: ["motivation", "quotes", "mindset"],
});

addUser({
  id: 4,
  username: "lofi_alchemist",
  email: "lofi@echoflow.audio",
  password: "password123",
  profile_picture: "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=150&auto=format&fit=crop&q=80",
  followers_count: 12400,
  following_count: 190,
  uploads_count: 45,
  date_joined: new Date(Date.now() - 210 * 86400000).toISOString(),
  following: [2, 3],
  long_term_tags: ["music", "lofi", "beats"],
});

let nextUserId = 5;

// Seed Audio Clips
const clips: Map<string, AudioClipRecord> = new Map();

const initialClips: AudioClipRecord[] = [
  {
    id: "e4a7819c-0c15-4fa2-bf42-2023a9d01001",
    creator_id: 1,
    creator_name: "alex_waves",
    title: "Why Your Microservices Are Just A Distributed Monolith 💀",
    category: "comedy",
    hls_playlist_url: "/api/media/audio/e4a7819c-0c15-4fa2-bf42-2023a9d01001.wav",
    likes: 3840,
    shares: 412,
    skips: 89,
    comment_count: 154,
    status: "ready",
    duration_ms: 24000,
    engagement_velocity: 8.9,
    avg_completion_rate: 0.92,
    audio_type: "comedy",
    created_at: new Date(Date.now() - 3600000 * 4).toISOString(),
  },
  {
    id: "b9c3214a-1e42-4f33-90d1-3012b8c02002",
    creator_id: 2,
    creator_name: "quantum_mind",
    title: "Quantum Superposition Explained in 40 Seconds",
    category: "science",
    hls_playlist_url: "/api/media/audio/b9c3214a-1e42-4f33-90d1-3012b8c02002.wav",
    likes: 6120,
    shares: 980,
    skips: 110,
    comment_count: 240,
    status: "ready",
    duration_ms: 28000,
    engagement_velocity: 9.4,
    avg_completion_rate: 0.95,
    audio_type: "science",
    created_at: new Date(Date.now() - 3600000 * 8).toISOString(),
  },
  {
    id: "f8d9102c-3b12-4211-9a77-4029c7d03003",
    creator_id: 3,
    creator_name: "stoic_pulse",
    title: "Marcus Aurelius on Waking Up When You Don't Want To",
    category: "motivation",
    hls_playlist_url: "/api/media/audio/f8d9102c-3b12-4211-9a77-4029c7d03003.wav",
    likes: 8950,
    shares: 1420,
    skips: 65,
    comment_count: 310,
    status: "ready",
    duration_ms: 32000,
    engagement_velocity: 9.8,
    avg_completion_rate: 0.97,
    audio_type: "motivation",
    created_at: new Date(Date.now() - 3600000 * 14).toISOString(),
  },
  {
    id: "a1c2345e-4f56-4890-bcde-5038d8e04004",
    creator_id: 4,
    creator_name: "lofi_alchemist",
    title: "Midnight Rain & Tape Cassette Chords (3am Coding Loop)",
    category: "music",
    hls_playlist_url: "/api/media/audio/a1c2345e-4f56-4890-bcde-5038d8e04004.wav",
    likes: 12400,
    shares: 2150,
    skips: 40,
    comment_count: 420,
    status: "ready",
    duration_ms: 35000,
    engagement_velocity: 10.0,
    avg_completion_rate: 0.98,
    audio_type: "music",
    created_at: new Date(Date.now() - 3600000 * 20).toISOString(),
  },
  {
    id: "c2d3456f-5a67-4901-cdef-6049e9f05005",
    creator_id: 1,
    creator_name: "alex_waves",
    title: "The Daily Standup Trap: Nobody Listened To You",
    category: "comedy",
    hls_playlist_url: "/api/media/audio/c2d3456f-5a67-4901-cdef-6049e9f05005.wav",
    likes: 2190,
    shares: 310,
    skips: 140,
    comment_count: 88,
    status: "ready",
    duration_ms: 22000,
    engagement_velocity: 7.6,
    avg_completion_rate: 0.88,
    audio_type: "comedy",
    created_at: new Date(Date.now() - 3600000 * 28).toISOString(),
  },
  {
    id: "d3e4567a-6b78-4012-def0-7050f0a06006",
    creator_id: 2,
    creator_name: "quantum_mind",
    title: "Why Time Moves Only Forward: Entropy and The Arrow of Time",
    category: "science",
    hls_playlist_url: "/api/media/audio/d3e4567a-6b78-4012-def0-7050f0a06006.wav",
    likes: 4720,
    shares: 730,
    skips: 85,
    comment_count: 195,
    status: "ready",
    duration_ms: 30000,
    engagement_velocity: 8.8,
    avg_completion_rate: 0.94,
    audio_type: "science",
    created_at: new Date(Date.now() - 3600000 * 36).toISOString(),
  },
  {
    id: "e4f5678b-7c89-4123-ef01-8061a1b07007",
    creator_id: 3,
    creator_name: "stoic_pulse",
    title: "Seneca: We Suffer More Often In Imagination Than In Reality",
    category: "quotes",
    hls_playlist_url: "/api/media/audio/e4f5678b-7c89-4123-ef01-8061a1b07007.wav",
    likes: 5410,
    shares: 920,
    skips: 50,
    comment_count: 215,
    status: "ready",
    duration_ms: 26000,
    engagement_velocity: 9.1,
    avg_completion_rate: 0.96,
    audio_type: "quotes",
    created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
  },
  {
    id: "f5a6789c-8d90-4234-f012-9072b2c08008",
    creator_id: 4,
    creator_name: "lofi_alchemist",
    title: "Warm Analog Sine Waves for Deep Focus & Flow",
    category: "instrumental",
    hls_playlist_url: "/api/media/audio/f5a6789c-8d90-4234-f012-9072b2c08008.wav",
    likes: 7200,
    shares: 1100,
    skips: 32,
    comment_count: 160,
    status: "ready",
    duration_ms: 34000,
    engagement_velocity: 9.3,
    avg_completion_rate: 0.97,
    audio_type: "music",
    created_at: new Date(Date.now() - 3600000 * 60).toISOString(),
  },
];

initialClips.forEach((c) => clips.set(c.id, c));

// Seed Comments
const comments: Map<string, CommentRecord> = new Map();
const initialComments: CommentRecord[] = [
  {
    id: "c1111111-0000-0000-0000-000000000001",
    clip_id: "e4a7819c-0c15-4fa2-bf42-2023a9d01001",
    author_id: 2,
    author_username: "quantum_mind",
    parent_id: null,
    text: "Ouch. This hit way too close to home for our engineering team 😭",
    created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
  },
  {
    id: "c1111111-0000-0000-0000-000000000002",
    clip_id: "e4a7819c-0c15-4fa2-bf42-2023a9d01001",
    author_id: 1,
    author_username: "alex_waves",
    parent_id: "c1111111-0000-0000-0000-000000000001",
    text: "It is always DNS or a microservice dependency cycle!",
    created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
  },
  {
    id: "c1111111-0000-0000-0000-000000000003",
    clip_id: "b9c3214a-1e42-4f33-90d1-3012b8c02002",
    author_id: 3,
    author_username: "stoic_pulse",
    parent_id: null,
    text: "Clear, concise, and mind-expanding. Love listening while walking.",
    created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
  },
];
initialComments.forEach((cm) => comments.set(cm.id, cm));

// Seed Shares
const shares: Map<number, ShareRecord> = new Map();
let nextShareId = 4;
shares.set(1, {
  id: 1,
  sender_id: 1,
  sender_name: "alex_waves",
  receiver_id: 2,
  clip_id: "b9c3214a-1e42-4f33-90d1-3012b8c02002",
  is_read: false,
  created_at: new Date(Date.now() - 3600000 * 1).toISOString(),
});
shares.set(2, {
  id: 2,
  sender_id: 4,
  sender_name: "lofi_alchemist",
  receiver_id: 1,
  clip_id: "a1c2345e-4f56-4890-bcde-5038d8e04004",
  is_read: true,
  created_at: new Date(Date.now() - 3600000 * 6).toISOString(),
});

// Seed Interactions
const interactions: Map<string, InteractionRecord> = new Map();

function getInteractionKey(userId: number, clipId: string, type: string) {
  return `${userId}:${clipId}:${type}`;
}

// Initial like for user 1 on clip 2
interactions.set(getInteractionKey(1, "b9c3214a-1e42-4f33-90d1-3012b8c02002", "like"), {
  id: "int-1",
  user_id: 1,
  clip_id: "b9c3214a-1e42-4f33-90d1-3012b8c02002",
  interaction_type: "like",
  is_active: true,
  watch_time_ms: 28000,
  completion_rate: 1.0,
  updated_at: new Date().toISOString(),
});

// Authentication Helpers
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.substring(7).trim();
}

function getAuthUser(req: Request): UserRecord | null {
  const token = extractToken(req);
  if (!token) return null;
  try {
    // Basic JWT-like or pseudo token payload
    const decoded = JSON.parse(Buffer.from(token.split(".")[1] || token, "base64").toString("utf-8"));
    if (decoded && decoded.user_id) {
      return users.get(decoded.user_id) || null;
    }
  } catch (_e) {
    // If token is direct numeric user ID or simple string
    const uid = parseInt(token, 10);
    if (!isNaN(uid) && users.has(uid)) {
      return users.get(uid) || null;
    }
  }
  // Default to user 1 for development/testing if header present
  return users.get(1) || null;
}

function generateTokens(user: UserRecord) {
  const payload = { user_id: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 900 };
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  const access = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${base64Payload}.dummy_sig_${Date.now()}`;
  const refresh = `refresh_${user.id}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  return { access, refresh };
}

// FeedClipSerializer mapping helper
function serializeFeedClip(clip: AudioClipRecord, currentUser: UserRecord | null, req: Request) {
  let is_liked = false;
  if (currentUser) {
    const intRecord = interactions.get(getInteractionKey(currentUser.id, clip.id, "like"));
    is_liked = !!(intRecord && intRecord.is_active);
  }

  // Make sure HLS/audio URL is absolute HTTPS/HTTP as specified in §1.2
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  let hls_playlist_url = clip.hls_playlist_url;
  if (hls_playlist_url && !hls_playlist_url.startsWith("http")) {
    hls_playlist_url = `${protocol}://${host}${hls_playlist_url}`;
  }

  return {
    id: clip.id,
    title: clip.title,
    creator_name: clip.creator_name,
    creator_id: clip.creator_id,
    category: clip.category,
    duration_ms: clip.duration_ms,
    hls_playlist_url: clip.status === "ready" ? hls_playlist_url : null,
    likes: Math.max(0, clip.likes),
    shares: Math.max(0, clip.shares),
    skips: Math.max(0, clip.skips),
    comment_count: Math.max(0, clip.comment_count),
    is_liked,
  };
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// Audio stream endpoint - serves high quality audio wave
app.get("/api/media/audio/:clip_id.wav", (req: Request, res: Response) => {
  const clipId = req.params.clip_id;
  const clip = clips.get(clipId);
  const audioType = clip ? clip.audio_type : "music";
  const duration = clip ? Math.floor(clip.duration_ms / 1000) : 25;

  const wavBuffer = generateAudioWav(audioType, duration);

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Length", wavBuffer.length);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(wavBuffer);
});

// 1. AUTH
app.post("/auth/register/", (req: Request, res: Response) => {
  const { username, password, email } = req.body;

  if (!username || !password || !email) {
    res.status(400).json({
      username: !username ? ["This field is required."] : undefined,
      password: !password ? ["This field is required."] : undefined,
      email: !email ? ["This field is required."] : undefined,
    });
    return;
  }

  if (usersByUsername.has(username.toLowerCase())) {
    res.status(400).json({ username: ["A user with that username already exists."] });
    return;
  }

  // Check unique email
  for (const existing of users.values()) {
    if (existing.email.toLowerCase() === email.toLowerCase()) {
      res.status(400).json({ email: ["user with this email already exists."] });
      return;
    }
  }

  if (password.length < 8) {
    res.status(400).json({ password: ["Password must be at least 8 characters long."] });
    return;
  }

  const newUser: UserRecord = {
    id: nextUserId++,
    username,
    email,
    password,
    profile_picture: null,
    followers_count: 0,
    following_count: 0,
    uploads_count: 0,
    date_joined: new Date().toISOString(),
    following: [],
    long_term_tags: [],
  };

  addUser(newUser);

  // Return 201 User (NO tokens, per Django specification in §1.3)
  res.status(201).json({
    id: newUser.id,
    username: newUser.username,
    email: newUser.email,
  });
});

app.post("/auth/login/", (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ detail: "Username and password required." });
    return;
  }

  const user = usersByUsername.get(username.toLowerCase());
  if (!user || user.password !== password) {
    res.status(401).json({ detail: "No active account found with the given credentials" });
    return;
  }

  const tokens = generateTokens(user);
  res.json({
    access: tokens.access,
    refresh: tokens.refresh,
  });
});

app.post("/auth/token/refresh/", (req: Request, res: Response) => {
  const { refresh } = req.body;
  if (!refresh) {
    res.status(400).json({ detail: "Refresh token required." });
    return;
  }

  // Generate rotated tokens
  const authUser = getAuthUser(req) || users.get(1)!;
  const newTokens = generateTokens(authUser);

  res.json({
    access: newTokens.access,
    refresh: newTokens.refresh,
  });
});

app.post("/auth/logout/", (_req: Request, res: Response) => {
  res.json({ detail: "logged out" });
});

// 2. FEED
app.get("/feed/", (req: Request, res: Response) => {
  // The local mobile/web demo has no login screen, so use the seeded demo
  // profile for read-only feed serialization when no bearer token is present.
  const authUser = getAuthUser(req) || users.get(1)!;

  // Get ready clips
  const readyClips = Array.from(clips.values()).filter((c) => c.status === "ready");

  // Recommendation sorting based on user's tags & engagement
  const userTags = new Set(authUser.long_term_tags);
  const sortedClips = [...readyClips].sort((a, b) => {
    const aMatch = userTags.has(a.category) ? 1.5 : 1.0;
    const bMatch = userTags.has(b.category) ? 1.5 : 1.0;
    return b.engagement_velocity * bMatch - a.engagement_velocity * aMatch;
  });

  const serialized = sortedClips.map((c) => serializeFeedClip(c, authUser, req));

  res.json({
    next: "auto_trigger",
    queue_health: readyClips.length,
    results: serialized,
  });
});

// 3. SUGGESTIONS
app.get("/suggestions/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req) || users.get(1)!;

  const category = (req.query.category as string) || "all";
  let filtered = Array.from(clips.values()).filter((c) => c.status === "ready");

  if (category && category !== "all") {
    filtered = filtered.filter(
      (c) => c.category.toLowerCase() === category.toLowerCase()
    );
  }

  const serialized = filtered.map((c) => serializeFeedClip(c, authUser, req));

  // Envelope matching FeedCursorPagination { next, previous, results }
  res.json({
    next: null,
    previous: null,
    results: serialized,
  });
});

// 4. COLD START TAG INITIALIZATION
app.post("/tags/initialize/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const { selected_tags } = req.body;
  if (!selected_tags || !Array.isArray(selected_tags) || selected_tags.length === 0) {
    res.status(400).json({ error: "Not enough data to build baseline." });
    return;
  }

  authUser.long_term_tags = selected_tags;
  res.json({ status: "Algorithm initialized. Feed is ready." });
});

// 5. CLIPS (UPLOADS & CRUD)
app.get("/clips/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const myClips = Array.from(clips.values()).filter((c) => c.creator_id === authUser.id);
  res.json({
    count: myClips.length,
    results: myClips,
  });
});

app.post("/clips/", upload.single("original_file"), (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const { title, category } = req.body;
  const file = req.file;

  if (!file) {
    res.status(400).json({ original_file: ["This field is required."] });
    return;
  }

  if (!title) {
    res.status(400).json({ title: ["This field is required."] });
    return;
  }

  const clipId = `clip-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  // Determine media URL
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  const hlsUrl = `${protocol}://${host}/api/media/audio/${clipId}.wav`;

  const newClip: AudioClipRecord = {
    id: clipId,
    creator_id: authUser.id,
    creator_name: authUser.username,
    title,
    category: category || "general",
    hls_playlist_url: hlsUrl,
    likes: 0,
    shares: 0,
    skips: 0,
    comment_count: 0,
    status: "processing", // initial status per specification
    duration_ms: 25000,
    engagement_velocity: 5.0,
    avg_completion_rate: 0.0,
    audio_type: "music",
    created_at: new Date().toISOString(),
  };

  clips.set(clipId, newClip);
  authUser.uploads_count += 1;

  // Simulate Celery background processing to ready in 3.5 seconds
  setTimeout(() => {
    const existing = clips.get(clipId);
    if (existing) {
      existing.status = "ready";
    }
  }, 3500);

  // Return 202 Accepted per spec §1.2
  res.status(202).json({
    message: "Audio uploading and processing in background.",
    clip_id: clipId,
    status: "processing",
  });
});

app.patch("/clips/:id/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const clip = clips.get(req.params.id);
  if (!clip) {
    res.status(404).json({ detail: "Not found." });
    return;
  }

  if (clip.creator_id !== authUser.id) {
    res.status(403).json({ detail: "You do not have permission to edit this clip." });
    return;
  }

  const { title, category } = req.body;
  if (title !== undefined) clip.title = title;
  if (category !== undefined) clip.category = category;

  res.json(serializeFeedClip(clip, authUser, req));
});

app.delete("/clips/:id/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const clip = clips.get(req.params.id);
  if (!clip) {
    res.status(404).json({ detail: "Not found." });
    return;
  }

  if (clip.creator_id !== authUser.id) {
    res.status(403).json({ detail: "You do not have permission to delete this clip." });
    return;
  }

  clips.delete(clip.id);
  authUser.uploads_count = Math.max(0, authUser.uploads_count - 1);
  res.status(204).send();
});

// 6. INTERACTIONS
app.post("/interactions/:id/toggle-like/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const clip = clips.get(req.params.id);
  if (!clip) {
    res.status(404).json({ detail: "Not found." });
    return;
  }

  const key = getInteractionKey(authUser.id, clip.id, "like");
  const existing = interactions.get(key);

  let newStatus: "liked" | "unliked" = "liked";

  if (!existing) {
    interactions.set(key, {
      id: `int-${Date.now()}`,
      user_id: authUser.id,
      clip_id: clip.id,
      interaction_type: "like",
      is_active: true,
      watch_time_ms: 0,
      completion_rate: 0,
      updated_at: new Date().toISOString(),
    });
    clip.likes += 1;
    newStatus = "liked";
  } else {
    existing.is_active = !existing.is_active;
    existing.updated_at = new Date().toISOString();
    if (existing.is_active) {
      clip.likes += 1;
      newStatus = "liked";
    } else {
      clip.likes = Math.max(0, clip.likes - 1);
      newStatus = "unliked";
    }
  }

  res.json({ status: newStatus });
});

app.post("/interactions/:id/register-skip/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const clip = clips.get(req.params.id);
  if (clip) {
    clip.skips += 1;
  }

  res.status(201).json({ status: "skip/view registered" });
});

app.post("/interactions/:id/log-telemetry/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  res.status(202).json({ status: "telemetry logged" });
});

// 7. COMMENTS
app.get("/comments/", (req: Request, res: Response) => {
  const clipId = req.query.clip as string;
  const parentId = (req.query.parent as string) || null;

  let list = Array.from(comments.values());

  if (clipId) {
    list = list.filter((c) => c.clip_id === clipId);
  }

  if (parentId !== undefined && parentId !== null) {
    list = list.filter((c) => c.parent_id === parentId);
  } else {
    // Only top level comments if parent parameter not set
    list = list.filter((c) => c.parent_id === null);
  }

  // Count replies for top-level comments
  const results = list.map((c) => {
    const reply_count = Array.from(comments.values()).filter((r) => r.parent_id === c.id).length;
    return {
      id: c.id,
      clip: c.clip_id,
      author_username: c.author_username,
      parent: c.parent_id,
      text: c.text,
      reply_count,
      created_at: c.created_at,
    };
  });

  res.json({
    next: null,
    previous: null,
    results,
  });
});

app.post("/comments/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const { clip, text, parent } = req.body;
  if (!clip || !text) {
    res.status(400).json({ text: ["This field is required."] });
    return;
  }

  const clipRecord = clips.get(clip);
  if (!clipRecord) {
    res.status(404).json({ detail: "Clip not found." });
    return;
  }

  const newComment: CommentRecord = {
    id: `comm-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    clip_id: clip,
    author_id: authUser.id,
    author_username: authUser.username,
    parent_id: parent || null,
    text: text.trim().substring(0, 500),
    created_at: new Date().toISOString(),
  };

  comments.set(newComment.id, newComment);

  // Top level comments bump comment_count
  if (!parent) {
    clipRecord.comment_count += 1;
  }

  res.status(201).json({
    id: newComment.id,
    clip: newComment.clip_id,
    author_username: newComment.author_username,
    parent: newComment.parent_id,
    text: newComment.text,
    reply_count: 0,
    created_at: newComment.created_at,
  });
});

app.get("/comments/:id/", (req: Request, res: Response) => {
  const comm = comments.get(req.params.id);
  if (!comm) {
    res.status(404).json({ detail: "Not found." });
    return;
  }
  const reply_count = Array.from(comments.values()).filter((r) => r.parent_id === comm.id).length;
  res.json({
    id: comm.id,
    clip: comm.clip_id,
    author_username: comm.author_username,
    parent: comm.parent_id,
    text: comm.text,
    reply_count,
    created_at: comm.created_at,
  });
});

app.patch("/comments/:id/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const comm = comments.get(req.params.id);
  if (!comm) {
    res.status(404).json({ detail: "Not found." });
    return;
  }

  if (comm.author_id !== authUser.id) {
    res.status(403).json({ detail: "You do not have permission to edit this comment." });
    return;
  }

  const { text } = req.body;
  if (text) {
    comm.text = text.trim().substring(0, 500);
  }

  res.json({
    id: comm.id,
    clip: comm.clip_id,
    author_username: comm.author_username,
    parent: comm.parent_id,
    text: comm.text,
    reply_count: 0,
    created_at: comm.created_at,
  });
});

app.delete("/comments/:id/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const comm = comments.get(req.params.id);
  if (!comm) {
    res.status(404).json({ detail: "Not found." });
    return;
  }

  if (comm.author_id !== authUser.id) {
    res.status(403).json({ detail: "You do not have permission to delete this comment." });
    return;
  }

  comments.delete(comm.id);
  const clipRecord = clips.get(comm.clip_id);
  if (clipRecord && !comm.parent_id) {
    clipRecord.comment_count = Math.max(0, clipRecord.comment_count - 1);
  }

  res.status(204).send();
});

// 8. SHARING
app.get("/share/find-user/", (req: Request, res: Response) => {
  const username = req.query.username as string;
  if (!username) {
    res.status(400).json({ error: "Username required" });
    return;
  }

  const cleanName = username.replace(/^@/, "").toLowerCase();
  const user = usersByUsername.get(cleanName);

  if (!user) {
    res.status(404).json({ error: `No user found: @${cleanName}` });
    return;
  }

  res.json({ id: user.id, username: user.username });
});

app.post("/share/:clip_id/send-share/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const clip = clips.get(req.params.clip_id);
  if (!clip) {
    res.status(404).json({ detail: "Clip not found." });
    return;
  }

  const { receiver_id } = req.body;
  if (!receiver_id) {
    res.status(400).json({ error: "Receiver ID required" });
    return;
  }

  if (Number(receiver_id) === authUser.id) {
    res.status(400).json({ error: "You can't share with yourself" });
    return;
  }

  const receiver = users.get(Number(receiver_id));
  if (!receiver) {
    res.status(404).json({ detail: "User not found." });
    return;
  }

  const shareId = nextShareId++;
  const newShare: ShareRecord = {
    id: shareId,
    sender_id: authUser.id,
    sender_name: authUser.username,
    receiver_id: receiver.id,
    clip_id: clip.id,
    is_read: false,
    created_at: new Date().toISOString(),
  };

  shares.set(shareId, newShare);
  clip.shares += 1;

  res.status(201).json({ status: "shared successfully" });
});

app.get("/share/inbox/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const userShares = Array.from(shares.values())
    .filter((s) => s.receiver_id === authUser.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const serialized = userShares.map((s) => {
    const clip = clips.get(s.clip_id) || initialClips[0];
    const clipSerialized = serializeFeedClip(clip, authUser, req);
    return {
      id: s.id,
      sender_name: s.sender_name,
      clip: clipSerialized,
      clip_title: clip.title,
      clip_hls_url: clipSerialized.hls_playlist_url,
      created_at: s.created_at,
      is_read: s.is_read,
    };
  });

  res.json(serialized);
});

app.get("/share/", (req: Request, res: Response) => {
  // Alias for /share/inbox/
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const userShares = Array.from(shares.values())
    .filter((s) => s.receiver_id === authUser.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const serialized = userShares.map((s) => {
    const clip = clips.get(s.clip_id) || initialClips[0];
    const clipSerialized = serializeFeedClip(clip, authUser, req);
    return {
      id: s.id,
      sender_name: s.sender_name,
      clip: clipSerialized,
      clip_title: clip.title,
      clip_hls_url: clipSerialized.hls_playlist_url,
      created_at: s.created_at,
      is_read: s.is_read,
    };
  });

  res.json(serialized);
});

app.get("/share/unread-count/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const unread = Array.from(shares.values()).filter(
    (s) => s.receiver_id === authUser.id && !s.is_read
  ).length;

  res.json({ unread });
});

// CRITICAL SPEC: POST /share/:id/mark-read/ (NOT PATCH!)
app.post("/share/:id/mark-read/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const share = shares.get(Number(req.params.id));
  if (share && share.receiver_id === authUser.id) {
    share.is_read = true;
  }

  res.status(204).send();
});

app.delete("/share/:id/share-delete/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const share = shares.get(Number(req.params.id));
  if (share && share.receiver_id === authUser.id) {
    shares.delete(share.id);
  }

  res.status(204).send();
});

// 9. FOLLOW
app.post("/follow/:user_id/toggle-follow/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const targetId = Number(req.params.user_id);
  if (targetId === authUser.id) {
    res.status(400).json({ error: "You cannot follow yourself." });
    return;
  }

  const targetUser = users.get(targetId);
  if (!targetUser) {
    res.status(404).json({ detail: "User not found." });
    return;
  }

  const idx = authUser.following.indexOf(targetId);
  if (idx === -1) {
    authUser.following.push(targetId);
    authUser.following_count += 1;
    targetUser.followers_count += 1;
    res.status(201).json({ status: "followed" });
  } else {
    authUser.following.splice(idx, 1);
    authUser.following_count = Math.max(0, authUser.following_count - 1);
    targetUser.followers_count = Math.max(0, targetUser.followers_count - 1);
    res.status(200).json({ status: "unfollowed" });
  }
});

// 10. PROFILES
app.get("/profile/me/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  // Find clips liked by current user
  const likedClips: ReturnType<typeof serializeFeedClip>[] = [];
  for (const [key, int] of interactions.entries()) {
    if (key.startsWith(`${authUser.id}:`) && int.interaction_type === "like" && int.is_active) {
      const c = clips.get(int.clip_id);
      if (c && c.status === "ready") {
        likedClips.push(serializeFeedClip(c, authUser, req));
      }
    }
  }

  // Return OwnProfileSerializer shape
  res.json({
    id: authUser.id,
    username: authUser.username,
    email: authUser.email,
    profile_picture: authUser.profile_picture,
    followers_count: authUser.followers_count,
    following_count: authUser.following_count,
    uploads_count: authUser.uploads_count,
    liked_clips: likedClips.slice(0, 50),
    date_joined: authUser.date_joined,
  });
});

app.patch("/profile/me/update/", upload.single("profile_picture"), (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const { username } = req.body;
  const file = req.file;

  if (username && username.trim() !== authUser.username) {
    const cleanUsername = username.trim();
    if (usersByUsername.has(cleanUsername.toLowerCase()) && cleanUsername.toLowerCase() !== authUser.username.toLowerCase()) {
      res.status(400).json({ username: ["A user with that username already exists."] });
      return;
    }
    usersByUsername.delete(authUser.username.toLowerCase());
    authUser.username = cleanUsername;
    usersByUsername.set(cleanUsername.toLowerCase(), authUser);
  }

  if (file) {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.get("host") || `localhost:${PORT}`;
    authUser.profile_picture = `${protocol}://${host}/uploads/${file.filename}`;
  }

  // Return updated OwnProfile
  const likedClips: ReturnType<typeof serializeFeedClip>[] = [];
  for (const [key, int] of interactions.entries()) {
    if (key.startsWith(`${authUser.id}:`) && int.interaction_type === "like" && int.is_active) {
      const c = clips.get(int.clip_id);
      if (c && c.status === "ready") {
        likedClips.push(serializeFeedClip(c, authUser, req));
      }
    }
  }

  res.json({
    id: authUser.id,
    username: authUser.username,
    email: authUser.email,
    profile_picture: authUser.profile_picture,
    followers_count: authUser.followers_count,
    following_count: authUser.following_count,
    uploads_count: authUser.uploads_count,
    liked_clips: likedClips.slice(0, 50),
    date_joined: authUser.date_joined,
  });
});

app.get("/profile/:id/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const target = users.get(Number(req.params.id));
  if (!target) {
    res.status(404).json({ detail: "User not found." });
    return;
  }

  // Return PublicProfileSerializer shape (no email, no liked_clips per spec)
  res.json({
    id: target.id,
    username: target.username,
    profile_picture: target.profile_picture,
    followers_count: target.followers_count,
    following_count: target.following_count,
    uploads_count: target.uploads_count,
    date_joined: target.date_joined,
  });
});

app.get("/profile/:id/clips/", (req: Request, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    res.status(401).json({ detail: "Authentication credentials were not provided." });
    return;
  }

  const targetId = Number(req.params.id);
  const userClips = Array.from(clips.values())
    .filter((c) => c.creator_id === targetId && c.status === "ready")
    .map((c) => serializeFeedClip(c, authUser, req));

  res.json({
    next: null,
    previous: null,
    results: userClips,
  });
});

// 11. INFRA
app.get("/health/", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/ready/", (_req: Request, res: Response) => {
  res.json({ status: "ready" });
});

app.get("/metrics/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(`# HELP echoflow_active_users Number of active users
# TYPE echoflow_active_users gauge
echoflow_active_users ${users.size}
# HELP echoflow_ready_clips Number of ready clips in catalog
# TYPE echoflow_ready_clips gauge
echoflow_ready_clips ${Array.from(clips.values()).filter((c) => c.status === "ready").length}
`);
});

// -------------------------------------------------------------
// VITE MIDDLEWARE & BOOTSTRAP
// -------------------------------------------------------------

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`EchoFlow server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
