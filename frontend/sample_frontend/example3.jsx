import React, { useState, useEffect, useRef, createContext, useContext, useCallback } from 'react';
import { 
  Home, Compass, PlusCircle, Bell, User, Settings, Search, X, 
  Play, Pause, Heart, MessageCircle, Share2, Image as ImageIcon,
  Check, ChevronRight, Moon, Sun, Edit3, UploadCloud, LogOut, Loader2, AlertCircle, RefreshCw, Trash2
} from 'lucide-react';

// ============================================================================
// CONFIGURATION & THEME
// ============================================================================
const API_BASE = 'http://localhost:8005';
const CATEGORIES = ['instrumental', 'funny', 'news', 'science', 'music'];

const ThemeContext = createContext(null);

// ============================================================================
// API LAYER (api/axiosInstance.js & endpoints)
// ============================================================================
const apiClient = async (endpoint, options = {}) => {
  const token = localStorage.getItem('access_token');
  const headers = { ...options.headers };
  
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    if (options.body && typeof options.body === 'object') {
      options.body = JSON.stringify(options.body);
    }
  }

  let res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });

  // 401 Interceptor Logic for Token Refresh
  if (res.status === 401) {
    const refreshToken = localStorage.getItem('refresh_token');
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${API_BASE}/auth/refresh/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh: refreshToken })
        });
        
        if (refreshRes.ok) {
          const { access } = await refreshRes.json();
          localStorage.setItem('access_token', access);
          headers['Authorization'] = `Bearer ${access}`;
          res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers }); // Retry
        } else {
          throw new Error("Session expired");
        }
      } catch (err) {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('auth_user');
        window.location.reload();
        throw new Error("Session expired. Please log in again.");
      }
    }
  }

  if (!res.ok) {
    let errorData;
    try { errorData = await res.json(); } catch { errorData = { detail: res.statusText }; }
    throw { status: res.status, message: errorData.detail || 'API Request Failed', field_errors: errorData };
  }
  
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

// ============================================================================
// GLOBAL STATE STORES (store/)
// ============================================================================
const AuthContext = createContext(null);
const PlayerContext = createContext(null);

// --- Auth Provider ---
const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('auth_user') || 'null'));
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('access_token'));

  const login = async (email, password) => {
    const data = await apiClient('/auth/login/', { method: 'POST', body: { email, password } });
    localStorage.setItem('access_token', data.access);
    localStorage.setItem('refresh_token', data.refresh);
    localStorage.setItem('auth_user', JSON.stringify(data.user));
    setUser(data.user);
    setIsAuthenticated(true);
  };

  const register = async (email, username, password) => {
    const data = await apiClient('/auth/register/', { method: 'POST', body: { email, username, password } });
    localStorage.setItem('access_token', data.access);
    localStorage.setItem('refresh_token', data.refresh);
    localStorage.setItem('auth_user', JSON.stringify(data.user));
    setUser(data.user);
    setIsAuthenticated(true);
  };

  const logout = () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('auth_user');
    setUser(null);
    setIsAuthenticated(false);
  };

  return <AuthContext.Provider value={{ user, isAuthenticated, login, register, logout, setUser }}>{children}</AuthContext.Provider>;
};

