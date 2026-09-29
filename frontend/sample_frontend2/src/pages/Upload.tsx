import { useState, useRef } from 'react';
import { Music, Upload, Check, Headphones, Radio, Globe, Image } from 'lucide-react';
import { useToast } from '../stores/toast';
import { clipsAPI } from '../api/client';
import { CATEGORIES, getCatColor } from '../data/clips';
import { Spinner, inputStyle } from '../components/common/atoms';
import { Btn } from '../components/common/molecules';
import { useNavigation } from '../context/NavigationContext';
import { useDemoMode } from '../context/DemoModeContext';

type Stage = 'idle' | 'uploading' | 'processing' | 'analyzing' | 'transcoding' | 'done' | 'error';

export function UploadPage() {
  const { go } = useNavigation();
  const toast = useToast();
  const demo = useDemoMode();

  const [file, setFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [form, setForm] = useState({ title: '', category: '' });
  const [tags, setTags] = useState<string[]>([]);
  const [pct, setPct] = useState(0);
  const [stage, setStage] = useState<Stage>('idle');
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  const setF = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const pickFile = (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('audio/')) {
      setErr('Audio files only — MP3, WAV, AAC, OGG etc.');
      toast('Audio files only', 'error');
      return;
    }
    if (f.size > 100 * 1024 * 1024) {
      setErr('File too large (max 100 MB)');
      toast('File exceeds 100 MB', 'error');
      return;
    }
    setFile(f); setErr(null);
    toast('File ready: ' + f.name.slice(0, 28), 'success');
  };

  const pickCoverFile = (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setErr('Image files only — JPG, PNG, WebP etc.');
      toast('Image files only', 'error');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setErr('Cover image too large (max 5 MB)');
      toast('Cover image exceeds 5 MB', 'error');
      return;
    }
    setCoverFile(f); setErr(null);
    toast('Cover image ready: ' + f.name.slice(0, 28), 'success');
  };

  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); };
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  const submit = async () => {
    if (!file || !form.title || !form.category) {
      toast('Fill in all required fields', 'warn');
      return;
    }
    setStage('uploading'); setPct(0); setErr(null);
    const iv = setInterval(() => setPct(p => Math.min(p + Math.random() * 12, 88)), 250);
    try {
      if (demo) {
        await new Promise(r => setTimeout(r, 1200));
      } else {
        const fd = new FormData();
        fd.append('original_file', file);
        fd.append('title', form.title);
        fd.append('category', form.category);
        if (coverFile) fd.append('cover_image', coverFile);
        await clipsAPI.uploadClip(fd);
      }
      clearInterval(iv); setPct(100);
      setStage('done');
      toast('Reel published! Processing in background', 'success', 4000);
      setTimeout(() => go('feed'), 1800);
    } catch (e: unknown) {
      clearInterval(iv);
      setStage('error');
      const errObj = e as { errors?: Record<string, string[]>; message?: string };
      setErr(errObj.errors?.title?.[0] || errObj.errors?.original_file?.[0] || errObj.errors?.cover_image?.[0] || errObj.message || 'Upload failed');
      toast(errObj.message || 'Upload failed', 'error');
    }
  };

  const addTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && e.currentTarget.value.trim() && tags.length < 8) {
      setTags([...tags, e.currentTarget.value.trim().toLowerCase()]);
      e.currentTarget.value = '';
    }
  };

  if (stage === 'done') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="fade-up" style={{ textAlign: 'center' }}>
          <div style={{
            width: 72, height: 72, borderRadius: 22, margin: '0 auto 20px',
            background: 'linear-gradient(135deg, var(--sage), var(--terracotta))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 32px var(--accent-glow)'
          }}><Check size={32} color="#000" strokeWidth={3} /></div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 900, letterSpacing: '0.04em', marginBottom: 8 }}>UPLOAD COMPLETE</h2>
          <p style={{ color: 'var(--on-surface-variant)', fontSize: 13 }}>Processing in background — redirecting to feed...</p>
        </div>
      </div>
    );
  }

  const canSubmit = file && form.title && form.category;

  return (
    <div style={{ padding: '56px 14px 100px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, letterSpacing: '0.03em', color: 'var(--on-surface)' }}>UPLOAD REEL</h1>
        {demo && <span style={{ fontSize: 11, color: 'var(--terracotta)', fontWeight: 600 }}>DEMO MODE</span>}
      </div>

      {/* Audio Drop zone */}
      <div
        onDragOver={handleDragOver} onDrop={handleDrop}
        onClick={() => !stage && fileRef.current?.click()}
        style={{
          border: `2px dashed ${file ? 'var(--terracotta)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-xl)', padding: 36, marginBottom: 22,
          textAlign: 'center', background: file ? 'var(--accent-soft)' : 'var(--surface)',
          cursor: 'pointer', transition: 'all 0.2s'
        }}
      >
        <input ref={fileRef} type="file" accept="audio/*" onChange={e => pickFile(e.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          {file ? <Music size={24} color="var(--terracotta)" /> : <Upload size={24} color="var(--outline)" />}
        </div>
        {file ? (
          <>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--on-surface)', marginBottom: 4 }}>{file.name}</p>
            <p style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>{(file.size / 1024 / 1024).toFixed(1)} MB · {file.type}</p>
            {!stage && <button onClick={e => { e.stopPropagation(); setFile(null); }} style={{ marginTop: 10, padding: '5px 14px', borderRadius: 20, background: 'var(--surface-container)', border: '1px solid var(--border)', color: 'var(--on-surface-variant)', fontSize: 12, cursor: 'pointer' }}>Remove</button>}
          </>
        ) : (
          <>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--on-surface)', marginBottom: 4 }}>Drop audio file or tap to browse</p>
            <p style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>MP3 · WAV · AAC · OGG · FLAC · max 100 MB</p>
          </>
        )}
      </div>

      {/* Cover Image Drop zone */}
      <div
        onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); pickCoverFile(e.dataTransfer.files?.[0]); }}
        onClick={() => !stage && coverRef.current?.click()}
        style={{
          border: `2px dashed ${coverFile ? 'var(--terracotta)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-xl)', padding: 24, marginBottom: 22,
          textAlign: 'center', background: coverFile ? 'var(--accent-soft)' : 'var(--surface)',
          cursor: 'pointer', transition: 'all 0.2s'
        }}
      >
        <input ref={coverRef} type="file" accept="image/*" onChange={e => pickCoverFile(e.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
          {coverFile ? <Image size={24} color="var(--terracotta)" /> : <Image size={24} color="var(--outline)" />}
        </div>
        {coverFile ? (
          <>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', marginBottom: 4 }}>{coverFile.name}</p>
            <p style={{ fontSize: 11, color: 'var(--on-surface-variant)' }}>{(coverFile.size / 1024).toFixed(1)} KB · {coverFile.type}</p>
            {!stage && <button onClick={e => { e.stopPropagation(); setCoverFile(null); }} style={{ marginTop: 8, padding: '4px 12px', borderRadius: 20, background: 'var(--surface-container)', border: '1px solid var(--border)', color: 'var(--on-surface-variant)', fontSize: 11, cursor: 'pointer' }}>Remove</button>}
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', marginBottom: 4 }}>Drop cover image or tap to browse (optional)</p>
            <p style={{ fontSize: 11, color: 'var(--on-surface-variant)' }}>JPG · PNG · WebP · max 5 MB</p>
          </>
        )}
      </div>

      {/* Waveform preview (placeholder visualization) */}
      {file && (
        <div style={{ padding: '8px 0 4px', marginBottom: 16 }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', marginBottom: 6 }}>AUDIO PREVIEW</p>
          <div style={{ height: 60, borderRadius: 8, background: 'var(--surface-container)', display: 'flex', alignItems: 'flex-end', gap: 1, padding: '4px 0', overflow: 'hidden' }}>
            {Array.from({ length: 52 }).map((_, i) => {
              const h = 20 + Math.random() * 40;
              return <div key={i} style={{ flex: 1, height: h, background: 'var(--terracotta)', borderRadius: 1, opacity: 0.5 + Math.random() * 0.5, transition: 'opacity 0.3s' }} />;
            })}
          </div>
        </div>
      )}

      {/* Title */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', display: 'block', marginBottom: 6 }}>TITLE *</label>
        <input value={form.title} maxLength={255} onChange={e => setF('title', e.target.value)}
          placeholder="What\u2019s this clip about?" style={{
            ...inputStyle, width: '100%'
          }} />
        <p style={{ fontSize: 10, color: 'var(--outline)', textAlign: 'right', marginTop: 3 }}>{form.title.length}/255</p>
      </div>

      {/* Category */}
      <div style={{ marginBottom: 22 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 }}>CATEGORY *</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {CATEGORIES.map(c => {
            const sel = form.category === c;
            const col = getCatColor(c);
            return (
              <button key={c} onClick={() => setF('category', c)} style={{
                padding: '9px 18px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                letterSpacing: '0.04em', textTransform: 'capitalize',
                background: sel ? `${col}18` : 'var(--surface-container)',
                color: sel ? col : 'var(--on-surface-variant)',
                border: sel ? `1px solid ${col}44` : '1px solid var(--border)',
                transition: 'all 0.2s', cursor: 'pointer'
              }}>{c}</button>
            );
          })}
        </div>
      </div>

      {/* Tags */}
      <div style={{ marginBottom: 22 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 }}>TAGS (optional)</label>
        <input type="text" placeholder="Type and press Enter..." onKeyDown={addTag}
          style={{ width: '100%', padding: '8px 12px', borderRadius: 12, fontSize: 14, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--on-surface)', fontFamily: 'var(--font-body)' }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {tags.map(t => (
            <span key={t} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 11, fontWeight: 600, background: 'var(--accent-soft)', color: 'var(--terracotta)' }}>
              #{t}
            </span>
          ))}
        </div>
      </div>

      {/* Progress / Processing */}
      {stage !== 'idle' && (
        <ProcessingStage stage={stage} pct={pct} />
      )}

      {err && <div style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 14, background: 'rgba(255,77,109,0.1)', border: '1px solid rgba(255,77,109,0.2)', color: 'var(--error)', fontSize: 13 }}>{err}</div>}

      <Btn onClick={submit} disabled={!canSubmit || stage !== 'idle'} fill style={{ width: '100%', marginTop: 8 }}>
        {stage === 'uploading' ? <><Spinner size={18} color="#000" /> UPLOADING…</> : 'PUBLISH REEL'}
      </Btn>
    </div>
  );
}

