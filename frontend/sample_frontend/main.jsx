import { useState, useEffect, useContext, createContext, useRef, useCallback, useMemo } from "react"
import {
  Heart, MessageCircle, Share2, Play, Pause, Home, Compass, Plus,
  Bell, User, X, Upload, Music, Moon, Sun, ArrowLeft, Check,
  Send, Settings, AlertCircle, Headphones, Search, RefreshCw,
  ChevronRight, MoreVertical, Mic, Radio, Wifi, WifiOff,
  SkipForward, Volume2, Zap, TrendingUp, Clock, Star
} from "lucide-react"

/* ─────────────────────────────────────────
   GLOBAL STYLES + FONTS
───────────────────────────────────────── */
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800;900&family=DM+Sans:wght@300;400;500;600&display=swap');

  :root {
    --bg0: #040810;
    --bg1: #080F1C;
    --bg2: #0C1525;
    --bg3: #111E30;
    --bg4: #1A2D44;
    --cyan: #00D4FF;
    --cyan-dim: rgba(0,212,255,0.12);
    --cyan-glow: rgba(0,212,255,0.25);
    --violet: #7C3AED;
    --violet-dim: rgba(124,58,237,0.15);
    --like: #FF4D6D;
    --green: #00E5A0;
    --amber: #F59E0B;
    --text0: #E8F4F8;
    --text1: #8BAFC0;
    --text2: #3D5A6E;
    --border: rgba(0,212,255,0.08);
    --border-strong: rgba(0,212,255,0.18);
    --ff-display: 'Barlow Condensed', sans-serif;
    --ff-body: 'DM Sans', sans-serif;
    --radius: 14px;
  }
  [data-theme="light"] {
    --bg0: #F0F6FA;
    --bg1: #FFFFFF;
    --bg2: #EBF3F9;
    --bg3: #DDE9F2;
    --bg4: #C8D9E8;
    --cyan: #0099BB;
    --cyan-dim: rgba(0,153,187,0.1);
    --cyan-glow: rgba(0,153,187,0.2);
    --text0: #0A1929;
    --text1: #3D5A6E;
    --text2: #8BAFC0;
    --border: rgba(0,153,187,0.1);
    --border-strong: rgba(0,153,187,0.25);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }
  body, #root {
    background: var(--bg0);
    color: var(--text0);
    font-family: var(--ff-body);
    min-height: 100vh;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }
  input, button, textarea, select { font-family: var(--ff-body); }
  button { cursor: pointer; }
  ::-webkit-scrollbar { width: 3px; height: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--text2); border-radius: 2px; }

  @keyframes fadeUp   { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  @keyframes slideUp  { from { transform:translateY(100%); }           to { transform:translateY(0); } }
  @keyframes spin     { to { transform:rotate(360deg); } }
  @keyframes pulse    { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
  @keyframes scanline { 0% { transform:translateY(-100%); } 100% { transform:translateY(100vh); } }
  @keyframes waveBar  { 0%,100% { transform:scaleY(0.25); } 50% { transform:scaleY(1); } }
  @keyframes glow     { 0%,100% { box-shadow:0 0 8px var(--cyan-glow); } 50% { box-shadow:0 0 20px var(--cyan-glow), 0 0 40px var(--cyan-dim); } }
  @keyframes ripple   { 0% { transform:scale(1); opacity:0.6; } 100% { transform:scale(2.5); opacity:0; } }

  .fade-up   { animation: fadeUp  0.3s ease forwards; }
  .slide-up  { animation: slideUp 0.32s cubic-bezier(.22,.61,.36,1) forwards; }

  .wave-bar { animation: waveBar 1s ease-in-out infinite; transform-origin: bottom; }
  .wave-bar:nth-child(1) { animation-delay:0s;    }
  .wave-bar:nth-child(2) { animation-delay:0.12s; }
  .wave-bar:nth-child(3) { animation-delay:0.24s; }
  .wave-bar:nth-child(4) { animation-delay:0.36s; }
  .wave-bar:nth-child(5) { animation-delay:0.24s; }
  .wave-bar:nth-child(6) { animation-delay:0.12s; }
  .wave-bar:nth-child(7) { animation-delay:0s;    }

  .scan-line {
    position:fixed; top:0; left:0; right:0; height:2px;
    background:linear-gradient(90deg,transparent,rgba(0,212,255,0.06),transparent);
    animation:scanline 8s linear infinite;
    pointer-events:none; z-index:9999;
  }
  .glow-ring { animation: glow 2s ease-in-out infinite; }
  .card-hover { transition: transform 0.2s ease, box-shadow 0.2s ease; }
  .card-hover:hover { transform: translateY(-1px); box-shadow: 0 8px 32px rgba(0,0,0,0.4); }

  @keyframes toastIn  { from { opacity:0; transform:translateX(110%); } to { opacity:1; transform:translateX(0); } }
  @keyframes toastOut { from { opacity:1; transform:translateX(0); } to { opacity:0; transform:translateX(110%); } }
  @keyframes shimmer  { 0% { background-position:-400px 0; } 100% { background-position:400px 0; } }
  @keyframes popIn    { 0% { transform:scale(0.8); opacity:0; } 70% { transform:scale(1.05); } 100% { transform:scale(1); opacity:1; } }
  @keyframes slideRight { from { transform:translateX(-18px); opacity:0; } to { transform:translateX(0); opacity:1; } }
  @keyframes miniUp   { from { transform:translateY(80px); opacity:0; } to { transform:translateY(0); opacity:1; } }
  @keyframes pageIn   { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  @keyframes miniDown { from { transform:translateY(-80px); opacity:0; } to { transform:translateY(0); opacity:1; } }

  .skeleton {
    background: linear-gradient(90deg, var(--bg2) 25%, var(--bg3) 50%, var(--bg2) 75%);
    background-size: 800px 100%;
    animation: shimmer 1.4s infinite linear;
    border-radius: 8px;
  }
  .pop-in  { animation: popIn      0.35s cubic-bezier(.34,1.56,.64,1) forwards; }
  .slide-r { animation: slideRight 0.25s ease forwards; }
  .mini-up { animation: miniUp     0.3s  cubic-bezier(.22,.61,.36,1) forwards; }
  .mini-down { animation: miniDown 0.3s cubic-bezier(.22,.61,.36,1) forwards; }
  .page-in { animation: pageIn     0.28s ease forwards; }
`

/* ─────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────── */
const API_BASE = "http://localhost:8005"
const CATEGORIES = ["instrumental","funny","news","science","music"]
const CAT_COLORS = {
  instrumental: "#00D4FF", funny: "#F59E0B",
  news: "#60A5FA",         science: "#00E5A0",
  music: "#FF4D6D"
}

/* ─────────────────────────────────────────
   API LAYER
───────────────────────────────────────── */
const tok = {
  get:     ()    => sessionStorage.getItem("ef_access"),
  set:     (t)   => sessionStorage.setItem("ef_access", t),
  setRef:  (t)   => sessionStorage.setItem("ef_refresh", t),
  getRef:  ()    => sessionStorage.getItem("ef_refresh"),
  clear:   ()    => { sessionStorage.removeItem("ef_access"); sessionStorage.removeItem("ef_refresh") }
}

async function api(path, opts = {}) {
  const headers = { "Content-Type":"application/json", ...opts.headers }
  if (tok.get()) headers["Authorization"] = `Bearer ${tok.get()}`
  if (opts.body instanceof FormData) delete headers["Content-Type"]

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers }).catch(() => {
    throw { status:0, message:"Network error — is the backend running?" }
  })

  // ... inside api() function
if (res.status === 401) {
  const ref = tok.getRef()
  if (ref) {
    try {
      const r = await fetch(`${API_BASE}/auth/token/refresh/`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ refresh: ref })
      })
      if (r.ok) { const d = await r.json(); tok.set(d.access); return api(path, opts) }
    } catch {}
  }
  
  // NEW: Clear tokens and broadcast event
  tok.clear();
  window.dispatchEvent(new CustomEvent("ef_session_expired"));
  
  throw { status:401, message:"Session expired — please sign in again" }

  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw { status:res.status, message: data.detail || data.error || "Request failed", errors:data }
  return data
}

const API = {
  login:          (e,p)    => api("/auth/login/",           { method:"POST", body:JSON.stringify({username:e,password:p}) }),
  register:       (e,u,p)  => api("/auth/register/",        { method:"POST", body:JSON.stringify({email:e,username:u,password:p}) }),
  getFeed:        ()       => api("/feed/"),
  getSuggestions: (cat)    => api(`/suggestions/?category=${cat}`),
  initTags:       (tags)   => api("/tags/initialize/",      { method:"POST", body:JSON.stringify({selected_tags:tags}) }),
  uploadClip:     (fd)     => api("/clips/",                { method:"POST", body:fd }),
  toggleLike:     (id)     => api(`/interactions/${id}/toggle-like/`,    { method:"POST" }),
  skipClip:       (id,d)   => api(`/interactions/${id}/register-skip/`,  { method:"POST", body:JSON.stringify(d) }),
  logTelemetry:   (id,d)   => api(`/interactions/${id}/log-telemetry/`,  { method:"POST", body:JSON.stringify(d) }),
  getComments:    (cid)    => api(`/comments/?clip=${cid}`),
  postComment:    (d)      => api("/comments/",             { method:"POST", body:JSON.stringify(d) }),
  getInbox:       ()       => api("/share/inbox/"),
  getUnread:      ()       => api("/share/unread-count/"),
  sendShare:      (id,rid) => api(`/share/${id}/send-share/`, { method:"POST", body:JSON.stringify({receiver_id:rid}) }),
  markRead:       (id)     => api(`/share/${id}/mark-read/`,  { method:"PATCH" }),
  deleteShare:    (id)     => api(`/share/${id}/share-delete/`, { method:"DELETE" }),
  toggleFollow:   (uid)    => api(`/follow/${uid}/toggle-follow/`, { method:"POST" }),
  getMyProfile:   ()       => api("/profile/me/"),
  getProfile:     (id)     => api(`/profile/${id}/`),
  getUserClips:   (id)     => api(`/profile/${id}/clips/`),
  updateProfile:  (fd)     => api("/profile/me/update/",    { method:"PATCH", body:fd }),
  findUser: (username) => api(`/share/find-user/?username=${encodeURIComponent(username)}`),
}

/* ─────────────────────────────────────────
   CONTEXTS
───────────────────────────────────────── */
const AuthCtx   = createContext(null)
const PlayerCtx = createContext(null)
const ThemeCtx  = createContext(null)
const NavCtx    = createContext(null)


const useAuth   = () => useContext(AuthCtx)
const usePlayer = () => useContext(PlayerCtx)
const useTheme  = () => useContext(ThemeCtx)
const useNav    = () => useContext(NavCtx)

function AuthProvider({ children }) {
  const [user, setUser] = useState(() => { try { return JSON.parse(sessionStorage.getItem("ef_user")||"null") } catch { return null } })
  const [authed, setAuthed] = useState(() => !!tok.get())

  const login = async (username, password) => {
  const d = await API.login(username, password)
  tok.set(d.access); tok.setRef(d.refresh)
  sessionStorage.setItem("ef_user", JSON.stringify(d.user))
  setUser(d.user); setAuthed(true)
  }
  const register = async (email, username, password) => {
    const d = await API.register(email, username, password)
    tok.set(d.access); tok.setRef(d.refresh)
    sessionStorage.setItem("ef_user", JSON.stringify(d.user))
    setUser(d.user); setAuthed(true)
  }
  const logout = useCallback(() => {tok.clear();sessionStorage.removeItem("ef_user");setUser(null);setAuthed(false);}, []);
  useEffect(() => {const handleExpiration = () => logout();
    window.addEventListener("ef_session_expired", handleExpiration);
    return () => window.removeEventListener("ef_session_expired", handleExpiration);
  }, [logout]);
  const patchUser = (p) => { const u = {...user,...p}; sessionStorage.setItem("ef_user",JSON.stringify(u)); setUser(u) }

  return <AuthCtx.Provider value={{user,authed,login,register,logout,patchUser}}>{children}</AuthCtx.Provider>
}

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem("ef_theme")||"dark")
  useEffect(() => { document.documentElement.setAttribute("data-theme",theme); localStorage.setItem("ef_theme",theme) }, [theme])
  const toggle = () => setTheme(t => t==="dark"?"light":"dark")
  return <ThemeCtx.Provider value={{theme,toggle}}>{children}</ThemeCtx.Provider>
}

function PlayerProvider({ children }) {
  // 1. Hook into the Auth context to monitor login status
  const { authed } = useAuth() 

  const [active, setActive]     = useState(null)
  const [playing, setPlaying]   = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const audioRef = useRef(null)
  const hlsRef   = useRef(null)
  const startRef = useRef(null)

  const kill = useCallback(() => {
    hlsRef.current?.destroy(); hlsRef.current = null
  }, [])

  const pause = useCallback(() => { 
    audioRef.current?.pause(); 
    setPlaying(false) 
  }, [])

  // 2. ADD THIS EFFECT: Force-stop audio when the user logs out
  useEffect(() => {
    if (!authed) {
      pause();
      setActive(null);
      setProgress(0);
    }
  }, [authed, pause]);

  const play = useCallback(async (clip) => {
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current

    if (active?.id === clip.id) {
      if (playing) { a.pause(); setPlaying(false) }
      else { a.play().catch(()=>{}); setPlaying(true); startRef.current = Date.now() }
      return
    }

    kill(); a.pause()
    setActive(clip); setProgress(0); setDuration(0)
    startRef.current = Date.now()

    const src = clip.hls_playlist_url
      ? (clip.hls_playlist_url.startsWith("http") ? clip.hls_playlist_url : `${API_BASE}${clip.hls_playlist_url}`)
      : null

    if (!src) return

    if (window.Hls?.isSupported()) {
      const hls = new window.Hls({ startLevel:-1 })
      hls.loadSource(src); hls.attachMedia(a)
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { a.play().catch(()=>{}); setPlaying(true) })
      hlsRef.current = hls
    } else if (a.canPlayType("application/vnd.apple.mpegurl")) {
      a.src = src; a.play().catch(()=>{}); setPlaying(true)
    } else {
      a.src = src; a.play().catch(()=>{}); setPlaying(true)
    }

    a.ontimeupdate = () => {
      setProgress(a.duration ? a.currentTime/a.duration : 0)
      setDuration(a.duration||0)
      if (a.buffered.length) setBuffered(a.buffered.end(a.buffered.length-1)/(a.duration||1))
    }
    a.onended = () => { setPlaying(false); setProgress(1) }
  }, [active, playing, kill])

  const seek  = useCallback((r) => { if (audioRef.current && duration) { audioRef.current.currentTime = r*duration; setProgress(r) } }, [duration])
  const listenMs = useCallback(() => startRef.current ? Date.now()-startRef.current : 0, [])

  useEffect(() => {
    if (!window.Hls) {
      const s = document.createElement("script")
      s.src = "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"
      document.head.appendChild(s)
    }
    return kill
  }, [kill])

  return (
    <PlayerCtx.Provider value={{active,playing,progress,duration,buffered,play,pause,seek,listenMs}}>
      {children}
    </PlayerCtx.Provider>
  )
}

/* ─────────────────────────────────────────
   TOAST SYSTEM
───────────────────────────────────────── */
const ToastCtx = createContext(null)
const useToast = () => useContext(ToastCtx)

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const tid = useRef(0)

  const push = useCallback((msg, type="info", ms=3200) => {
    const id = ++tid.current
    setToasts(p=>[...p, {id, msg, type}])
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)), ms)
  }, [])

  const COLORS = { success:"var(--green)", error:"#FF4D6D", info:"var(--cyan)", warn:"var(--amber)" }
  const ICONS  = { success:"check", error:"!", info:"⚡", warn:"!" }

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div style={{position:"fixed",top:18,right:14,zIndex:9000,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>
        {toasts.map(t=>(
          <div key={t.id} style={{
            pointerEvents:"auto",
            display:"flex",alignItems:"center",gap:10,
            padding:"10px 16px",borderRadius:12,minWidth:200,maxWidth:300,
            background:"var(--bg2)",border:"1px solid "+COLORS[t.type]+"44",
            boxShadow:"0 4px 20px rgba(0,0,0,0.4)",
            animation:"toastIn 0.28s cubic-bezier(.22,.61,.36,1) forwards"
          }}>
            <span style={{color:COLORS[t.type],fontWeight:800,fontSize:13}}>{ICONS[t.type]}</span>
            <span style={{fontSize:13,color:"var(--text0)",lineHeight:1.4}}>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/* ─────────────────────────────────────────
   NETWORK BANNER
───────────────────────────────────────── */
function NetworkBanner() {
  const [online, setOnline] = useState(navigator.onLine)
  const [show,   setShow]   = useState(false)

  useEffect(()=>{
    const up   = ()=>{ setOnline(true);  setShow(true); setTimeout(()=>setShow(false),2500) }
    const down = ()=>{ setOnline(false); setShow(true) }
    window.addEventListener("online",  up)
    window.addEventListener("offline", down)
    return ()=>{ window.removeEventListener("online",up); window.removeEventListener("offline",down) }
  },[])

  if (!show) return null
  return (
    <div style={{
      position:"fixed",top:0,left:0,right:0,zIndex:8000,
      padding:"10px 16px",display:"flex",alignItems:"center",justifyContent:"center",gap:8,
      background: online ? "rgba(0,229,160,0.12)" : "rgba(255,77,109,0.12)",
      backdropFilter:"blur(10px)",
      borderBottom:"1px solid "+(online?"rgba(0,229,160,0.3)":"rgba(255,77,109,0.3)"),
      animation:"slideRight 0.25s ease"
    }}>
      <span style={{fontSize:12,fontWeight:600,color:online?"var(--green)":"#FF4D6D",letterSpacing:"0.05em"}}>
        {online ? "✔ BACK ONLINE" : "✕ NO CONNECTION — some features unavailable"}
      </span>
    </div>
  )
}

/* ─────────────────────────────────────────
   SKELETON LOADERS
───────────────────────────────────────── */
function ReelSkeleton() {
  return (
    <div style={{background:"var(--bg2)",borderRadius:18,overflow:"hidden",border:"1px solid var(--border)"}}>
      <div className="skeleton" style={{height:108,borderRadius:0}}/>
      <div style={{padding:"12px 14px 14px",display:"flex",flexDirection:"column",gap:10}}>
        <div className="skeleton" style={{height:18,width:"70%"}}/>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div className="skeleton" style={{width:26,height:26,borderRadius:"50%"}}/>
          <div className="skeleton" style={{height:12,width:"30%"}}/>
        </div>
        <div className="skeleton" style={{height:4,width:"100%",marginTop:4}}/>
        <div style={{display:"flex",gap:16}}>
          {[40,40,40].map((w,i)=><div key={i} className="skeleton" style={{height:12,width:w}}/>)}
        </div>
      </div>
    </div>
  )
}

function FeedSkeleton() {
  return (
    <div style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:14}}>
      {[1,2,3].map(i=><ReelSkeleton key={i}/>)}
    </div>
  )
}

/* ─────────────────────────────────────────
   MINI PLAYER
───────────────────────────────────────── */
function MiniPlayer() {
  const { active, playing, progress, play, pause } = usePlayer()
  const [vis, setVis] = useState(false)
  useEffect(()=>{ if(active) setVis(true) },[active])
  if (!vis || !active) return null
  const c = CAT_COLORS[active.category]||"var(--cyan)"
  return (
    <div className="mini-down" style={{
      // Removed bottom: 70, added top: 16
      position:"fixed", top:16, left:14, right:14, zIndex:190,
      background:"rgba(8,15,28,0.95)", backdropFilter:"blur(20px)",
      borderRadius:16, border:"1px solid "+c+"33",
      boxShadow:"0 8px 32px rgba(0,0,0,0.5)", overflow:"hidden"
    }}>
      <div style={{height:2,background:"var(--bg4)",position:"absolute",top:0,left:0,right:0}}>
        <div style={{height:"100%",width:(progress*100)+"%",background:"linear-gradient(90deg,"+c+",var(--violet))",transition:"width 0.1s linear"}}/>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px"}}>
        <div style={{width:40,height:40,borderRadius:10,flexShrink:0,background:c+"18",border:"1px solid "+c+"33",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <Headphones size={17} color={c}/>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <p style={{fontSize:13,fontWeight:600,color:"var(--text0)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"var(--ff-display)"}}>{active.title}</p>
          <p style={{fontSize:11,color:"var(--text1)",marginTop:1}}>{active.creator_name}</p>
        </div>
        {playing && <Waves on={true} color={c}/>}
        <button onClick={()=>playing?pause():play(active)} style={{
          width:36,height:36,borderRadius:18,border:"none",flexShrink:0,
          background:playing?c:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:playing?"0 0 12px "+c+"66":"none",transition:"all 0.2s"
        }}>
          {playing?<Pause size={14} fill="#000" color="#000"/>:<Play size={14} fill={c} color={c}/>}
        </button>
        <button onClick={()=>{pause();setVis(false)}} style={{width:28,height:28,borderRadius:14,border:"1px solid var(--border)",background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--text2)",flexShrink:0}}>
          <X size={12}/>
        </button>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────
   ONBOARDING MODAL
───────────────────────────────────────── */
function OnboardingModal({ onDone }) {
  const [step,    setStep]   = useState(0)
  const [selTags, setSelTags]= useState([])
  const [loading, setL]      = useState(false)
  const toast = useToast()

  const submit = async () => {
    if (step===0) { setStep(1); return }
    if (!selTags.length) { onDone(); return }
    setL(true)
    try { await API.initTags(selTags); toast("Feed personalized! Ready to flow","success") }
    catch { toast("Used default recommendations","warn") }
    finally { setL(false); onDone() }
  }

  return (
    <div style={{position:"fixed",inset:0,zIndex:7000,background:"rgba(0,0,0,0.9)",backdropFilter:"blur(16px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div className="pop-in" style={{width:"100%",maxWidth:360,background:"var(--bg1)",borderRadius:24,padding:32,border:"1px solid var(--border-strong)",boxShadow:"0 0 80px var(--cyan-glow)"}}>
        <div style={{display:"flex",gap:6,justifyContent:"center",marginBottom:28}}>
          {[0,1].map(i=>(
            <div key={i} style={{height:4,borderRadius:2,transition:"all 0.3s",width:i===step?24:8,background:i<=step?"var(--cyan)":"var(--bg4)"}}/>
          ))}
        </div>
        {step===0 ? (
          <div style={{textAlign:"center"}}>
            <div style={{width:72,height:72,borderRadius:22,margin:"0 auto 18px",background:"linear-gradient(135deg,var(--cyan-dim),var(--violet-dim))",border:"1px solid var(--border-strong)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <Headphones size={36} color="var(--cyan)"/>
            </div>
            <h2 style={{fontFamily:"var(--ff-display)",fontSize:26,fontWeight:900,letterSpacing:"0.04em",marginBottom:10}}>WELCOME TO ECHOFLOW</h2>
            <p style={{fontSize:14,color:"var(--text1)",lineHeight:1.6,marginBottom:28}}>TikTok for your ears. Short audio reels — comedy, music, science, news — no screen required.</p>
            <button onClick={submit} style={{width:"100%",padding:"14px",borderRadius:14,border:"none",background:"linear-gradient(135deg,var(--cyan),var(--violet))",color:"#000",fontFamily:"var(--ff-display)",fontSize:16,fontWeight:900,letterSpacing:"0.05em",cursor:"pointer",boxShadow:"0 4px 24px var(--cyan-glow)"}}>
              GET STARTED →
            </button>
          </div>
        ):(
          <div>
            <h2 style={{fontFamily:"var(--ff-display)",fontSize:22,fontWeight:900,letterSpacing:"0.04em",marginBottom:8,textAlign:"center"}}>PICK YOUR VIBES</h2>
            <p style={{fontSize:13,color:"var(--text1)",textAlign:"center",marginBottom:20}}>Select categories to personalize your feed</p>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center",marginBottom:24}}>
              {CATEGORIES.map(t=>{
                const sel=selTags.includes(t); const col=CAT_COLORS[t]
                return (
                  <button key={t} onClick={()=>setSelTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t])} style={{padding:"9px 18px",borderRadius:20,fontSize:12,fontWeight:700,letterSpacing:"0.04em",textTransform:"capitalize",background:sel?col+"18":"var(--bg2)",color:sel?col:"var(--text1)",border:sel?"1px solid "+col+"55":"1px solid var(--border)",transition:"all 0.2s",display:"flex",alignItems:"center",gap:5}}>
                    {sel&&"✓ "}{t}
                  </button>
                )
              })}
            </div>
            <button onClick={submit} disabled={loading} style={{width:"100%",padding:"14px",borderRadius:14,border:"none",background:"linear-gradient(135deg,var(--violet),var(--cyan))",color:"#000",fontFamily:"var(--ff-display)",fontSize:15,fontWeight:900,letterSpacing:"0.05em",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,boxShadow:"0 4px 24px var(--cyan-glow)"}}>
              {loading?<Spin size={16} color="#000"/>:(selTags.length?"START WITH "+selTags.length+" TAG"+(selTags.length!==1?"S":"")+" →":"SKIP FOR NOW →")}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────
   WAVEFORM PREVIEW
───────────────────────────────────────── */
function WaveformPreview({ file }) {
  const canvasRef = useRef(null)
  useEffect(()=>{
    if (!file||!canvasRef.current) return
    const ac = new (window.AudioContext||window.webkitAudioContext)()
    const reader = new FileReader()
    reader.onload = async e => {
      try {
        const buf = await ac.decodeAudioData(e.target.result.slice(0))
        const data = buf.getChannelData(0)
        const cv = canvasRef.current
        const W = cv.width, H = cv.height
        const cx = cv.getContext("2d")
        cx.clearRect(0,0,W,H)
        const step = Math.ceil(data.length/W), mid = H/2
        const g = cx.createLinearGradient(0,0,W,0)
        g.addColorStop(0,"#00D4FF"); g.addColorStop(1,"#7C3AED")
        cx.strokeStyle=g; cx.lineWidth=1.5
        for (const sign of [1,-1]) {
          cx.beginPath()
          for (let i=0;i<W;i++) {
            let mx=0
            for (let j=0;j<step;j++) mx=Math.max(mx,Math.abs(data[i*step+j]||0))
            const y=mid+sign*mx*mid*0.85
            i===0?cx.moveTo(i,y):cx.lineTo(i,y)
          }
          cx.stroke()
        }
      } catch {}
      ac.close()
    }
    reader.readAsArrayBuffer(file)
  },[file])
  if (!file) return null
  return (
    <div style={{padding:"8px 0 4px"}}>
      <p style={{fontSize:10,fontWeight:700,color:"var(--text2)",letterSpacing:"0.08em",marginBottom:6}}>WAVEFORM PREVIEW</p>
      <canvas ref={canvasRef} width={600} height={60} style={{width:"100%",height:60,borderRadius:8,background:"var(--bg3)",display:"block"}}/>
    </div>
  )
}

/* ─────────────────────────────────────────
   SHARED UI ATOMS
---------------------------------------------*/   
function Spin({ size=20, color="var(--cyan)" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{animation:"spin 0.7s linear infinite"}}>
      <circle cx="12" cy="12" r="10" fill="none" stroke={color} strokeWidth="2.5"
        strokeLinecap="round" strokeDasharray="50" strokeDashoffset="15"/>
    </svg>
  )
}

function Waves({ on, color="var(--cyan)" }) {
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:2,height:18}}>
      {[10,16,12,18,12,16,10].map((h,i) => (
        <div key={i} className={on?"wave-bar":""} style={{
          width:3, height:on?h:4, borderRadius:2,
          background:color, opacity:on?1:0.3,
          transition:"height 0.3s ease"
        }}/>
      ))}
    </div>
  )
}

function CatBadge({ category }) {
  const c = CAT_COLORS[category]||"var(--cyan)"
  return (
    <span style={{
      padding:"2px 9px",borderRadius:20,fontSize:10,fontWeight:700,
      letterSpacing:"0.06em",textTransform:"uppercase",
      background:`${c}18`,color:c
    }}>{category}</span>
  )
}

function Avatar({ src, name, size=36 }) {
  const url = src ? (src.startsWith("http")?src:`${API_BASE}${src}`) : null
  return (
    <div style={{
      width:size,height:size,borderRadius:"50%",overflow:"hidden",flexShrink:0,
      background:url?"transparent":"linear-gradient(135deg,var(--violet),var(--cyan))",
      display:"flex",alignItems:"center",justifyContent:"center",
      fontSize:size*.38,fontWeight:700,color:"#fff",
      border:"1.5px solid var(--border-strong)"
    }}>
      {url
        ? <img src={url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt={name} onError={e=>e.target.style.display="none"}/>
        : (name||"?")[0].toUpperCase()
      }
    </div>
  )
}

function EmptyBox({ icon:Icon, title, sub, action }) {
  return (
    <div className="fade-up" style={{textAlign:"center",padding:"56px 24px",display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
      <div style={{width:64,height:64,borderRadius:20,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <Icon size={28} color="var(--text2)"/>
      </div>
      <p style={{fontFamily:"var(--ff-display)",fontSize:18,fontWeight:700,color:"var(--text0)",letterSpacing:"0.02em"}}>{title}</p>
      <p style={{fontSize:13,color:"var(--text1)",maxWidth:220,lineHeight:1.5}}>{sub}</p>
      {action}
    </div>
  )
}

function ErrBox({ msg, retry }) {
  return (
    <div style={{textAlign:"center",padding:"56px 24px",display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
      <AlertCircle size={32} color="#FF4D6D"/>
      <p style={{fontSize:14,color:"var(--text1)"}}>{msg}</p>
      {retry && <Btn sm onClick={retry}>Retry</Btn>}
    </div>
  )
}

function Btn({ children, onClick, disabled, sm, ghost, danger, fill, style:s={}, ...rest }) {
  return (
    <button onClick={onClick} disabled={disabled} {...rest} style={{
      display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6,
      padding:sm?"6px 14px":"11px 22px",
      borderRadius:sm?20:12,
      fontSize:sm?12:14,fontWeight:600,
      border:ghost||danger?"1px solid "+(danger?"rgba(255,77,109,0.3)":"var(--border-strong)"):"none",
      background: disabled?"var(--bg3)"
        : fill?"linear-gradient(135deg,var(--cyan),var(--violet))"
        : danger?"rgba(255,77,109,0.1)"
        : ghost?"transparent"
        : "var(--bg3)",
      color: disabled?"var(--text2)"
        : fill?"#000"
        : danger?"#FF4D6D"
        : "var(--text0)",
      cursor:disabled?"default":"pointer",
      transition:"all 0.18s ease",
      fontFamily:"var(--ff-body)",
      ...s
    }}>
      {children}
    </button>
  )
}

const iStyle = {
  width:"100%",padding:"11px 14px",borderRadius:10,fontSize:14,
  background:"var(--bg2)",border:"1px solid var(--border)",
  color:"var(--text0)",outline:"none",transition:"border-color 0.2s",
  fontFamily:"var(--ff-body)"
}

/* ─────────────────────────────────────────
   AUDIO BAR COMPONENT
───────────────────────────────────────── */
function AudioBar({ clip }) {
  const { active, playing, progress, duration, buffered, play, pause, seek } = usePlayer()
  const isActive  = active?.id === clip.id
  const isPlaying = isActive && playing
  const pct       = isActive ? progress : 0
  const buf       = isActive ? buffered  : 0

  const fmt = (s) => {
    if (!s||isNaN(s)) return "0:00"
    return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`
  }

  return (
    <div style={{padding:"10px 14px 14px"}}>
      {/* Progress track */}
      <div onClick={e=>{
        if(!isActive)return
        const r=e.currentTarget.getBoundingClientRect()
        seek((e.clientX-r.left)/r.width)
      }} style={{
        position:"relative",height:4,borderRadius:2,background:"var(--bg4)",
        cursor:isActive?"pointer":"default",marginBottom:10,overflow:"hidden"
      }}>
        <div style={{position:"absolute",height:"100%",width:`${buf*100}%`,background:"var(--bg4)",filter:"brightness(1.6)",borderRadius:2,transition:"width 0.3s"}}/>
        <div style={{
          position:"absolute",height:"100%",width:`${pct*100}%`,
          background:"linear-gradient(90deg,var(--cyan),var(--violet))",
          borderRadius:2,transition:"width 0.1s linear",
          boxShadow:isPlaying?"0 0 6px var(--cyan-glow)":"none"
        }}/>
      </div>

      {/* Controls row */}
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <button onClick={()=>isPlaying?pause():play(clip)} style={{
          width:38,height:38,borderRadius:19,flexShrink:0,border:"none",
          background:isPlaying?"var(--cyan)":"var(--bg3)",
          display:"flex",alignItems:"center",justifyContent:"center",
          transition:"all 0.2s ease",
          boxShadow:isPlaying?"0 0 12px var(--cyan-glow)":"none"
        }}>
          {isPlaying
            ? <Pause size={14} fill="#000" color="#000"/>
            : <Play  size={14} fill={isActive?"var(--cyan)":"var(--text1)"} color={isActive?"var(--cyan)":"var(--text1)"}/>
          }
        </button>

        <div style={{flex:1}}>
          <Waves on={isPlaying} color={isPlaying?"var(--cyan)":"var(--text2)"}/>
        </div>

        <span style={{fontSize:11,color:"var(--text2)",fontVariantNumeric:"tabular-nums",letterSpacing:"0.03em"}}>
          {isActive ? `${fmt(duration*progress)} / ${fmt(duration)}` : "--:--"}
        </span>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────
   COMMENT SHEET
───────────────────────────────────────── */
function CommentSheet({ clipId, onClose }) {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [text, setText] = useState("")
  const [posting, setPosting] = useState(false)

  useEffect(()=>{
    API.getComments(clipId)
      .then(d=>{setItems(d.results||d||[]);setLoading(false)})
      .catch(e=>{setErr(e.message);setLoading(false)})
  },[clipId])

  const post = async () => {
    if(!text.trim()||posting) return
    setPosting(true)
    try { const c=await API.postComment({clip:clipId,text:text.trim()}); setItems(p=>[c,...p]); setText("") }
    catch(e) { alert(e.message) }
    finally { setPosting(false) }
  }

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:800,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",display:"flex",alignItems:"flex-end"}}>
      <div className="slide-up" onClick={e=>e.stopPropagation()} style={{
        width:"100%",maxHeight:"80vh",background:"var(--bg1)",
        borderRadius:"22px 22px 0 0",display:"flex",flexDirection:"column",
        border:"1px solid var(--border)"
      }}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 20px",borderBottom:"1px solid var(--border)"}}>
          <span style={{fontFamily:"var(--ff-display)",fontSize:18,fontWeight:700,letterSpacing:"0.04em"}}>COMMENTS</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"var(--text1)"}}>
            <X size={20}/>
          </button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"12px 20px"}}>
          {loading ? <div style={{display:"flex",justifyContent:"center",padding:40}}><Spin/></div>
           : err ? <ErrBox msg={err}/>
           : items.length===0 ? <EmptyBox icon={MessageCircle} title="No comments" sub="Start the conversation"/>
           : items.map(c=>(
               <div key={c.id} style={{display:"flex",gap:10,marginBottom:16,animation:"fadeUp 0.2s ease"}}>
                 <Avatar name={c.author_username} size={32}/>
                 <div>
                   <p style={{fontSize:12,fontWeight:600,color:"var(--cyan)",marginBottom:3}}>{c.author_username}</p>
                   <p style={{fontSize:13,color:"var(--text0)",lineHeight:1.5}}>{c.text}</p>
                 </div>
               </div>
             ))
          }
        </div>
        <div style={{padding:"10px 14px",borderTop:"1px solid var(--border)",display:"flex",gap:8,alignItems:"center"}}>
          <Avatar name={user?.username} src={user?.profile_picture} size={32}/>
          <input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&post()}
            placeholder="Add a comment…" style={{...iStyle,flex:1,padding:"8px 12px",borderRadius:20}}/>
          <button onClick={post} disabled={!text.trim()||posting} style={{
            width:34,height:34,borderRadius:17,border:"none",flexShrink:0,
            background:text.trim()?"var(--cyan)":"var(--bg3)",
            display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s"
          }}>
            {posting?<Spin size={14} color="#000"/>:<Send size={14} color={text.trim()?"#000":"var(--text2)"}/>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────
   SHARE MODAL
───────────────────────────────────────── */
function ShareModal({ clip, onClose }) {
  const toast = useToast()
  const [username, setUsername] = useState("")
  const [resolved, setResolved] = useState(null)  // { id, username }
  const [searching, setSearching] = useState(false)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [searchErr, setSearchErr] = useState(null)
  const debounceRef = useRef(null)
  const c = CAT_COLORS[clip.category] || "var(--cyan)"

  // Debounced username lookup
  const onUsernameChange = (val) => {
    setUsername(val)
    setResolved(null)
    setSearchErr(null)
    clearTimeout(debounceRef.current)
    if (!val.trim() || val.length < 2) return
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const d = await API.findUser(val.trim())
        setResolved(d)
      } catch(e) {
        setSearchErr(e.message)
      } finally {
        setSearching(false)
      }
    }, 500)
  }

  const send = async () => {
    if (!resolved || sending) return
    setSending(true)
    try {
      await API.sendShare(clip.id, resolved.id)
      setDone(true)
      toast(`Shared with @${resolved.username}`, "success")
    } catch(e) {
      toast(e.message, "error")
    } finally {
      setSending(false)
    }
  }

  return (
    <div onClick={onClose} style={{
      position:"fixed",inset:0,zIndex:800,
      background:"rgba(0,0,0,0.8)",backdropFilter:"blur(8px)",
      display:"flex",alignItems:"center",justifyContent:"center",padding:20
    }}>
      <div className="fade-up" onClick={e=>e.stopPropagation()} style={{
        width:"100%",maxWidth:360,background:"var(--bg1)",
        borderRadius:20,padding:24,border:"1px solid var(--border)"
      }}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontFamily:"var(--ff-display)",fontSize:18,fontWeight:700,letterSpacing:"0.04em"}}>
            SHARE CLIP
          </span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"var(--text1)"}}>
            <X size={18}/>
          </button>
        </div>

        {/* Clip preview */}
        <div style={{
          display:"flex",gap:12,alignItems:"center",padding:12,
          background:"var(--bg2)",borderRadius:12,marginBottom:16,
          border:"1px solid var(--border)"
        }}>
          <div style={{
            width:40,height:40,borderRadius:10,flexShrink:0,
            background:`${c}18`,display:"flex",alignItems:"center",justifyContent:"center"
          }}>
            <Headphones size={18} color={c}/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <p style={{
              fontSize:13,fontWeight:600,color:"var(--text0)",
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"
            }}>{clip.title}</p>
            <p style={{fontSize:11,color:"var(--text1)"}}>by {clip.creator_name}</p>
          </div>
        </div>

        {done ? (
          <div style={{textAlign:"center",padding:"16px 0"}}>
            <div style={{
              width:48,height:48,borderRadius:24,
              background:"rgba(0,229,160,0.15)",
              display:"flex",alignItems:"center",justifyContent:"center",
              margin:"0 auto 10px"
            }}>
              <Check size={22} color="var(--green)"/>
            </div>
            <p style={{fontSize:14,color:"var(--green)",fontWeight:600}}>
              Sent to @{resolved.username}
            </p>
          </div>
        ) : (
          <>
            {/* Username input */}
            <div style={{position:"relative",marginBottom:8}}>
              <div style={{
                position:"absolute",left:12,top:"50%",
                transform:"translateY(-50%)",
                color:"var(--text2)",fontSize:14,fontWeight:600,
                pointerEvents:"none"
              }}>@</div>
              <input
                value={username}
                onChange={e=>onUsernameChange(e.target.value)}
                placeholder="username"
                autoFocus
                onKeyDown={e=>e.key==="Enter"&&send()}
                style={{
                  ...iStyle,
                  width:"100%",
                  paddingLeft:28,
                  borderColor: resolved
                    ? "rgba(0,229,160,0.4)"
                    : searchErr
                    ? "rgba(255,77,109,0.4)"
                    : "var(--border)"
                }}
              />
              {/* Status indicator */}
              <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)"}}>
                {searching && <Spin size={14}/>}
                {resolved && !searching && <Check size={14} color="var(--green)"/>}
              </div>
            </div>

            {/* Resolved user preview */}
            {resolved && (
              <div className="fade-up" style={{
                display:"flex",alignItems:"center",gap:10,
                padding:"10px 12px",borderRadius:10,marginBottom:12,
                background:"rgba(0,229,160,0.08)",
                border:"1px solid rgba(0,229,160,0.2)"
              }}>
                <Avatar name={resolved.username} size={32}/>
                <div>
                  <p style={{fontSize:13,fontWeight:600,color:"var(--text0)"}}>
                    @{resolved.username}
                  </p>
                  <p style={{fontSize:11,color:"var(--green)"}}>User found</p>
                </div>
              </div>
            )}

            {/* Error */}
            {searchErr && (
              <p style={{fontSize:12,color:"#FF4D6D",marginBottom:12,padding:"0 2px"}}>
                {searchErr}
              </p>
            )}

            <button
              onClick={send}
              disabled={!resolved || sending}
              style={{
                width:"100%",padding:"12px",borderRadius:12,border:"none",
                background: resolved ? "linear-gradient(135deg,var(--cyan),var(--violet))" : "var(--bg3)",
                color: resolved ? "#000" : "var(--text2)",
                fontFamily:"var(--ff-display)",fontSize:15,fontWeight:800,
                letterSpacing:"0.04em",cursor:resolved?"pointer":"default",
                display:"flex",alignItems:"center",justifyContent:"center",gap:8,
                transition:"all 0.2s",
                boxShadow:resolved?"0 4px 16px var(--cyan-glow)":"none"
              }}
            >
              {sending
                ? <Spin size={16} color="#000"/>
                : <><Send size={14}/> SEND TO @{resolved?.username||"..."}</>
              }
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────
   REEL CARD  ← THE core reusable component
───────────────────────────────────────── */
function ReelCard({ clip, onProfileClick }) {
  const { user } = useAuth()
  const { active, playing: globalPlaying, play, listenMs } = usePlayer()
  const isActive   = active?.id === clip.id
  const isPlaying  = isActive && globalPlaying

  const [liked,      setLiked]      = useState(clip.is_liked||false)
  const [likes,      setLikes]      = useState(clip.likes||0)
  const [following,  setFollowing]  = useState(false)
  const [showCmts,   setShowCmts]   = useState(false)
  const [showShare,  setShowShare]  = useState(false)
  const [ripple,     setRipple]     = useState(false)
  
  const c = CAT_COLORS[clip.category]||"var(--cyan)"
  const toast = useToast() // Added to show error if backend is missing data

  // ARCHITECTURAL FIX: Safely resolve the ID from multiple possible serializer formats
  const creatorId = clip.creator_id || clip.creator?.id || clip.creator;

  const handleProfileClick = () => {
    if (!creatorId) {
      console.error("Missing creator_id in clip payload:", clip);
      toast("Error: Creator ID missing from backend", "error");
      return; // Prevent navigating to "my profile"
    }
    onProfileClick?.(creatorId);
  }

  const toggleLike = async () => {
    const nl = !liked; setLiked(nl); setLikes(n=>nl?n+1:n-1)
    setRipple(true); setTimeout(()=>setRipple(false),500)
    try { await API.toggleLike(clip.id) }
    catch { setLiked(!nl); setLikes(n=>nl?n-1:n+1) }
  }

  const toggleFollow = async () => {
    if (!creatorId) return toast("Cannot follow: Missing creator ID", "error");
    
    setFollowing(f=>!f)
    try { await API.toggleFollow(creatorId) }
    catch { setFollowing(f=>!f) }
  }

  useEffect(()=>()=>{
    if(isActive) {
      const ms=listenMs()
      if(ms>800) API.logTelemetry(clip.id,{action_type:"view",watch_time_ms:ms}).catch(()=>{})
    }
  },[])

  return (
    <>
      <div className="card-hover fade-up" style={{
        background:"var(--bg2)",borderRadius:18,overflow:"hidden",
        border:`1px solid ${isActive?`${c}44`:"var(--border)"}`,
        boxShadow:isActive?`0 0 24px ${c}18`:"none",
        transition:"all 0.25s ease"
      }}>
        {/* Visual header */}
        <div onClick={()=>play(clip)} style={{
          height:140,cursor:"pointer",position:"relative",overflow:"hidden",
          background:`linear-gradient(135deg, ${c}14 0%, ${c}26 100%)`
        }}>
          {/* Decorative circles */}
          <div style={{position:"absolute",width:160,height:160,borderRadius:"50%",background:`${c}0A`,top:-40,right:-40,transition:"all 0.3s"}}/>
          <div style={{position:"absolute",width:100,height:100,borderRadius:"50%",background:`${c}0D`,bottom:-30,left:10}}/>
          <div style={{position:"absolute",inset:0,opacity:0.15,backgroundImage:`radial-gradient(circle, ${c} 1px, transparent 1px)`,backgroundSize:"20px 20px"}}/>

          {/* Play button */}
          <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div className={isPlaying?"glow-ring":""} style={{
              width:52,height:52,borderRadius:26,
              background:isPlaying?c:`${c}28`,
              border:`2px solid ${isPlaying?c:`${c}55`}`,
              display:"flex",alignItems:"center",justifyContent:"center",
              transition:"all 0.25s ease"
            }}>
              {isPlaying
                ? <Waves on={true} color="#000"/>
                : <Play size={18} fill={c} color={c}/>
              }
            </div>
          </div>

          <div style={{position:"absolute",top:10,right:10}}>
            <CatBadge category={clip.category}/>
          </div>
        </div>

        {/* Content */}
        <div style={{padding:"12px 14px 0"}}>
          <h3 style={{
            fontFamily:"var(--ff-display)",fontSize:17,fontWeight:700,
            color:"var(--text0)",letterSpacing:"0.02em",marginBottom:8,lineHeight:1.2
          }}>
            {clip.title}
          </h3>
          
          <div style={{display:"flex",alignItems:"center", gap: "10px"}}>
            <button onClick={handleProfileClick} style={{
              display:"flex",alignItems:"center",gap:7,background:"none",border:"none",cursor:"pointer",padding:0
            }}>
              <Avatar name={clip.creator_name} size={26}/>
              <span style={{fontSize:12,color:"var(--text1)",fontWeight:500}}>{clip.creator_name}</span>
            </button>
            
            {/* Safe rendering check for the follow button */}
            {String(creatorId) !== String(user?.id) && (
              <button onClick={toggleFollow} style={{
                padding:"4px 11px",borderRadius:20,fontSize:11,fontWeight:600,
                background:following?"var(--bg3)":"var(--cyan-dim)",
                color:following?"var(--text2)":"var(--cyan)",
                border:following?"1px solid var(--border)":"1px solid var(--border-strong)",
                transition:"all 0.2s",
                cursor:"pointer"
              }}>
                {following?"Following":"+ Follow"}
              </button>
            )}
          </div>
        </div>

        <AudioBar clip={clip}/>

        {/* Action bar */}
        <div style={{
          display:"flex",alignItems:"center",padding:"8px 14px 14px",
          borderTop:"1px solid var(--border)",gap:0
        }}>
          <button onClick={toggleLike} style={{
            display:"flex",alignItems:"center",gap:5,background:"none",border:"none",
            padding:"6px 10px",borderRadius:10,position:"relative",overflow:"hidden", cursor:"pointer"
          }}>
            {ripple && <div style={{position:"absolute",width:32,height:32,borderRadius:"50%",background:"rgba(255,77,109,0.25)",top:"50%",left:"50%",transform:"translate(-50%,-50%)",animation:"ripple 0.5s ease forwards"}}/>}
            <Heart size={17} fill={liked?"#FF4D6D":"none"} color={liked?"#FF4D6D":"var(--text1)"}
              style={{transition:"all 0.2s",transform:liked?"scale(1.15)":"scale(1)"}}/>
            <span style={{fontSize:12,color:liked?"#FF4D6D":"var(--text1)",fontWeight:500}}>{likes}</span>
          </button>

          <button onClick={()=>setShowCmts(true)} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",padding:"6px 10px",borderRadius:10, cursor:"pointer"}}>
            <MessageCircle size={17} color="var(--text1)"/>
            <span style={{fontSize:12,color:"var(--text1)",fontWeight:500}}>{clip.comment_count||0}</span>
          </button>

          <button onClick={()=>setShowShare(true)} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",padding:"6px 10px",borderRadius:10, cursor:"pointer"}}>
            <Share2 size={17} color="var(--text1)"/>
            <span style={{fontSize:12,color:"var(--text1)",fontWeight:500}}>{clip.shares||0}</span>
          </button>

          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:4}}>
            <Radio size={12} color="var(--text2)"/>
            <span style={{fontSize:10,color:"var(--text2)"}}>{clip.skips||0} skips</span>
          </div>
        </div>
      </div>

      {showCmts && <CommentSheet clipId={clip.id} onClose={()=>setShowCmts(false)}/>}
      {showShare && <ShareModal clip={clip} onClose={()=>setShowShare(false)}/>}
    </>
  )
}