// --- HLS Player Provider (hooks/useHLSPlayer.js integrated) ---
const PlayerProvider = ({ children }) => {
  const [activeClip, setActiveClip] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bitrate, setBitrate] = useState('Auto');
  const [error, setError] = useState(null);
  const [startedAt, setStartedAt] = useState(null);

  const audioRef = useRef(new Audio());
  const hlsRef = useRef(null);

  // Load HLS.js
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.Hls) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1';
      script.async = true;
      document.body.appendChild(script);
    }

    const audio = audioRef.current;
    
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      setProgress(audio.currentTime);
      if (audio.buffered.length > 0) {
        setBuffered(audio.buffered.end(audio.buffered.length - 1));
      }
    };
    const onDurationChange = () => setDuration(audio.duration);
    const onEnded = () => setIsPlaying(false);
    
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      if (hlsRef.current) hlsRef.current.destroy();
    };
  }, []);

  // Telemetry Trigger
  const logTelemetry = useCallback(async (clipId, watchTimeMs) => {
    if (!clipId || watchTimeMs < 1000) return;
    try {
      await apiClient(`/interactions/${clipId}/log-telemetry/`, {
        method: 'POST',
        body: { action_type: 'view', watch_time_ms: watchTimeMs }
      });
    } catch (e) { /* Silent fail for telemetry */ }
  }, []);

  const playTrack = useCallback((clip) => {
    const audio = audioRef.current;
    setError(null);

    // Toggle same track
    if (activeClip?.id === clip.id) {
      if (isPlaying) audio.pause();
      else audio.play().catch(() => setError("Playback interrupted."));
      return;
    }

    // New track cleanup & telemetry
    if (activeClip && startedAt) {
      logTelemetry(activeClip.id, Date.now() - startedAt);
    }
    
    setActiveClip(clip);
    setStartedAt(Date.now());
    setProgress(0);
    setBuffered(0);

    const url = clip.audio_url || clip.audioUrl;
    if (!url) return setError("No audio stream available.");

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (window.Hls && window.Hls.isSupported() && url.includes('.m3u8')) {
      const hls = new window.Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      hlsRef.current = hls;
      
      hls.loadSource(url);
      hls.attachMedia(audio);
      
      hls.on(window.Hls.Events.MANIFEST_PARSED, (event, data) => {
        audio.play().catch(() => setError("Browser prevented auto-play."));
      });

      hls.on(window.Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const level = hls.levels[data.level];
        if (level && level.bitrate) setBitrate(`${Math.round(level.bitrate / 1000)}k`);
      });

      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad(); // Retry
          } else {
            setError("HLS Streaming Error.");
            hls.destroy();
          }
        }
      });
    } else {
      audio.src = url;
      audio.load();
      audio.play().catch(() => setError("Native playback failed."));
    }
  }, [activeClip, isPlaying, startedAt, logTelemetry]);

  const pauseTrack = useCallback(() => {
    audioRef.current.pause();
  }, []);

  const seek = useCallback((time) => {
    audioRef.current.currentTime = time;
  }, []);

  const destroy = useCallback(() => {
    if (activeClip && startedAt) {
      logTelemetry(activeClip.id, Date.now() - startedAt);
    }
    audioRef.current.pause();
    if (hlsRef.current) hlsRef.current.destroy();
    setActiveClip(null);
    setIsPlaying(false);
  }, [activeClip, startedAt, logTelemetry]);

  return (
    <PlayerContext.Provider value={{ activeClip, isPlaying, progress, buffered, duration, bitrate, error, playTrack, pauseTrack, seek, destroy }}>
      {children}
    </PlayerContext.Provider>
  );
};

// ============================================================================
// SHARED COMPONENTS (components/shared & components/feed)
// ============================================================================

const EmptyState = ({ icon: Icon, title, message, actionText, onAction }) => (
  <div className="h-full w-full flex flex-col items-center justify-center p-8 text-center bg-gray-50 dark:bg-black text-gray-900 dark:text-white">
    <Icon size={48} className="text-gray-400 dark:text-gray-700 mb-4" />
    <p className="text-lg font-bold mb-2">{title}</p>
    <p className="text-gray-500 text-sm mb-6">{message}</p>
    {onAction && (
      <button onClick={onAction} className="px-6 py-2 bg-blue-600 dark:bg-white/10 rounded-full font-bold text-white hover:opacity-90 transition-opacity">
        {actionText}
      </button>
    )}
  </div>
);