function ProcessingStage({ stage, pct }: { stage: Stage; pct: number }) {
  const stages = [
    { id: 'uploading', label: 'Audio uploaded', icon: Upload },
    { id: 'processing', label: 'Acoustic analysis', icon: Radio },
    { id: 'analyzing', label: 'Transcription', icon: Headphones },
    { id: 'transcoding', label: 'HLS transcoding', icon: Globe },
  ];
  const done = stages.findIndex(s => s.id === stage);

  return (
    <div style={{ marginBottom: 18, padding: 16, background: 'var(--surface)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border)' }}>
      <p style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--on-surface)', marginBottom: 12 }}>
        Processing your Echo
      </p>
      <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'var(--surface-container)', overflow: 'hidden', marginBottom: 12 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--terracotta), var(--accent-hover))', transition: 'width 0.25s ease', boxShadow: '0 0 8px var(--accent-glow)' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stages.map((s, i) => {
          const active = i === done;
          const complete = i < done;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 16, display: 'flex', justifyContent: 'center' }}>
                {complete ? <Check size={14} color="var(--sage)" /> : active ? <Spinner size={14} color="var(--terracotta)" /> : <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--outline)' }} />}
              </span>
              <span style={{ color: complete ? 'var(--sage)' : active ? 'var(--terracotta)' : 'var(--outline)', fontWeight: complete ? 600 : active ? 700 : 400, fontFamily: active ? 'var(--font-display)' : 'var(--font-body)' }}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}