/* ─────────────────────────────────────────
   REEL LIST  (reusable infinite list)
───────────────────────────────────────── */
function ReelList({ clips, loading, err, retry, loadMore, hasMore, onProfileClick }) {
  const sentRef = useRef(null)
  const itemRefs = useRef([])
  const { play, active, progress } = usePlayer()

  // Track active ID in a ref to prevent the IntersectionObserver from re-binding constantly
  const activeIdRef = useRef(active?.id)
  useEffect(() => { activeIdRef.current = active?.id }, [active?.id])

  // 1. INFINITE SCROLL
  useEffect(() => {
    if (!sentRef.current || !loadMore) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loading) loadMore()
    }, { threshold: 0.1 })
    obs.observe(sentRef.current)
    return () => obs.disconnect()
  }, [clips.length, hasMore, loading, loadMore])

  // 2. AUTO-SCROLL (Triggered strictly 1 second after playback completes)
  useEffect(() => {
    // A progress value of 1 indicates the audio has naturally finished
    if (active && progress === 1) {
      const currentIndex = clips.findIndex(c => c.id === active.id)
      
      // Ensure there is actually a next clip to scroll to
      if (currentIndex >= 0 && currentIndex < clips.length - 1) {
        const scrollTimer = setTimeout(() => {
          const nextIdx = currentIndex + 1
          if (itemRefs.current[nextIdx]) {
            itemRefs.current[nextIdx].scrollIntoView({
              behavior: 'smooth',
              block: 'center'
            })
          }
        }, 1000) // Exactly 1000ms delay after audio completion
        
        // Cleanup prevents erratic scrolling if the user manually navigates away during the 1s delay
        return () => clearTimeout(scrollTimer)
      }
    }
  }, [active, progress, clips])

  // 3. AUTO-PLAY ON SCROLL (Triggered when the new card snaps into view)
  useEffect(() => {
    if (!clips.length) return
    
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const idx = Number(entry.target.dataset.index)
          const clip = clips[idx]
          
          // Only trigger play if it is a new clip snapping into view
          if (activeIdRef.current !== clip.id) {
            play(clip).catch(e => console.error("Browser autoplay policy restricted playback:", e))
          }
        }
      })
    }, { threshold: 0.6 })

    itemRefs.current.forEach(ref => {
      if (ref) obs.observe(ref)
    })

    return () => obs.disconnect()
  }, [clips, play])

  if (err && !clips.length)   return <ErrBox msg={err} retry={retry}/>
  if (!loading && !clips.length) return <EmptyBox icon={Headphones} title="Nothing here yet" sub="Check back soon for fresh audio reels"/>

  return (
    <div style={{
      // Container sized to fit exactly between your header and bottom nav
      height: "calc(100vh - 160px)",
      overflowY: "auto",
      scrollSnapType: "y mandatory",
      display: "flex",
      flexDirection: "column",
      gap: "24px",
      padding: "10px 14px",
      // Hide scrollbars for a clean full-screen experience
      scrollbarWidth: "none", 
      msOverflowStyle: "none"
    }}>
      {/* Inline style to hide webkit scrollbars */}
      <style dangerouslySetInnerHTML={{__html: `div::-webkit-scrollbar { display: none; }`}} />

      {clips.map((clip, i) => (
        <div 
          key={clip.id} 
          data-index={i}
          ref={el => {
            itemRefs.current[i] = el
            if(i === clips.length - 2) sentRef.current = el
          }}
          style={{
            flex: "0 0 100%", // Forces the wrapper to take 100% of the container's height (1 item per screen)
            scrollSnapAlign: "center", // Snaps perfectly into the center
            display: "flex",
            flexDirection: "column",
            justifyContent: "center", // Centers the ReelCard vertically
            maxWidth: "450px", // Constrains the card width on large laptop screens
            width: "100%",
            margin: "0 auto" // Centers the layout horizontally on wide screens
          }}
        >
          <ReelCard clip={clip} onProfileClick={onProfileClick}/>
        </div>
      ))}
      
      {loading && (
        <div style={{flex: "0 0 100%", display:"flex", justifyContent:"center", alignItems:"center"}}>
          <Spin size={28}/>
        </div>
      )}
      
      {!hasMore && clips.length > 0 && (
        <p style={{flex: "0 0 100%", textAlign:"center", color:"var(--text2)", fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", letterSpacing:"0.06em"}}>
          — ALL CAUGHT UP —
        </p>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────
   BOTTOM NAV
───────────────────────────────────────── */
function BottomNav({ page, go, unread }) {
  const tabs=[
    {id:"feed",    icon:Home,    label:"Home"},
    {id:"explore", icon:Compass, label:"Explore"},
    {id:"create",  icon:Plus,    label:null},
    {id:"inbox",   icon:Bell,    label:"Inbox",  badge:unread},
    {id:"profile", icon:User,    label:"Profile"},
  ]
  return (
    <nav style={{
      position:"fixed",bottom:0,left:0,right:0,zIndex:200,
      background:"rgba(8,15,28,0.92)",backdropFilter:"blur(20px)",
      borderTop:"1px solid var(--border)",
      display:"flex",alignItems:"center",justifyContent:"space-around",
      padding:"8px 0 max(12px, env(safe-area-inset-bottom))"
    }}>
      {tabs.map(t=>{
        const active = page===t.id
        const I = t.icon
        if (!t.label) return (
          <button key={t.id} onClick={()=>go("create")} style={{
            width:46,height:46,borderRadius:14,border:"none",
            background:"linear-gradient(135deg,var(--cyan),var(--violet))",
            display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:"0 4px 18px var(--cyan-glow)"
          }}>
            <Plus size={22} color="#000" strokeWidth={2.5}/>
          </button>
        )
        return (
          <button key={t.id} onClick={()=>go(t.id)} style={{
            display:"flex",flexDirection:"column",alignItems:"center",gap:3,
            background:"none",border:"none",padding:"4px 14px",position:"relative"
          }}>
            {t.badge>0 && (
              <div style={{
                position:"absolute",top:-2,right:8,
                minWidth:16,height:16,borderRadius:8,
                background:"#FF4D6D",color:"white",
                fontSize:9,fontWeight:800,
                display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"
              }}>{t.badge>9?"9+":t.badge}</div>
            )}
            <I size={21}
              color={active?"var(--cyan)":"var(--text2)"}
              fill={active&&["feed","inbox"].includes(t.id)?"var(--cyan)":"none"}
              strokeWidth={active?2.5:2}
            />
            <span style={{fontSize:9,fontWeight:active?700:500,letterSpacing:"0.06em",color:active?"var(--cyan)":"var(--text2)"}}>
              {t.label.toUpperCase()}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

/* ─────────────────────────────────────────
   PAGE: AUTH
───────────────────────────────────────── */
function AuthPage({ onSuccess }) {
  const { login, register } = useAuth()
  const [mode, setMode]   = useState("login")
  const [form, setForm]   = useState({email:"",username:"",password:""})
  const [loading, setL]   = useState(false)
  const [err, setErr]     = useState(null)

  const set = (k,v) => setForm(f=>({...f,[k]:v}))

  const submit = async () => {
    setErr(null); setL(true)
    try {
      if (mode==="login") await login(form.username, form.password)
      else await register(form.email, form.username, form.password)
      onSuccess(mode==="register"?"explore":"feed")
    } catch(e) { setErr(e.message) }
    finally { setL(false) }
  }

  return (
    <div style={{
      minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
      padding:20,background:"var(--bg0)",position:"relative",overflow:"hidden"
    }}>
      {/* BG glows */}
      <div style={{position:"absolute",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle,rgba(0,212,255,0.06),transparent 60%)",top:-150,right:-150,pointerEvents:"none"}}/>
      <div style={{position:"absolute",width:400,height:400,borderRadius:"50%",background:"radial-gradient(circle,rgba(124,58,237,0.07),transparent 60%)",bottom:-100,left:-100,pointerEvents:"none"}}/>

      <div className="fade-up" style={{width:"100%",maxWidth:380}}>
        {/* Logo */}
        <div style={{textAlign:"center",marginBottom:44}}>
          <div style={{
            width:68,height:68,borderRadius:22,margin:"0 auto 16px",
            background:"linear-gradient(135deg,var(--cyan),var(--violet))",
            display:"flex",alignItems:"center",justifyContent:"center",
            boxShadow:"0 0 32px var(--cyan-glow)"
          }}>
            <Headphones size={32} color="#000"/>
          </div>
          <h1 style={{fontFamily:"var(--ff-display)",fontSize:40,fontWeight:900,letterSpacing:"0.04em",color:"var(--text0)",lineHeight:1}}>
            ECHOFLOW
          </h1>
          <p style={{fontSize:13,color:"var(--text1)",marginTop:6,letterSpacing:"0.08em"}}>TIKTOK FOR YOUR EARS</p>
        </div>

        <div style={{background:"var(--bg2)",borderRadius:20,padding:26,border:"1px solid var(--border)"}}>
          {/* Toggle */}
          <div style={{display:"flex",gap:4,padding:4,background:"var(--bg0)",borderRadius:12,marginBottom:22}}>
            {["login","register"].map(m=>(
              <button key={m} onClick={()=>{setMode(m);setErr(null)}} style={{
                flex:1,padding:"8px 0",borderRadius:8,fontSize:13,fontWeight:700,
                letterSpacing:"0.06em",textTransform:"uppercase",border:"none",
                background:mode===m?"var(--bg3)":"transparent",
                color:mode===m?"var(--text0)":"var(--text2)",transition:"all 0.2s"
              }}>{m}</button>
            ))}
          </div>

          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {mode === "register" && (
              <input type="email" placeholder="Email address" value={form.email}
                onChange={e=>set("email",e.target.value)} style={iStyle}/>
            )}
  
            <input type="text" placeholder="Username" value={form.username}
              onChange={e=>set("username",e.target.value)} style={iStyle}/>
    
            <input type="password" placeholder="Password" value={form.password}
              onChange={e=>set("password",e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&submit()} style={iStyle}/>
          </div>

          {err && (
            <div style={{
              marginTop:12,padding:"10px 14px",borderRadius:10,
              background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.2)",
              fontSize:13,color:"#FF4D6D"
            }}>{err}</div>
          )}

          <button onClick={submit} disabled={loading} style={{
            width:"100%",marginTop:18,padding:"13px 0",borderRadius:12,border:"none",
            background:loading?"var(--bg4)":"linear-gradient(135deg,var(--cyan),var(--violet))",
            color:loading?"var(--text2)":"#000",
            fontSize:15,fontWeight:800,fontFamily:"var(--ff-display)",
            letterSpacing:"0.06em",cursor:loading?"default":"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",gap:8,
            boxShadow:loading?"none":"0 4px 20px var(--cyan-glow)",
            transition:"all 0.2s"
          }}>
            {loading?<Spin size={18} color="var(--text2)"/>:(mode==="login"?"SIGN IN →":"CREATE ACCOUNT →")}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────
   PAGE: FEED
───────────────────────────────────────── */
function FeedPage({ go }) {
  const toast = useToast()
  const [clips,   setClips]  = useState([])
  const [loading, setL]      = useState(true)
  const [err,     setErr]    = useState(null)
  const [initial, setInitial]= useState(true)

  const load = async () => {
    setL(true); setErr(null)
    try {
      const d = await API.getFeed()
      const fresh = d.results||[]
      setClips(p=>[...p,...fresh])
      if (initial && fresh.length===0) toast("Queue is empty — check back soon","info")
    } catch(e) {
      setErr(e.message)
      if (initial) toast("Could not load feed: "+e.message,"error")
    } finally { setL(false); setInitial(false) }
  }

  useEffect(()=>{ load() },[])

  return (
    <div>
      <div style={{padding:"54px 14px 4px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <h1 style={{fontFamily:"var(--ff-display)",fontSize:30,fontWeight:900,letterSpacing:"0.04em",lineHeight:1}}>
            FOR YOU
          </h1>
          <p style={{fontSize:11,color:"var(--text2)",letterSpacing:"0.06em",marginTop:2}}>PERSONALIZED AUDIO FEED</p>
        </div>
        <Waves on={clips.length>0} color="var(--cyan)"/>
      </div>
      {loading && initial
        ? <FeedSkeleton/>
        : <ReelList clips={clips} loading={loading&&!initial} err={err}
            retry={()=>{setClips([]);setInitial(true);load()}} loadMore={load} hasMore={true}
            onProfileClick={id=>go("profile",{userId:id})}/>
      }
    </div>
  )
}

/* ─────────────────────────────────────────
   PAGE: EXPLORE
───────────────────────────────────────── */
function ExplorePage({ go }) {
  const [cat,     setCat]    = useState("instrumental")
  const [clips,   setClips]  = useState([])
  const [loading, setL]      = useState(true)
  const [err,     setErr]    = useState(null)
  const [tagMode, setTagMode]= useState(false)
  const [selTags, setSelTags]= useState([])
  const [tagL,    setTagL]   = useState(false)

  const loadCat = async (c) => {
    setL(true); setErr(null); setClips([])
    try { const d=await API.getSuggestions(c); setClips(d.results||d||[]) }
    catch(e) { setErr(e.message) }
    finally { setL(false) }
  }

  useEffect(()=>{ if(!tagMode) loadCat(cat) },[cat,tagMode])

  const toggleTag = t => setSelTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t])

  const submitTags = async () => {
    if (!selTags.length) return
    setTagL(true)
    try { await API.initTags(selTags); go("feed") }
    catch(e) { setErr(e.message) }
    finally { setTagL(false) }
  }

  return (
    <div>
      <div style={{padding:"54px 14px 12px"}}>
        <h1 style={{fontFamily:"var(--ff-display)",fontSize:30,fontWeight:900,letterSpacing:"0.04em",marginBottom:14}}>
          EXPLORE
        </h1>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          <button onClick={()=>setTagMode(false)} style={{
            padding:"7px 16px",borderRadius:20,fontSize:12,fontWeight:700,
            letterSpacing:"0.05em",border:"1px solid var(--border)",
            background:!tagMode?"var(--cyan-dim)":"transparent",
            color:!tagMode?"var(--cyan)":"var(--text2)",transition:"all 0.2s"
          }}>BROWSE</button>
          <button onClick={()=>setTagMode(true)} style={{
            padding:"7px 16px",borderRadius:20,fontSize:12,fontWeight:700,
            letterSpacing:"0.05em",border:"1px solid var(--border)",
            background:tagMode?"rgba(124,58,237,0.15)":"transparent",
            color:tagMode?"#A78BFA":"var(--text2)",transition:"all 0.2s"
          }}>BY TAGS</button>
        </div>
      </div>

      {tagMode ? (
        <div style={{padding:"0 14px 100px"}}>
          <p style={{fontSize:13,color:"var(--text1)",marginBottom:16}}>Select tags to refine your recommendation feed</p>
          <div style={{display:"flex",flexWrap:"wrap",gap:10,marginBottom:24}}>
            {CATEGORIES.map(t=>{
              const sel=selTags.includes(t); const c=CAT_COLORS[t]
              return (
                <button key={t} onClick={()=>toggleTag(t)} style={{
                  padding:"10px 20px",borderRadius:20,fontSize:13,fontWeight:600,
                  background:sel?`${c}18`:"var(--bg2)",
                  color:sel?c:"var(--text1)",
                  border:sel?`1px solid ${c}44`:"1px solid var(--border)",
                  textTransform:"capitalize",transition:"all 0.2s",
                  display:"flex",alignItems:"center",gap:6
                }}>
                  {sel&&<Check size={13}/>}{t}
                </button>
              )
            })}
          </div>
          {err&&<ErrBox msg={err}/>}
          <button onClick={submitTags} disabled={!selTags.length||tagL} style={{
            width:"100%",padding:"14px",borderRadius:14,border:"none",
            background:selTags.length?"linear-gradient(135deg,var(--violet),var(--cyan))":"var(--bg3)",
            color:selTags.length?"#fff":"var(--text2)",
            fontFamily:"var(--ff-display)",fontSize:16,fontWeight:800,letterSpacing:"0.05em",
            cursor:selTags.length?"pointer":"default",
            display:"flex",alignItems:"center",justifyContent:"center",gap:8,
            boxShadow:selTags.length?"0 4px 20px var(--cyan-glow)":"none",transition:"all 0.2s"
          }}>
            {tagL?<Spin size={18} color="#fff"/>:`PERSONALIZE WITH ${selTags.length} TAG${selTags.length!==1?"S":""} →`}
          </button>
        </div>
      ):(
        <>
          <div style={{overflowX:"auto",padding:"0 14px 12px",scrollbarWidth:"none"}}>
            <div style={{display:"flex",gap:8,width:"max-content"}}>
              {CATEGORIES.map(c=>{
                const active=cat===c; const col=CAT_COLORS[c]
                return (
                  <button key={c} onClick={()=>setCat(c)} style={{
                    padding:"8px 18px",borderRadius:20,fontSize:12,fontWeight:700,
                    letterSpacing:"0.05em",textTransform:"uppercase",
                    background:active?`${col}18`:"var(--bg2)",
                    color:active?col:"var(--text1)",
                    border:active?`1px solid ${col}44`:"1px solid var(--border)",
                    whiteSpace:"nowrap",transition:"all 0.2s"
                  }}>{c}</button>
                )
              })}
            </div>
          </div>
          <ReelList clips={clips} loading={loading} err={err}
            retry={()=>loadCat(cat)} hasMore={false}
            onProfileClick={id=>go("profile",{userId:id})}/>
        </>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────
   PAGE: INBOX
───────────────────────────────────────── */
function InboxPage({ go }) {
  const [items,   setItems]  = useState([])
  const [loading, setL]      = useState(true)
  const [err,     setErr]    = useState(null)
  const [preview, setPreview]= useState(null)

  useEffect(()=>{
    API.getInbox()
      .then(d=>{setItems(d.results||d||[]);setL(false)})
      .catch(e=>{setErr(e.message);setL(false)})
  },[])

  const open = async (item) => {
    setPreview(item)
    if (!item.is_read) {
      API.markRead(item.id).catch(()=>{})
      setItems(p=>p.map(x=>x.id===item.id?{...x,is_read:true}:x))
    }
  }

  const del = (id) => {
    setItems(p=>p.filter(x=>x.id!==id))
    API.deleteShare(id).catch(()=>{})
  }

  const unreadCnt = items.filter(i=>!i.is_read).length

  return (
    <div>
      <div style={{padding:"54px 14px 14px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <h1 style={{fontFamily:"var(--ff-display)",fontSize:30,fontWeight:900,letterSpacing:"0.04em"}}>INBOX</h1>
        {unreadCnt>0 && (
          <span style={{
            padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:700,
            background:"rgba(0,212,255,0.12)",color:"var(--cyan)",letterSpacing:"0.05em"
          }}>{unreadCnt} UNREAD</span>
        )}
      </div>

      <div style={{padding:"0 14px 100px"}}>
        {loading?<div style={{display:"flex",justifyContent:"center",padding:60}}><Spin size={32}/></div>
         :err?<ErrBox msg={err} retry={()=>{setL(true);API.getInbox().then(d=>{setItems(d.results||d||[]);setL(false)}).catch(e=>{setErr(e.message);setL(false)})}}/>
         :items.length===0?<EmptyBox icon={Bell} title="No messages" sub="When someone shares a clip, it'll appear here"/>
         :items.map(item=>(
           <div key={item.id} className="fade-up card-hover" style={{
             background:"var(--bg2)",borderRadius:16,marginBottom:10,overflow:"hidden",
             border:`1px solid ${item.is_read?"var(--border)":"var(--border-strong)"}`,
             cursor:"pointer",transition:"all 0.2s"
           }}>
             <div style={{padding:"14px",display:"flex",gap:12,alignItems:"center"}} onClick={()=>open(item)}>
               {!item.is_read && <div style={{
                 position:"absolute",right:18,top:"50%",transform:"translateY(-50%)",
                 width:7,height:7,borderRadius:4,background:"var(--cyan)",
                 boxShadow:"0 0 6px var(--cyan)"
               }}/>}
               <Avatar name={item.sender_name} size={44}/>
               <div style={{flex:1,minWidth:0}}>
                 <p style={{fontSize:13,fontWeight:600,color:"var(--text0)",marginBottom:2}}>
                   <span style={{color:"var(--cyan)"}}>{item.sender_name}</span> shared a clip
                 </p>
                 <p style={{fontSize:12,color:"var(--text1)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                   {item.clip_title||"Audio clip"}
                 </p>
                 <p style={{fontSize:10,color:"var(--text2)",marginTop:2,letterSpacing:"0.04em"}}>
                   {new Date(item.created_at).toLocaleDateString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}
                 </p>
               </div>
               <button onClick={e=>{e.stopPropagation();del(item.id)}} style={{
                 background:"none",border:"none",color:"var(--text2)",padding:6,flexShrink:0
               }}>
                 <X size={15}/>
               </button>
             </div>
           </div>
         ))
        }
      </div>

      {preview?.clip && (
        <div onClick={()=>setPreview(null)} style={{
          position:"fixed",inset:0,zIndex:700,
          background:"rgba(0,0,0,0.85)",backdropFilter:"blur(10px)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:16
        }}>
          <div onClick={e=>e.stopPropagation()} style={{width:"100%",maxWidth:400}}>
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
              <button onClick={()=>setPreview(null)} style={{
                width:36,height:36,borderRadius:18,background:"var(--bg3)",
                border:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"center",
                color:"var(--text0)"
              }}><X size={16}/></button>
            </div>
            <ReelCard clip={preview.clip} onProfileClick={id=>{setPreview(null);go("profile",{userId:id})}}/>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────
   PAGE: CREATE
───────────────────────────────────────── */
function CreatePage({ go }) {
  const toast = useToast()
  const [file,    setFile]  = useState(null)
  const [form,    setForm]  = useState({title:"",category:""})
  const [pct,     setPct]   = useState(0)
  const [busy,    setBusy]  = useState(false)
  const [err,     setErr]   = useState(null)
  const [done,    setDone]  = useState(false)
  const fileRef = useRef(null)

  const setF = (k,v) => setForm(f=>({...f,[k]:v}))

  const pickFile = (f) => {
    if (!f) return
    if (!f.type.startsWith("audio/")) {
      setErr("Audio files only — MP3, WAV, AAC, OGG etc.")
      toast("Audio files only","error")
      return
    }
    if (f.size > 100*1024*1024) {
      setErr("File too large (max 100 MB)")
      toast("File exceeds 100 MB limit","error")
      return
    }
    setFile(f); setErr(null)
    toast("File ready: "+f.name.slice(0,28),"success")
  }

  const submit = async () => {
    if (!file||!form.title||!form.category) {
      toast("Fill in all required fields","warn")
      return
    }
    setBusy(true); setErr(null); setPct(0)
    const fd = new FormData()
    fd.append("original_file",file); fd.append("title",form.title); fd.append("category",form.category)
    const iv = setInterval(()=>setPct(p=>Math.min(p+Math.random()*12,88)),250)
    try {
      await API.uploadClip(fd)
      clearInterval(iv); setPct(100); setDone(true)
      toast("Reel published! Processing in background","success",4000)
      setTimeout(()=>go("feed"),1800)
    } catch(e) {
      clearInterval(iv)
      const msg = e.errors?.title?.[0]||e.errors?.original_file?.[0]||e.message||"Upload failed"
      setErr(msg)
      toast(msg,"error")
    } finally { setBusy(false) }
  }

  if (done) return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
      <div className="fade-up" style={{textAlign:"center"}}>
        <div style={{width:72,height:72,borderRadius:22,background:"linear-gradient(135deg,var(--green),var(--cyan))",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",boxShadow:"0 0 32px rgba(0,229,160,0.3)"}}>
          <Check size={32} color="#000" strokeWidth={3}/>
        </div>
        <h2 style={{fontFamily:"var(--ff-display)",fontSize:26,fontWeight:900,letterSpacing:"0.04em",marginBottom:8}}>UPLOAD COMPLETE</h2>
        <p style={{color:"var(--text1)",fontSize:13}}>Processing in background — redirecting to feed…</p>
      </div>
    </div>
  )

  const canSubmit = file&&form.title&&form.category&&!busy

  return (
    <div style={{padding:"54px 14px 100px"}}>
      <h1 style={{fontFamily:"var(--ff-display)",fontSize:30,fontWeight:900,letterSpacing:"0.04em",marginBottom:24}}>
        UPLOAD REEL
      </h1>

      {/* Drop zone */}
      <div
        onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();pickFile(e.dataTransfer.files?.[0])}}
        onClick={()=>!busy&&fileRef.current?.click()} style={{
          border:`2px dashed ${file?"var(--cyan)":"var(--border)"}`,
          borderRadius:18,padding:36,marginBottom:22,textAlign:"center",
          background:file?"var(--cyan-dim)":"var(--bg2)",
          cursor:busy?"default":"pointer",transition:"all 0.2s"
        }}>
        <input ref={fileRef} type="file" accept="audio/*" onChange={e=>pickFile(e.target.files?.[0])} style={{display:"none"}}/>
        <div style={{width:52,height:52,borderRadius:16,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"}}>
          {file?<Music size={24} color="var(--cyan)"/>:<Upload size={24} color="var(--text2)"/>}
        </div>
        {file ? (
          <>
            <p style={{fontSize:14,fontWeight:600,color:"var(--text0)",marginBottom:4}}>{file.name}</p>
            <p style={{fontSize:12,color:"var(--text1)"}}>{(file.size/1024/1024).toFixed(1)} MB · {file.type}</p>
            {!busy&&<button onClick={e=>{e.stopPropagation();setFile(null)}} style={{marginTop:10,padding:"5px 14px",borderRadius:20,background:"var(--bg3)",border:"1px solid var(--border)",color:"var(--text1)",fontSize:12,cursor:"pointer"}}>Remove</button>}
          </>
        ):(
          <>
            <p style={{fontSize:14,fontWeight:600,color:"var(--text0)",marginBottom:4}}>Drop audio file or tap to browse</p>
            <p style={{fontSize:12,color:"var(--text1)"}}>MP3 · WAV · AAC · OGG · FLAC · max 100 MB</p>
          </>
        )}
      </div>
      <WaveformPreview file={file}/>

      {/* Title */}
      <div style={{marginBottom:16}}>
        <label style={{fontSize:11,fontWeight:700,color:"var(--text2)",letterSpacing:"0.08em",display:"block",marginBottom:6}}>TITLE *</label>
        <input value={form.title} maxLength={255} onChange={e=>setF("title",e.target.value)}
          placeholder="What's this clip about?" style={{...iStyle,width:"100%"}}/>
        <p style={{fontSize:10,color:"var(--text2)",textAlign:"right",marginTop:3}}>{form.title.length}/255</p>
      </div>

      {/* Category */}
      <div style={{marginBottom:22}}>
        <label style={{fontSize:11,fontWeight:700,color:"var(--text2)",letterSpacing:"0.08em",display:"block",marginBottom:8}}>CATEGORY *</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {CATEGORIES.map(c=>{
            const sel=form.category===c; const col=CAT_COLORS[c]
            return (
              <button key={c} onClick={()=>setF("category",c)} style={{
                padding:"9px 18px",borderRadius:20,fontSize:12,fontWeight:700,
                letterSpacing:"0.04em",textTransform:"capitalize",
                background:sel?`${col}18`:"var(--bg2)",color:sel?col:"var(--text1)",
                border:sel?`1px solid ${col}44`:"1px solid var(--border)",
                transition:"all 0.2s",cursor:"pointer"
              }}>{c}</button>
            )
          })}
        </div>
      </div>

      {/* Progress */}
      {busy && (
        <div style={{marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:12,color:"var(--text1)"}}>Uploading…</span>
            <span style={{fontSize:12,fontWeight:700,color:"var(--cyan)"}}>{Math.round(pct)}%</span>
          </div>
          <div style={{height:5,borderRadius:3,background:"var(--bg4)",overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:3,width:`${pct}%`,background:"linear-gradient(90deg,var(--cyan),var(--violet))",transition:"width 0.25s ease",boxShadow:"0 0 8px var(--cyan-glow)"}}/>
          </div>
        </div>
      )}

      {err && <div style={{padding:"10px 14px",borderRadius:10,marginBottom:14,background:"rgba(255,77,109,0.1)",border:"1px solid rgba(255,77,109,0.2)",color:"#FF4D6D",fontSize:13}}>{err}</div>}

      <button onClick={submit} disabled={!canSubmit} style={{
        width:"100%",padding:"14px",borderRadius:14,border:"none",cursor:canSubmit?"pointer":"default",
        background:canSubmit?"linear-gradient(135deg,var(--cyan),var(--violet))":"var(--bg3)",
        color:canSubmit?"#000":"var(--text2)",
        fontFamily:"var(--ff-display)",fontSize:17,fontWeight:900,letterSpacing:"0.05em",
        display:"flex",alignItems:"center",justifyContent:"center",gap:8,
        boxShadow:canSubmit?"0 4px 24px var(--cyan-glow)":"none",transition:"all 0.2s"
      }}>
        {busy?<><Spin size={18} color="var(--text2)"/> UPLOADING…</>:"PUBLISH REEL →"}
      </button>
    </div>
  )
}

/* ─────────────────────────────────────────
   PAGE: PROFILE
───────────────────────────────────────── */
function ProfilePage({ go, userId: targetId }) {
  const { user:au, patchUser, logout } = useAuth()
  const { theme, toggle:toggleTheme } = useTheme()
  const isOwn = !targetId || targetId===au?.id

  const [prof,     setProf]    = useState(null)
  const [clips,    setClips]   = useState([])
  const [loading,  setL]       = useState(true)
  const [err,      setErr]     = useState(null)
  const [tab,      setTab]     = useState("uploads")
  const [editing,  setEditing] = useState(false)
  const [newName,  setNewName] = useState("")
  const [saving,   setSaving]  = useState(false)
  const fileRef = useRef(null)

  useEffect(()=>{
    setL(true); setErr(null)
    const p = isOwn ? API.getMyProfile() : API.getProfile(targetId)
    p.then(async d=>{
      setProf(d); setNewName(d.username)
      const cd = await API.getUserClips(d.id).catch(()=>({results:[]}))
      setClips(cd.results||cd||[])
      setL(false)
    }).catch(e=>{setErr(e.message);setL(false)})
  },[isOwn,targetId])

  const toast = useToast()

  const changeAvatar = async (e) => {
    const f=e.target.files?.[0]; if(!f) return
    const fd=new FormData(); fd.append("profile_picture",f)
    try {
      const d=await API.updateProfile(fd)
      setProf(p=>({...p,profile_picture:d.profile_picture}))
      patchUser({profile_picture:d.profile_picture})
      toast("Profile picture updated","success")
    } catch(e) { toast(e.message,"error") }
  }

  const saveName = async () => {
    if (!newName.trim()||newName===prof?.username){setEditing(false);return}
    setSaving(true)
    try {
      const fd=new FormData(); fd.append("username",newName.trim())
      const d=await API.updateProfile(fd)
      setProf(p=>({...p,username:d.username})); patchUser({username:d.username}); setEditing(false)
      toast("Username updated","success")
    } catch(e){ toast(e.message,"error") } finally{setSaving(false)}
  }

  if (loading) return <div style={{display:"flex",justifyContent:"center",alignItems:"center",minHeight:"60vh"}}><Spin size={36}/></div>
  if (err)     return <ErrBox msg={err}/>

  const stats=[
    {l:"UPLOADS",  v:prof?.uploads_count||0},
    {l:"FOLLOWERS",v:prof?.followers_count||0},
    {l:"FOLLOWING",v:prof?.following_count||0},
  ]

  return (
    <div>
      {!isOwn && (
        <div style={{padding:"54px 14px 8px",display:"flex",alignItems:"center",gap:10}}>
          <button onClick={()=>go("feed")} style={{background:"none",border:"none",color:"var(--text0)",padding:4}}><ArrowLeft size={22}/></button>
          <span style={{fontFamily:"var(--ff-display)",fontSize:20,fontWeight:800,letterSpacing:"0.04em"}}>{prof?.username}</span>
        </div>
      )}

      <div style={{padding:isOwn?"54px 18px 18px":"8px 18px 18px"}}>
        {/* Top row */}
        <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:18}}>
          <div style={{position:"relative"}}>
            <Avatar src={prof?.profile_picture} name={prof?.username} size={78}/>
            {isOwn&&<>
              <input ref={fileRef} type="file" accept="image/*" onChange={changeAvatar} style={{display:"none"}}/>
              <button onClick={()=>fileRef.current?.click()} style={{
                position:"absolute",bottom:0,right:0,width:24,height:24,borderRadius:12,
                background:"var(--cyan)",border:"2px solid var(--bg0)",
                display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"
              }}><Plus size={11} color="#000" strokeWidth={3}/></button>
            </>}
          </div>

          {isOwn?(
            <div style={{display:"flex",gap:8}}>
              <button onClick={toggleTheme} style={{
                width:38,height:38,borderRadius:19,background:"var(--bg3)",
                border:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"center",
                cursor:"pointer",color:"var(--text1)"
              }}>
                {theme==="dark"?<Sun size={17}/>:<Moon size={17}/>}
              </button>
              <button onClick={()=>{logout();toast&&toast("Signed out","info")}} style={{
                padding:"8px 16px",borderRadius:20,fontSize:12,fontWeight:700,letterSpacing:"0.04em",
                background:"rgba(255,77,109,0.1)",color:"#FF4D6D",border:"1px solid rgba(255,77,109,0.2)",cursor:"pointer"
              }}>SIGN OUT</button>
            </div>
          ):(
            <button onClick={async()=>{
              try {
                const d=await API.toggleFollow(prof?.id)
                const isNowFollowing=d?.status==="followed"
                setProf(p=>({...p,followers_count:(p.followers_count||0)+(isNowFollowing?1:-1)}))
                toast&&toast(isNowFollowing?"Following "+prof?.username:"Unfollowed "+prof?.username,"info")
              } catch(e){ toast&&toast(e.message,"error") }
            }} style={{
              padding:"10px 22px",borderRadius:20,fontSize:13,fontWeight:800,letterSpacing:"0.04em",
              background:"linear-gradient(135deg,var(--cyan),var(--violet))",color:"#000",border:"none",cursor:"pointer",
              fontFamily:"var(--ff-display)",boxShadow:"0 4px 16px var(--cyan-glow)"
            }}>FOLLOW</button>
          )}
        </div>

        {/* Username */}
        {editing?(
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14}}>
            <input value={newName} onChange={e=>setNewName(e.target.value)} autoFocus
              onKeyDown={e=>e.key==="Enter"&&saveName()}
              style={{...iStyle,flex:1,fontFamily:"var(--ff-display)",fontSize:22,fontWeight:700,padding:"8px 12px"}}/>
            <button onClick={saveName} style={{width:34,height:34,borderRadius:17,background:"var(--cyan)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {saving?<Spin size={14} color="#000"/>:<Check size={14} color="#000"/>}
            </button>
            <button onClick={()=>setEditing(false)} style={{width:34,height:34,borderRadius:17,background:"var(--bg3)",border:"1px solid var(--border)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--text1)"}}>
              <X size={14}/>
            </button>
          </div>
        ):(
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <h2 style={{fontFamily:"var(--ff-display)",fontSize:26,fontWeight:900,letterSpacing:"0.04em"}}>{prof?.username}</h2>
            {isOwn&&<button onClick={()=>setEditing(true)} style={{background:"none",border:"none",cursor:"pointer",color:"var(--text2)",padding:4}}><Settings size={15}/></button>}
          </div>
        )}

        {/* Stats */}
        <div style={{display:"flex",gap:0,borderRadius:14,background:"var(--bg2)",border:"1px solid var(--border)",overflow:"hidden"}}>
          {stats.map((s,i)=>(
            <div key={s.l} style={{flex:1,padding:"12px 0",textAlign:"center",borderRight:i<2?"1px solid var(--border)":"none"}}>
              <p style={{fontFamily:"var(--ff-display)",fontSize:22,fontWeight:900,color:"var(--text0)",letterSpacing:"0.02em"}}>{s.v}</p>
              <p style={{fontSize:9,fontWeight:700,color:"var(--text2)",letterSpacing:"0.08em"}}>{s.l}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:"1px solid var(--border)",padding:"0 18px"}}>
        {(isOwn?["uploads","liked"]:["uploads"]).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{
            padding:"10px 0",marginRight:24,fontSize:11,fontWeight:800,letterSpacing:"0.08em",
            textTransform:"uppercase",background:"none",border:"none",cursor:"pointer",
            color:tab===t?"var(--cyan)":"var(--text2)",
            borderBottom:tab===t?"2px solid var(--cyan)":"2px solid transparent",
            marginBottom:-1,transition:"all 0.2s"
          }}>{t}</button>
        ))}
      </div>

      <ReelList
        clips={tab==="uploads"?clips:(prof?.liked_clips||[])}
        loading={false} err={null} hasMore={false}
        onProfileClick={id=>go("profile",{userId:id})}/>
    </div>
  )
}

/* ─────────────────────────────────────────
   APP SHELL
───────────────────────────────────────── */
function App() {
  const { authed } = useAuth()
  const toast = useToast()
  const [page,       setPage]      = useState(authed?"feed":"auth")
  const [params,     setParams]    = useState({})
  const [unread,     setUnread]    = useState(0)
  const [onboarding, setOnboarding]= useState(false)
  const [prevPage,   setPrevPage]  = useState(null)

  const go = (p, ps={}) => {
    setPrevPage(page)
    setPage(p)
    setParams(ps)
    window.scrollTo({top:0,behavior:"smooth"})
  }

  useEffect(()=>{
    if (!authed) { setPage("auth"); return }
    const poll = () => API.getUnread().then(d=>setUnread(d.unread||0)).catch(()=>{})
    poll()
    const id = setInterval(poll, 30000)
    return ()=>clearInterval(id)
  },[authed])

  // show onboarding if flagged after register
  useEffect(()=>{
    if (authed && sessionStorage.getItem("ef_new_user")==="1") {
      sessionStorage.removeItem("ef_new_user")
      setOnboarding(true)
    }
  },[authed])

  if (!authed) return <AuthPage onSuccess={(p)=>{ if(p==="explore") sessionStorage.setItem("ef_new_user","1"); go(p) }}/>

  const pages = {
    feed:    <FeedPage    go={go}/>,
    explore: <ExplorePage go={go}/>,
    inbox:   <InboxPage   go={go}/>,
    create:  <CreatePage  go={go}/>,
    profile: <ProfilePage go={go} userId={params.userId}/>,
  }

  return (
    <div style={{maxWidth:600,margin:"0 auto",minHeight:"100vh",position:"relative"}}>
      <div className="scan-line"/>
      <NetworkBanner/>

      <div key={page} className="page-in">
        {pages[page]}
      </div>

      <MiniPlayer/>
      <BottomNav page={page} go={go} unread={unread}/>
      {onboarding && <OnboardingModal onDone={()=>setOnboarding(false)}/>}
    </div>
  )
}

/* ─────────────────────────────────────────
   ROOT EXPORT
───────────────────────────────────────── */
export default function EchoFlow() {
  return (
    <>
      <style dangerouslySetInnerHTML={{__html:STYLES}}/>
      <ThemeProvider>
        <AuthProvider>
          <PlayerProvider>
            <ToastProvider>
              <App/>
            </ToastProvider>
          </PlayerProvider>
        </AuthProvider>
      </ThemeProvider>
    </>
  )
}

import { createRoot } from 'react-dom/client'

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<EchoFlow />);