// --- Reel Audio Bar UI ---
const ReelAudioBar = ({ clip, isThisPlaying }) => {
  const { progress, buffered, duration, bitrate, error, playTrack, seek } = useContext(PlayerContext);
  
  const handleSeek = (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    seek(percent * duration);
  };

  const isBuffering = isThisPlaying && buffered < progress + 2 && progress < duration;

  return (
    <div className="w-full mt-4 bg-white/80 dark:bg-black/40 backdrop-blur-md rounded-xl p-3 border border-gray-200 dark:border-white/10 shadow-sm" onClick={() => playTrack(clip)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-3">
          <button className="text-gray-900 dark:text-white hover:scale-105 transition-transform cursor-pointer">
            {isBuffering ? <Loader2 size={20} className="animate-spin" /> : (isThisPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />)}
          </button>
          <span className="text-xs font-mono font-medium text-gray-700 dark:text-gray-300">
            {isThisPlaying ? formatTime(progress) : '0:00'} / {formatTime(clip.duration || duration)}
          </span>
        </div>
        <span className="text-[10px] uppercase font-bold text-gray-400 dark:text-gray-500 bg-gray-200 dark:bg-white/10 px-1.5 py-0.5 rounded">
          {isThisPlaying ? bitrate : 'HLS'}
        </span>
      </div>

      <div className="w-full h-1.5 bg-gray-300 dark:bg-white/20 rounded-full relative overflow-hidden cursor-pointer" onClick={handleSeek}>
        {/* Buffer Bar */}
        <div 
          className="absolute top-0 left-0 h-full bg-gray-400 dark:bg-white/40 transition-all duration-300"
          style={{ width: isThisPlaying && duration ? `${(buffered / duration) * 100}%` : '0%' }}
        />
        {/* Progress Bar */}
        <div 
          className="absolute top-0 left-0 h-full bg-blue-600 dark:bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.5)] transition-all duration-100"
          style={{ width: isThisPlaying && duration ? `${(progress / duration) * 100}%` : '0%' }}
        />
      </div>
    </div>
  );
};

// --- Reel Card (The core reusable component) ---
const ReelCard = ({ clip, context = 'feed', onProfileClick }) => {
  const { activeClip, isPlaying, error } = useContext(PlayerContext);
  
  const [liked, setLiked] = useState(clip.is_liked || false);
  const [likesCount, setLikesCount] = useState(clip.likes_count || 0);
  const [following, setFollowing] = useState(clip.creator?.is_followed || false);

  const isThisClipPlaying = isPlaying && activeClip?.id === clip.id;
  const thisClipError = activeClip?.id === clip.id ? error : null;

  const handleLike = async () => {
    const origLiked = liked;
    const origCount = likesCount;
    setLiked(!origLiked);
    setLikesCount(prev => prev + (origLiked ? -1 : 1));

    try {
      await apiClient(`/interactions/${clip.id}/toggle-like/`, { method: 'POST' });
    } catch (e) {
      setLiked(origLiked);
      setLikesCount(origCount);
    }
  };

  const handleFollow = async () => {
    if (!clip.creator?.id) return;
    const origFollowing = following;
    setFollowing(!origFollowing);
    try {
      await apiClient(`/follow/${clip.creator.id}/toggle-follow/`, { method: 'POST' });
    } catch (e) {
      setFollowing(origFollowing);
    }
  };

  const handleShare = async () => {
    // In a real app, opens user search. Triggering dummy endpoint.
    try {
      await apiClient(`/share/${clip.id}/send-share/`, { method: 'POST', body: { recipient_id: 1 } });
      alert("Clip shared!");
    } catch (e) {
      alert("Failed to share clip.");
    }
  };

  return (
    <div className="w-full h-[100dvh] relative bg-gray-100 dark:bg-black overflow-hidden snap-start flex-shrink-0 border-b border-gray-200 dark:border-white/5">
      <div className="absolute inset-0 z-0 bg-gray-200 dark:bg-gray-900">
        <div className="w-full h-full flex items-center justify-center opacity-20">
           <ImageIcon size={64} className="text-gray-500" />
        </div>
        {clip.cover_image && (
          <img src={clip.cover_image} alt="Visual" className="w-full h-full object-cover opacity-60 mix-blend-overlay" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/90 dark:to-black/95"></div>
      </div>

      <div className="absolute inset-0 z-10 flex flex-col justify-end p-4 md:p-6 pb-24 md:pb-8">
        {thisClipError && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-black/80 px-4 py-2 rounded text-red-500 text-sm flex items-center shadow-lg border border-red-200 dark:border-red-500/30">
            <AlertCircle size={16} className="mr-2" /> {thisClipError}
          </div>
        )}

        <div className="flex justify-between items-end text-white">
          <div className="flex-1 pr-12">
            <div className="flex items-center space-x-3 mb-3">
              <button onClick={() => onProfileClick(clip.creator?.id)} className="font-bold text-lg hover:underline cursor-pointer tracking-wide drop-shadow-md">
                @{clip.creator?.username || 'Unknown'}
              </button>
              <button 
                onClick={handleFollow}
                className={cn(
                  "px-3 py-1 text-xs font-bold rounded-full transition-colors cursor-pointer border shadow-sm",
                  following ? "bg-black/40 border-white/50 text-white" : "bg-white text-black border-white"
                )}
              >
                {following ? 'Following' : 'Follow'}
              </button>
            </div>
            <h2 className="text-2xl font-bold mb-2 leading-tight drop-shadow-lg">{clip.title}</h2>
            <div className="flex items-center space-x-2">
              <span className="bg-black/40 backdrop-blur-md px-2.5 py-1 rounded-md text-[10px] uppercase tracking-wider font-bold border border-white/10">
                {clip.category || 'Audio'}
              </span>
            </div>
          </div>

          <div className="flex flex-col items-center space-y-6 pb-4">
            <button className="flex flex-col items-center space-y-1 cursor-pointer group hover:scale-105 transition-transform" onClick={handleLike}>
              <div className="bg-black/50 p-3 rounded-full backdrop-blur-md group-hover:bg-black/70 transition-colors border border-white/10">
                <Heart size={26} className={liked ? "fill-red-500 text-red-500" : "text-white"} />
              </div>
              <span className="text-xs font-semibold drop-shadow-md">{likesCount}</span>
            </button>
            
            <button className="flex flex-col items-center space-y-1 cursor-pointer group hover:scale-105 transition-transform">
              <div className="bg-black/50 p-3 rounded-full backdrop-blur-md group-hover:bg-black/70 transition-colors border border-white/10">
                <MessageCircle size={26} className="text-white" />
              </div>
              <span className="text-xs font-semibold drop-shadow-md">{clip.comments_count || 0}</span>
            </button>

            <button className="flex flex-col items-center space-y-1 cursor-pointer group hover:scale-105 transition-transform" onClick={handleShare}>
              <div className="bg-black/50 p-3 rounded-full backdrop-blur-md group-hover:bg-black/70 transition-colors border border-white/10">
                <Share2 size={26} className="text-white" />
              </div>
              <span className="text-xs font-semibold drop-shadow-md">Share</span>
            </button>
          </div>
        </div>

        <ReelAudioBar clip={clip} isThisPlaying={isThisClipPlaying} />
      </div>
    </div>
  );
};

// ============================================================================
// PAGES (pages/)
// ============================================================================

// --- Feed Page (Implements Infinite Scroll + Server State) ---
const FeedPage = ({ mode = "feed", feedParams = null, onBack }) => {
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  // Ref for intersection observer (simplified infinite scroll)
  const loaderRef = useRef(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchClips = useCallback(async (pageNum) => {
    try {
      let endpoint = `/feed/?page=${pageNum}`;
      let options = {};

      if (mode === "explore" && feedParams?.type === 'category') {
        endpoint = `/suggestions/?category=${feedParams.value}&page=${pageNum}`;
      } else if (mode === "explore" && feedParams?.type === 'tags') {
        endpoint = `/tags/initialize/`; // Corrected semantic endpoint per plan
        options = { method: 'POST', body: { selected_tags: feedParams.value } };
        // Assuming POST returns a ready feed immediately
      } else if (mode === "inbox") {
        endpoint = `/clips/${feedParams.clipId}/`;
      }

      const data = await apiClient(endpoint, options);
      
      if (Array.isArray(data)) {
        setClips(prev => pageNum === 1 ? data : [...prev, ...data]);
        setHasMore(false); // Simple arrays don't have pagination
      } else if (data?.results) {
        setClips(prev => pageNum === 1 ? data.results : [...prev, ...data.results]);
        setHasMore(!!data.next);
      } else if (data?.id) {
        setClips([data]);
        setHasMore(false);
      } else {
        if (pageNum === 1) setClips([]);
        setHasMore(false);
      }
    } catch (err) {
      if (pageNum === 1) setError(err.message || 'Failed to initialize frequency.');
    } finally {
      setLoading(false);
    }
  }, [mode, feedParams]);

  useEffect(() => {
    setLoading(true);
    setPage(1);
    fetchClips(1);
  }, [fetchClips]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          const next = page + 1;
          setPage(next);
          fetchClips(next);
        }
      },
      { threshold: 0.1 }
    );
    if (loaderRef.current) observer.observe(loaderRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, page, fetchClips]);

  if (loading && page === 1) return <EmptyState icon={Loader2} title="Connecting..." message="Tuning into the frequency network." />;
  if (error) return <EmptyState icon={AlertCircle} title="Connection Severed" message={error} actionText="Retry" onAction={() => fetchClips(1)} />;
  if (clips.length === 0) return <EmptyState icon={ImageIcon} title="The void is silent." message="No clips found in this sector." actionText={onBack ? "Go Back" : "Refresh"} onAction={onBack || (() => fetchClips(1))} />;

  return (
    <div className="h-[100dvh] w-full bg-black flex flex-col relative">
      {onBack && (
        <button onClick={onBack} className="absolute top-12 left-4 z-50 p-3 bg-white/10 backdrop-blur-md rounded-full text-white cursor-pointer hover:bg-white/20 transition-colors border border-white/10 shadow-lg">
          <ChevronRight className="rotate-180" size={24} />
        </button>
      )}
      <div className="flex-1 w-full h-[100dvh] overflow-y-scroll snap-y snap-mandatory scrollbar-hide bg-gray-900 dark:bg-black">
        {clips.map(clip => (
          <ReelCard key={clip.id} clip={clip} onProfileClick={(id) => console.log('Navigate Profile', id)} />
        ))}
        {/* Infinite Scroll trigger */}
        <div ref={loaderRef} className="w-full h-24 flex items-center justify-center bg-transparent snap-start">
          {hasMore && <Loader2 className="animate-spin text-white" />}
        </div>
      </div>
    </div>
  );
};

// --- Explore Page ---
const ExplorePage = ({ onOpenFeed }) => {
  const [searchTags, setSearchTags] = useState([]);
  const [inputValue, setInputValue] = useState('');

  const handleAddTag = (e) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      if (!searchTags.includes(inputValue.trim())) setSearchTags([...searchTags, inputValue.trim()]);
      setInputValue('');
    }
  };

  return (
    <div className="h-full pt-12 md:pt-16 px-4 md:px-8 overflow-y-auto">
      <h1 className="text-3xl font-black tracking-tight mb-8 text-gray-900 dark:text-white">Explore</h1>

      <section className="mb-12">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-4">Curated Frequencies</h2>
        <div className="flex flex-wrap gap-3">
          {CATEGORIES.map(cat => (
            <button 
              key={cat}
              onClick={() => onOpenFeed({ type: 'category', value: cat })}
              className="px-6 py-3.5 rounded-xl bg-white dark:bg-[#121820] border border-gray-200 dark:border-white/5 font-semibold capitalize shadow-sm hover:shadow-md transition-all cursor-pointer text-gray-800 dark:text-gray-200 hover:border-blue-500 dark:hover:border-cyan-400"
            >
              {cat}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-4">Acoustic Tags</h2>
        <div className="bg-white dark:bg-[#121820] rounded-2xl p-4 border border-gray-200 dark:border-white/5 shadow-sm">
          <div className="flex flex-wrap gap-2 mb-3">
            {searchTags.map((tag, i) => (
              <span key={i} className="flex items-center space-x-1 px-3 py-1.5 bg-blue-100 dark:bg-cyan-900/30 text-blue-800 dark:text-cyan-400 rounded-lg text-sm font-medium">
                <span>#{tag}</span>
                <button onClick={() => setSearchTags(searchTags.filter((_, idx) => idx !== i))} className="cursor-pointer hover:text-black dark:hover:text-white ml-1">
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input 
              type="text" 
              placeholder="Type a tag and press Enter..." 
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleAddTag}
              className="w-full bg-transparent border-none focus:ring-0 text-sm pl-10 py-2 outline-none text-gray-900 dark:text-white placeholder-gray-400"
            />
          </div>
        </div>

        <button 
          onClick={() => onOpenFeed({ type: 'tags', value: searchTags })}
          disabled={searchTags.length === 0}
          className="w-full mt-6 py-4 rounded-xl font-bold transition-all disabled:opacity-50 bg-blue-600 dark:bg-cyan-400 text-white dark:text-black shadow-lg cursor-pointer hover:opacity-90 flex justify-center"
        >
          Generate Feed
        </button>
      </section>
    </div>
  );
};

// --- Inbox Page ---
const InboxPage = ({ onOpenClip }) => {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchInbox = async () => {
    try {
      const data = await apiClient('/share/inbox/');
      setEvents(data?.results || data || []);
    } catch (err) {
      setError('Failed to sync inbox.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchInbox(); }, []);

  const handleOpen = async (item) => {
    if (!item.is_read) {
      try {
        await apiClient(`/share/${item.id}/mark-read/`, { method: 'PATCH' });
        setEvents(prev => prev.map(e => e.id === item.id ? { ...e, is_read: true } : e));
      } catch(e) {}
    }
    onOpenClip({ type: 'clip', clipId: item.clip?.id });
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    try {
      await apiClient(`/share/${id}/share-delete/`, { method: 'DELETE' });
      setEvents(prev => prev.filter(e => e.id !== id));
    } catch(err) {
      alert("Failed to delete event.");
    }
  };

  if (loading) return <EmptyState icon={Loader2} title="Syncing..." />;
  if (error) return <EmptyState icon={AlertCircle} title="Error" message={error} actionText="Retry" onAction={fetchInbox} />;
  if (events.length === 0) return <EmptyState icon={Bell} title="Inbox Zero" message="No incoming transmissions." />;

  return (
    <div className="h-full pt-12 md:pt-16 px-4 md:px-8 overflow-y-auto">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-black tracking-tight text-gray-900 dark:text-white">Inbox</h1>
        <div className="px-3 py-1 bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 rounded-full text-xs font-bold tracking-wider">
          {events.filter(e => !e.is_read).length} NEW
        </div>
      </div>

      <div className="space-y-4 pb-24">
        {events.map((item) => (
          <div key={item.id} className={cn("w-full flex items-center p-4 rounded-2xl border transition-all cursor-pointer text-left group", !item.is_read ? "bg-white dark:bg-[#121820] border-blue-200 dark:border-cyan-400/30 shadow-sm" : "bg-transparent border-gray-200 dark:border-white/5 opacity-70 hover:opacity-100")} onClick={() => handleOpen(item)}>
            <div className="w-12 h-12 rounded-xl bg-gray-200 dark:bg-black/50 border border-gray-300 dark:border-white/5 mr-4 flex-shrink-0 flex items-center justify-center relative overflow-hidden">
              {item.clip?.cover_image ? <img src={item.clip.cover_image} className="w-full h-full object-cover" alt="Cover" /> : <ImageIcon size={20} className="text-gray-400" />}
              {!item.is_read && <div className="absolute top-1 right-1 w-2.5 h-2.5 bg-blue-500 dark:bg-cyan-400 rounded-full shadow-[0_0_8px_rgba(34,211,238,0.8)]"></div>}
            </div>
            
            <div className="flex-1 overflow-hidden pr-2">
              <p className="text-sm font-semibold mb-0.5 truncate text-gray-900 dark:text-gray-100">
                <span className="font-bold">{item.sender?.username || 'Someone'}</span> shared a clip
              </p>
              <p className="text-xs text-gray-500 truncate">"{item.clip?.title || 'Unknown Audio'}"</p>
            </div>
            
            <button onClick={(e) => handleDelete(e, item.id)} className="p-2 text-gray-400 hover:text-red-500 transition-colors md:opacity-0 md:group-hover:opacity-100">
              <Trash2 size={18} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- Create Page (Web Audio API Waveform + Multipart POST) ---
const CreatePage = ({ onComplete }) => {
  const [formData, setFormData] = useState({ name: '', description: '', category: '' });
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const canvasRef = useRef(null);

  const drawWaveform = async (audioFile) => {
    try {
      const arrayBuffer = await audioFile.arrayBuffer();
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      const rawData = audioBuffer.getChannelData(0); // Only use first channel
      const samples = 100; // Granularity
      const blockSize = Math.floor(rawData.length / samples);
      const filteredData = [];
      for (let i = 0; i < samples; i++) {
        let blockStart = blockSize * i;
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum = sum + Math.abs(rawData[blockStart + j]); 
        }
        filteredData.push(sum / blockSize);
      }
      
      // Draw
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#22d3ee'; // Cyan
      
      const multiplier = Math.max(...filteredData);
      filteredData.forEach((item, index) => {
        const x = canvas.width / samples * index;
        const height = (item / multiplier) * canvas.height;
        const y = (canvas.height / 2) - (height / 2);
        ctx.fillRect(x, y, (canvas.width / samples) - 1, Math.max(2, height));
      });
    } catch(e) { console.error("Waveform generation failed", e); }
  };

  const handleFile = (e) => {
    const selected = e.target.files[0];
    if (selected && selected.type.startsWith('audio/')) {
      setFile(selected);
      drawWaveform(selected);
      setError(null);
    } else {
      setError("Please select a valid audio file.");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return setError("Audio file is mandatory.");
    
    setLoading(true); setError(null);
    try {
      const formPayload = new FormData();
      formPayload.append('original_file', file);
      formPayload.append('title', formData.name);
      formPayload.append('description', formData.description);
      formPayload.append('category', formData.category);

      await apiClient('/clips/', { method: 'POST', body: formPayload });
      onComplete();
    } catch (err) {
      setError(err.message || 'Upload failed. Check file size limits.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full pt-12 md:pt-16 px-4 md:px-8 overflow-y-auto">
      <h1 className="text-3xl font-black tracking-tight mb-8 text-gray-900 dark:text-white">Upload</h1>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-500/30 flex items-start space-x-2">
          <AlertCircle size={20} className="flex-shrink-0" />
          <span className="text-sm font-semibold">{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 pb-24">
        <label className="w-full relative h-48 border-2 border-dashed border-gray-300 dark:border-white/20 rounded-3xl p-8 flex flex-col items-center justify-center bg-white dark:bg-[#121820] cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5 transition-colors overflow-hidden">
          {file ? (
            <canvas ref={canvasRef} width={400} height={100} className="absolute inset-0 w-full h-full opacity-60 z-0" />
          ) : (
            <UploadCloud size={48} className="text-blue-500 dark:text-cyan-400 mb-4 z-10" />
          )}
          <div className="z-10 flex flex-col items-center bg-white/80 dark:bg-black/60 px-4 py-2 rounded-xl backdrop-blur-sm">
            <p className="font-bold text-gray-900 dark:text-white">{file ? file.name : 'Tap to browse audio'}</p>
            <p className="text-xs text-gray-500 mt-1">WAV, MP3, FLAC (Max 50MB)</p>
          </div>
          <input type="file" accept="audio/*" onChange={handleFile} className="hidden" />
        </label>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Clip Name</label>
            <input required type="text" value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} className="w-full bg-white dark:bg-[#121820] border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-cyan-400 text-gray-900 dark:text-white" />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Description</label>
            <textarea value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} className="w-full bg-white dark:bg-[#121820] border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-cyan-400 resize-none h-24 text-gray-900 dark:text-white" />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">Mandatory Category</label>
            <select required value={formData.category} onChange={(e) => setFormData({...formData, category: e.target.value})} className="w-full bg-white dark:bg-[#121820] border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 dark:focus:border-cyan-400 text-gray-900 dark:text-white appearance-none">
              <option value="" disabled>Select a category...</option>
              {CATEGORIES.map(cat => <option key={cat} value={cat} className="capitalize">{cat}</option>)}
            </select>
          </div>
        </div>

        <button type="submit" disabled={loading} className="w-full py-4 rounded-xl font-bold transition-all disabled:opacity-50 bg-blue-600 dark:bg-cyan-400 text-white dark:text-black shadow-lg cursor-pointer hover:opacity-90 flex justify-center items-center">
          {loading ? <Loader2 className="animate-spin" size={24} /> : 'Publish Sequence'}
        </button>
      </form>
    </div>
  );
};

// --- Profile Page ---
const ProfilePage = () => {
  const { theme, toggleTheme } = useContext(ThemeContext);
  const { user, setUser, logout } = useContext(AuthContext);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState('');
  const [activeTab, setActiveTab] = useState('Uploads');
  
  // Tab Data (reusing components)
  const [tabData, setTabData] = useState([]);
  const [tabLoading, setTabLoading] = useState(false);

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const data = await apiClient('/profile/me/');
        setProfile(data);
        setEditName(data?.username || user?.username || '');
        setTabData(data?.clips || []); // Default tab is Uploads
      } catch (err) {
        // Fallback if backend /profile/me/ isn't fully implemented yet
        setProfile({ ...user, total_uploads: 0, followers_count: 0, following_count: 0 });
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, [user]);

  // Tab switching logic
  useEffect(() => {
    const fetchTabData = async () => {
      if (!profile) return;
      setTabLoading(true);
      try {
        if (activeTab === 'Uploads') {
          const res = await apiClient('/clips/?user=me'); // Presumed endpoint
          setTabData(res?.results || res || []);
        } else if (activeTab === 'Liked') {
           // Liked clips array from OwnProfileSerializer
          setTabData(profile.liked_clips || []);
        }
      } catch(e) { setTabData([]); } finally { setTabLoading(false); }
    };
    fetchTabData();
  }, [activeTab, profile]);

  const handleUpdateName = async () => {
    try {
      const updated = await apiClient('/profile/me/update/', { method: 'PATCH', body: { username: editName } });
      setProfile(updated);
      setUser(updated); // Sync global auth context
      setEditMode(false);
    } catch(err) { alert("Failed to update profile."); }
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('profile_picture', file);
    try {
      const updated = await apiClient('/profile/me/update/', { method: 'PATCH', body: fd });
      setProfile(updated);
      setUser(updated);
    } catch(err) { alert("Avatar upload failed."); }
  };

  if (loading) return <EmptyState icon={Loader2} title="Syncing Identity..." />;

  return (
    <div className="h-full pt-12 md:pt-16 overflow-y-auto">
      <div className="px-4 md:px-8 flex items-start justify-between mb-8">
        <div className="flex items-center space-x-4">
          <label className="w-24 h-24 rounded-full bg-gray-200 dark:bg-gray-800 border-2 border-white dark:border-[#0B0F14] shadow-xl relative overflow-hidden group cursor-pointer">
            {profile?.profile_picture ? <img src={profile.profile_picture} alt="Profile" className="w-full h-full object-cover" /> : <User size={40} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-400" />}
            <div className="absolute inset-0 bg-black/60 hidden group-hover:flex items-center justify-center text-white backdrop-blur-sm transition-all"><UploadCloud size={24} /></div>
            <input type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
          </label>
          
          <div>
            <div className="flex items-center space-x-3">
              {editMode ? (
                <div className="flex space-x-2">
                   <input type="text" value={editName} onChange={e=>setEditName(e.target.value)} className="bg-white dark:bg-black/50 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white shadow-sm focus:outline-none focus:border-blue-500 dark:focus:border-cyan-400" />
                   <button onClick={handleUpdateName} className="text-green-500 hover:text-green-600 cursor-pointer"><Check size={20} /></button>
                </div>
              ) : (
                <>
                  <h1 className="text-3xl font-black tracking-tight text-gray-900 dark:text-white">{profile?.username || 'User'}</h1>
                  <button onClick={() => setEditMode(true)} className="text-gray-400 hover:text-blue-600 dark:hover:text-cyan-400 cursor-pointer transition-colors"><Edit3 size={18} /></button>
                </>
              )}
            </div>
            <p className="text-sm font-medium text-gray-500 mt-1">{profile?.email || ''}</p>
          </div>
        </div>

        <div className="flex space-x-2">
          <button onClick={toggleTheme} className="p-3 rounded-full bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 cursor-pointer hover:bg-gray-100 dark:hover:bg-white/10 transition-colors shadow-sm">
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <button onClick={logout} className="p-3 rounded-full bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 cursor-pointer hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors shadow-sm">
            <LogOut size={20} />
          </button>
        </div>
      </div>

      <div className="px-4 md:px-8 flex justify-between border-b border-gray-200 dark:border-white/5 pb-8 mb-6">
        <div className="text-center flex-1">
          <p className="text-2xl font-black text-gray-900 dark:text-white">{profile?.total_uploads || 0}</p>
          <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mt-1">Uploads</p>
        </div>
        <div className="text-center flex-1">
          <p className="text-2xl font-black text-gray-900 dark:text-white">{profile?.followers_count || 0}</p>
          <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mt-1">Followers</p>
        </div>
        <div className="text-center flex-1">
          <p className="text-2xl font-black text-gray-900 dark:text-white">{profile?.following_count || 0}</p>
          <p className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mt-1">Following</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-4 md:px-8 flex space-x-6 border-b border-gray-200 dark:border-white/5 mb-6">
        {['Uploads', 'Liked'].map(tab => (
          <button 
            key={tab} 
            onClick={() => setActiveTab(tab)} 
            className={cn("pb-4 text-sm font-bold uppercase tracking-wider transition-colors relative", activeTab === tab ? "text-blue-600 dark:text-cyan-400" : "text-gray-500 hover:text-gray-900 dark:hover:text-gray-300")}
          >
            {tab}
            {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.5)]" />}
          </button>
        ))}
      </div>

      <div className="px-4 md:px-8 pb-24">
        {tabLoading ? (
           <div className="w-full flex justify-center py-8"><Loader2 className="animate-spin text-gray-400" /></div>
        ) : tabData.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400 bg-white dark:bg-[#121820] rounded-3xl border border-dashed border-gray-200 dark:border-white/10">
            {activeTab === 'Uploads' ? 'No tracks broadcasted yet.' : 'No acoustic resonance found.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {tabData.map(clip => (
              <div key={clip.id} className="aspect-[3/4] bg-gray-200 dark:bg-gray-900 rounded-2xl p-4 flex flex-col justify-end relative overflow-hidden border border-gray-200 dark:border-white/5 cursor-pointer group shadow-sm">
                 {clip.cover_image ? <img src={clip.cover_image} alt="Cover" className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-80 group-hover:scale-105 transition-all duration-500" /> : <ImageIcon size={32} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-400 opacity-20" />}
                 <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent"></div>
                 <div className="relative z-10 text-white">
                   <h3 className="font-bold text-sm truncate drop-shadow-md">{clip.title}</h3>
                   <div className="flex items-center justify-between mt-1">
                      <p className="text-[10px] uppercase font-bold tracking-widest text-gray-300 drop-shadow-sm">{clip.category}</p>
                      <div className="flex items-center space-x-1 text-xs font-semibold"><Heart size={10}/> <span>{clip.likes_count||0}</span></div>
                   </div>
                 </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// APP ENTRY / LAYOUT ROUTER
// ============================================================================
export default function App() {
  const [activeTab, setActiveTab] = useState('feed');
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <AuthProvider>
        <AuthContext.Consumer>
          {({ isAuthenticated }) => !isAuthenticated ? (
            <AuthScreen />
          ) : (
            <PlayerProvider>
              <div className="min-h-screen w-full font-sans antialiased bg-gray-100 text-gray-900 dark:bg-black dark:text-gray-100 transition-colors duration-300 flex justify-center">
                <div className="w-full h-[100dvh] flex relative bg-white dark:bg-[#0B0F14] overflow-hidden shadow-2xl transition-colors duration-300">
                  <ResponsiveNav activeTab={activeTab} setActiveTab={setActiveTab} />
                  <main className="flex-1 overflow-y-auto relative md:ml-64 flex justify-center pb-16 md:pb-0 bg-white dark:bg-[#0B0F14]">
                    <div className={cn("w-full h-full transition-all", (activeTab === 'feed' || activeTab.endsWith('_viewer')) ? "max-w-md border-x border-gray-200 dark:border-white/5 bg-black relative z-10" : "max-w-5xl mx-auto md:px-4")}>
                      
                      {activeTab === 'feed' && <FeedPage />}
                      {activeTab === 'explore' && <ExplorePage onOpenFeed={(params) => setActiveTab({ name: 'explore_viewer', params })} />}
                      {activeTab.name === 'explore_viewer' && <FeedPage mode="explore" feedParams={activeTab.params} onBack={() => setActiveTab('explore')} />}
                      
                      {activeTab === 'create' && <CreatePage onComplete={() => setActiveTab('feed')} />}
                      
                      {activeTab === 'inbox' && <InboxPage onOpenClip={(params) => setActiveTab({ name: 'inbox_viewer', params })} />}
                      {activeTab.name === 'inbox_viewer' && <FeedPage mode="inbox" feedParams={activeTab.params} onBack={() => setActiveTab('inbox')} />}
                      
                      {activeTab === 'profile' && <ProfilePage />}
                      
                    </div>
                  </main>
                </div>
              </div>
            </PlayerProvider>
          )}
        </AuthContext.Consumer>
      </AuthProvider>
    </ThemeContext.Provider>
  );
}