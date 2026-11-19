import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  FileVideo,
  X,
  Volume2,
  Play,
  Sliders,
  AlertCircle,
  Gauge,
  Subtitles,
  Clapperboard,
  Mic,
  EyeOff,
} from 'lucide-react';
import { ProcessingMode, RecapNarrationStyle } from '../../server/types';
import { SPEAKING_SPEED_OPTIONS, DEFAULT_SPEED_ID, getSpeedOption } from '../utils/speed';
import {
  AutoBlurConfig,
  AutoBlurStyle,
  DEFAULT_AUTO_BLUR_CONFIG,
  sanitizeAutoBlurConfig,
} from '../utils/autoBlur';
import {
  validateUploadVideoFile,
  MAX_UPLOAD_BYTES,
  DUBBING_VOICE_OPTIONS,
  DEFAULT_DUBBING_VOICE_ID,
  resolveSingleDubbingVoice,
} from '../utils/editorMath';

interface CreateRecapViewProps {
  initialMode?: ProcessingMode;
  onUploadSuccess: (project: any) => void;
  onStartDemo: (mode: ProcessingMode) => void;
  loadingDemo?: boolean;
  groqApiKey?: string;
}

export const CreateRecapView: React.FC<CreateRecapViewProps> = ({
  initialMode = 'recap',
  onUploadSuccess,
  onStartDemo,
  loadingDemo = false,
  groqApiKey,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [mode, setMode] = useState<ProcessingMode>(initialMode);
  const [recapLength, setRecapLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [narrationStyle, setNarrationStyle] = useState<RecapNarrationStyle>('dramatic');
  const [ttsVoice, setTtsVoice] = useState<string>(() => {
    try {
      return localStorage.getItem('MYAI_RECAP_VOICE') || 'my-MM-NilarNeural';
    } catch {
      return 'my-MM-NilarNeural';
    }
  });
  const [dubbingVoice, setDubbingVoice] = useState<string>(() => {
    try {
      return resolveSingleDubbingVoice(localStorage.getItem('MYAI_DUBBING_VOICE'));
    } catch {
      return DEFAULT_DUBBING_VOICE_ID;
    }
  });
  const [speakingRate, setSpeakingRate] = useState<string>(() => {
    try {
      return localStorage.getItem('MYAI_SPEAKING_RATE') || DEFAULT_SPEED_ID;
    } catch {
      return DEFAULT_SPEED_ID;
    }
  });
  const [originalAudioVolume, setOriginalAudioVolume] = useState<number>(
    initialMode === 'subtitle' ? 1.0 : 0.15
  );
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [autoBlurConfig, setAutoBlurConfig] = useState<AutoBlurConfig>(() => {
    try {
      const saved = localStorage.getItem('MYAI_AUTO_BLUR_CONFIG');
      return saved ? sanitizeAutoBlurConfig(JSON.parse(saved)) : DEFAULT_AUTO_BLUR_CONFIG;
    } catch {
      return DEFAULT_AUTO_BLUR_CONFIG;
    }
  });

  const [previewingVoice, setPreviewingVoice] = useState(false);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMode(initialMode);
    setOriginalAudioVolume(initialMode === 'subtitle' ? 1.0 : 0.15);
  }, [initialMode]);

  const handleSetSpeakingRate = (rateId: string) => {
    setSpeakingRate(rateId);
    try {
      localStorage.setItem('MYAI_SPEAKING_RATE', rateId);
    } catch {}
  };

  const handleUpdateAutoBlur = (patch: Partial<AutoBlurConfig>) => {
    setAutoBlurConfig((prev) => {
      const next = sanitizeAutoBlurConfig({ ...prev, ...patch });
      try {
        localStorage.setItem('MYAI_AUTO_BLUR_CONFIG', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const handleSetRecapVoice = (voiceId: string) => {
    setTtsVoice(voiceId);
    try {
      localStorage.setItem('MYAI_RECAP_VOICE', voiceId);
    } catch {}
  };

  const handleSetDubbingVoice = (voiceId: string) => {
    const valid = resolveSingleDubbingVoice(voiceId);
    setDubbingVoice(valid);
    try {
      localStorage.setItem('MYAI_DUBBING_VOICE', valid);
    } catch {}
  };

  const handleSelectMode = (newMode: ProcessingMode) => {
    setMode(newMode);
    setOriginalAudioVolume(newMode === 'subtitle' ? 1.0 : 0.15);
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleValidateAndSetFile(e.dataTransfer.files[0]);
    }
  };

  const handleValidateAndSetFile = (selectedFile: File) => {
    setErrorMessage(null);
    const check = validateUploadVideoFile(selectedFile, MAX_UPLOAD_BYTES);
    if (!check.valid) {
      setErrorMessage(check.error || 'ဖိုင် မမှန်ကန်ပါ');
      return;
    }
    setFile(selectedFile);
    if (!title) {
      setTitle(selectedFile.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handlePlayVoicePreview = async (voiceId: string, rateOverride?: string) => {
    try {
      setPreviewingVoice(true);
      const targetRate = rateOverride || speakingRate;
      const res = await fetch('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, rate: targetRate }),
      });
      if (!res.ok) throw new Error('အသံစမ်းသပ်မှု မအောင်မြင်ပါ');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioPreviewRef.current) {
        audioPreviewRef.current.src = url;
        audioPreviewRef.current.play();
      }
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setPreviewingVoice(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setErrorMessage('ကျေးဇူးပြု၍ တရုတ်ဗီဒီယိုဖိုင်တစ်ခု ရွေးချယ်ပါ');
      return;
    }

    setUploading(true);
    setUploadProgress(10);
    setErrorMessage(null);

    const activeVoice = mode === 'dubbing' ? dubbingVoice : ttsVoice;
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', title || file.name.replace(/\.[^/.]+$/, ''));
    formData.append('mode', mode);
    formData.append('recapLength', recapLength);
    formData.append('narrationStyle', narrationStyle);
    formData.append('ttsVoice', activeVoice);
    if (mode === 'dubbing') {
      formData.append('dubbingVoice', dubbingVoice);
      formData.append('ttsProvider', 'gemini');
    }
    formData.append('speakingRate', speakingRate);
    formData.append('originalAudioVolume', String(originalAudioVolume));
    formData.append('burnSubtitles', String(burnSubtitles));
    formData.append('autoBlur', JSON.stringify(autoBlurConfig));
    if (groqApiKey && groqApiKey.trim()) {
      formData.append('groqApiKey', groqApiKey.trim());
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/projects/upload');

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          setUploadProgress(Math.round((evt.loaded / evt.total) * 90));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const project = JSON.parse(xhr.responseText);
          setUploadProgress(100);
          onUploadSuccess(project);
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            setErrorMessage(err.error || 'ဗီဒီယို အပ်လုဒ်တင်ခြင်း မအောင်မြင်ပါ');
          } catch {
            setErrorMessage('ဗီဒီယို အပ်လုဒ်တင်ခြင်း မအောင်မြင်ပါ');
          }
          setUploading(false);
        }
      };

      xhr.onerror = () => {
        setErrorMessage('ဆာဗာသို့ ချိတ်ဆက်မှု မအောင်မြင်ပါ');
        setUploading(false);
      };

      xhr.send(formData);
    } catch (err: any) {
      setErrorMessage(err.message || 'ဗီဒီယို အပ်လုဒ်တင်စဉ် အမှားအယွင်း ဖြစ်ပေါ်ခဲ့သည်');
      setUploading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-16">
      <audio ref={audioPreviewRef} className="hidden" />

      <div className="space-y-1.5">
        <h1 className="text-2xl font-bold text-white tracking-tight">
          ပရောဂျက် အသစ်ဖန်တီးမည် (Create Project)
        </h1>
        <p className="text-sm text-slate-400">
          တရုတ်ဗီဒီယိုဖိုင် (MP4, MOV, MKV, WebM · အများဆုံး 100 MB) ကို တင်သွင်းပြီး လုပ်ဆောင်လိုသော စနစ် ၃ မျိုးထဲမှ တစ်ခုကို ရွေးချယ်ပါ။
        </p>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-3 text-rose-200 text-sm"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-400" />
          <div className="flex-1">
            <p className="font-semibold">သတိပေးချက်</p>
            <p className="text-xs text-rose-300 mt-0.5">{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
            className="text-rose-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-7">
        {/* Step 1: Processing Mode Selector (Strictly 3 modes) */}
        <div className="space-y-3">
          <label className="block text-sm font-semibold text-slate-200">
            ၁။ လုပ်ဆောင်မှု စနစ် ရွေးချယ်ရန် (Processing Mode)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                id: 'subtitle' as ProcessingMode,
                title: 'Subtitle Mode',
                sub: 'မြန်မာစာတန်းထိုးစနစ်',
                desc: 'မူရင်းအသံထိန်းသိမ်း၍ SRT/ASS/MP4 စာတန်းထုတ်မည်',
                icon: <Subtitles className="w-4 h-4 text-blue-400" />,
              },
              {
                id: 'recap' as ProcessingMode,
                title: 'Recap Mode',
                sub: 'ဇာတ်လမ်းပြန်ပြောစနစ်',
                desc: 'ဇာတ်ကြောင်းခွဲခြမ်း၍ မြန်မာအသံဖြင့် ဇာတ်လမ်းရှင်းပြမည်',
                icon: <Clapperboard className="w-4 h-4 text-violet-400" />,
              },
              {
                id: 'dubbing' as ProcessingMode,
                title: 'Dubbing Mode',
                sub: 'မြန်မာအသံသွင်းစနစ် (Single Voice · Silence 1.0x)',
                desc: 'Groq ဖြင့် စကားပြောနှင့် Silence ခွဲ၍ Gemini TTS အသံတစ်မျိုးတည်းဖြင့် စကားပြောအပိုင်းကိုသာ အချိန်ညှိအသံသွင်းမည် (Silence ကို 1.0x ထိန်းသိမ်း)',
                icon: <Mic className="w-4 h-4 text-indigo-400" />,
              },
            ].map((m) => {
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleSelectMode(m.id)}
                  className={`p-4 rounded-xl border text-left transition-colors cursor-pointer space-y-1.5 ${
                    active
                      ? 'bg-violet-600/20 border-violet-500 text-white'
                      : 'bg-[#0B1020]/80 border-white/[0.08] text-slate-300 hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {m.icon}
                    <span className="text-sm font-semibold">{m.title}</span>
                  </div>
                  <p className="text-xs font-medium text-violet-300">{m.sub}</p>
                  <p className="text-[11px] text-slate-400 leading-relaxed">{m.desc}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2: File Upload Dropzone (100 MB cap) */}
        <div className="space-y-3">
          <label className="block text-sm font-semibold text-slate-200">
            ၂။ တရုတ်ဗီဒီယိုဖိုင် တင်သွင်းရန် (Max 100 MB) <span className="text-rose-400">*</span>
          </label>

          {!file ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-8 sm:p-10 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-violet-400 bg-violet-950/20'
                  : 'border-white/15 hover:border-violet-500/60 bg-[#0B1020]/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleValidateAndSetFile(e.target.files[0]);
                  }
                }}
              />

              <div className="max-w-md mx-auto space-y-4">
                <div className="w-14 h-14 rounded-xl bg-violet-600/15 border border-violet-500/30 flex items-center justify-center mx-auto text-violet-400">
                  <Upload className="w-7 h-7" />
                </div>

                <div className="space-y-1">
                  <p className="text-sm font-semibold text-white">
                    ဗီဒီယိုဖိုင်ကို ဤနေရာတွင် ဆွဲထည့်ပါ (သို့မဟုတ်) နှိပ်၍ ရွေးချယ်ပါ
                  </p>
                  <p className="text-xs text-slate-400">
                    MP4, MOV, MKV, WebM ဖိုင်များ လက်ခံသည် · အများဆုံး 100 MB
                  </p>
                </div>

                <div className="pt-2 flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartDemo(mode);
                    }}
                    disabled={loadingDemo}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-violet-300 border border-white/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Play className="w-3.5 h-3.5 text-violet-400" />
                    <span>{loadingDemo ? 'ဖန်တီးနေသည်...' : `နမူနာ ဗီဒီယိုဖြင့် စမ်းသပ်မည် (${mode})`}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-[#0B1020] border border-violet-500/40 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3.5 min-w-0">
                <div className="w-11 h-11 rounded-lg bg-violet-600/20 flex items-center justify-center text-violet-400 shrink-0">
                  <FileVideo className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-white truncate text-sm">{file.name}</p>
                  <p className="text-xs text-slate-400 tabular-nums">
                    {(file.size / (1024 * 1024)).toFixed(2)} MB · {file.type || 'video'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 cursor-pointer whitespace-nowrap shrink-0"
                >
                  ဖိုင်ပြောင်းမည်
                </button>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 cursor-pointer"
                  aria-label="Remove selected file"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Step 3: Project Title */}
        <div className="space-y-2">
          <label htmlFor="project-title" className="block text-sm font-semibold text-slate-200">
            ၃။ ပရောဂျက် ခေါင်းစဉ် (Project Title)
          </label>
          <input
            id="project-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="ဥပမာ - မြို့တော်ကာကွယ်ရေး တရုတ်ရုပ်ရှင် ဇာတ်လမ်းပြန်ပြော"
            className="w-full px-4 py-2.5 rounded-xl bg-[#0B1020] border border-white/10 focus:border-violet-500 focus:outline-none text-white text-sm"
          />
        </div>

        {/* Step 4: Mode-specific Settings */}
        <div className="p-6 rounded-2xl bg-[#0B1020]/90 border border-white/[0.08] space-y-6">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2 border-b border-white/[0.06] pb-3">
            <Sliders className="w-4 h-4 text-violet-400" />
            <span>၄။ လုပ်ငန်းစဉ် ဆက်တင်များ ({mode.toUpperCase()} Settings)</span>
          </h2>

          {mode === 'recap' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-300">
                  Recap အရှည် (Recap Length)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'short', label: 'တိုတို', sub: '~၁-၂ မိနစ်' },
                    { id: 'medium', label: 'အလယ်အလတ်', sub: '~၃-၄ မိနစ်' },
                    { id: 'long', label: 'အသေးစိတ်', sub: '~၅-၇ မိနစ်' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setRecapLength(opt.id as any)}
                      className={`p-3 rounded-xl border text-center cursor-pointer transition-colors ${
                        recapLength === opt.id
                          ? 'bg-violet-600/20 border-violet-500 text-white'
                          : 'bg-[#060913]/60 border-white/[0.08] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <p className="text-xs font-semibold">{opt.label}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{opt.sub}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-300">
                  ဇာတ်ကြောင်းပြော စတိုင် (Narration Style)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'dramatic', label: 'ဒရမ်မာဆန်ဆန် (Dramatic)' },
                    { id: 'informative', label: 'ရှင်းလင်းပြတ်သား (Analytic)' },
                    { id: 'suspense', label: 'သည်းထိတ်ရင်ဖို (Suspense)' },
                    { id: 'casual', label: 'ပေါ့ပေါ့ပါးပါး (Casual)' },
                  ].map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => setNarrationStyle(st.id as RecapNarrationStyle)}
                      className={`p-2.5 rounded-xl border text-left text-xs font-medium cursor-pointer transition-colors ${
                        narrationStyle === st.id
                          ? 'bg-violet-600/20 border-violet-500 text-white'
                          : 'bg-[#060913]/60 border-white/[0.08] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {mode !== 'subtitle' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Voice */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-300">
                    {mode === 'dubbing'
                      ? 'မြန်မာ AI Dubbing အသံ (Single Voice Only — ဇာတ်ကောင်အားလုံးအတွက်)'
                      : 'မူလ မြန်မာ AI အသံ (Narrator Voice)'}
                  </label>
                  <button
                    type="button"
                    onClick={() => handlePlayVoicePreview(mode === 'dubbing' ? dubbingVoice : ttsVoice)}
                    disabled={previewingVoice}
                    className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 font-medium cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>{previewingVoice ? 'ဖွင့်နေသည်...' : 'အသံစမ်းမည်'}</span>
                  </button>
                </div>

                {mode === 'dubbing' ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {DUBBING_VOICE_OPTIONS.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => handleSetDubbingVoice(v.id)}
                          className={`p-3 rounded-xl border text-left cursor-pointer transition-colors ${
                            dubbingVoice === v.id
                              ? 'bg-violet-600/20 border-violet-500 text-white'
                              : 'bg-[#060913]/60 border-white/[0.08] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <p className="text-xs font-semibold">{v.englishLabel}</p>
                          <p className="text-[11px] text-slate-400 mt-0.5">{v.label}</p>
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-400">
                      ရွေးချယ်ထားသော Gemini 3.8 TTS အသံတစ်မျိုးတည်းကို Speaking အပိုင်းများတွင်သာ အသုံးပြုပြီး Silence အပိုင်းများကို မူရင်း 1.0x အတိုင်း ထိန်းသိမ်းပါမည်။
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'my-MM-NilarNeural', label: 'နီလာ (မ)', desc: 'Edge Neural' },
                      { id: 'my-MM-ThihaNeural', label: 'သီဟ (ကျား)', desc: 'Edge Neural' },
                      { id: 'gemini-Kore', label: 'Kore (မ)', desc: 'Gemini 3.8 TTS' },
                      { id: 'gemini-Charon', label: 'Charon (ကျား)', desc: 'Gemini 3.8 TTS' },
                    ].map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => handleSetRecapVoice(v.id)}
                        className={`p-2.5 rounded-xl border text-left cursor-pointer transition-colors ${
                          ttsVoice === v.id
                            ? 'bg-violet-600/20 border-violet-500 text-white'
                            : 'bg-[#060913]/60 border-white/[0.08] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <p className="text-xs font-semibold">{v.label}</p>
                        <p className="text-[10px] text-slate-400">{v.desc}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Speaking Speed (9 speeds) */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5 text-violet-400" />
                    <span>Speaking Speed · <span className="font-mono text-violet-300">{speakingRate}</span></span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      handlePlayVoicePreview(
                        mode === 'dubbing' ? dubbingVoice : ttsVoice,
                        speakingRate
                      )
                    }
                    disabled={previewingVoice}
                    className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 font-medium cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Preview Speed</span>
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {SPEAKING_SPEED_OPTIONS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleSetSpeakingRate(s.id)}
                      className={`p-2 rounded-lg border text-left cursor-pointer transition-colors ${
                        speakingRate === s.id
                          ? 'bg-violet-600/25 border-violet-400 text-white'
                          : 'bg-[#060913]/60 border-white/[0.08] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <p className="text-xs font-mono font-semibold">{s.id}</p>
                      <p className="text-[10px] text-slate-400 truncate">{s.burmeseName}</p>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  {getSpeedOption(speakingRate).description}
                </p>
              </div>
            </div>
          )}

          {/* Original Audio Mix + Burn Subtitles */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 border-t border-white/[0.06]">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300">မူရင်းတရုတ်အသံ ကျယ်နှုန်း (Original Audio)</span>
                <span className="font-mono text-violet-300 tabular-nums">
                  {Math.round(originalAudioVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={originalAudioVolume}
                onChange={(e) => setOriginalAudioVolume(parseFloat(e.target.value))}
                className="w-full accent-violet-500 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>0% Mute</span>
                <span>15% Background</span>
                <span>100% Original</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-slate-200">
                  ဗီဒီယိုထဲသို့ မြန်မာစာတန်း တိုက်ရိုက်ထိုးမည် (Burn-in Subtitles)
                </p>
                <p className="text-[11px] text-slate-400">
                  Noto Sans Myanmar ဖောင့်ဖြင့် MP4 ထဲသို့ ထည့်သွင်းပေးမည် (SRT/ASS ဖိုင်များလည်း ထုတ်ပေးမည်)
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={burnSubtitles}
                  onChange={(e) => setBurnSubtitles(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-600" />
              </label>
            </div>
          </div>

          {/* Auto Blur Mask Only (Zero manual mask UI) */}
          <div className="pt-4 border-t border-white/[0.06] space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <EyeOff className="w-3.5 h-3.5 text-blue-400" />
                  <span>Auto Blur Mask (အလိုအလျောက် စာသား/Logo/Watermark ဝါးစနစ်)</span>
                </p>
                <p className="text-[11px] text-slate-400">
                  တင်သွင်းသော ဗီဒီယိုထဲမှ မူရင်းစာတန်း၊ Logo၊ Watermark နှင့် Graphic များကို နောက်ကွယ်မှ အလိုအလျောက် ရှာဖွေဝါးပေးပါမည်။
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  aria-label="Toggle Auto Blur"
                  checked={autoBlurConfig.enabled}
                  onChange={(e) => handleUpdateAutoBlur({ enabled: e.target.checked })}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 peer"
                />
                <div className="w-11 h-6 bg-slate-800 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
              </label>
            </div>

            {autoBlurConfig.enabled && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-1">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-300">Blur Strength</span>
                    <span className="font-mono text-blue-300 tabular-nums">{autoBlurConfig.strength}</span>
                  </div>
                  <input
                    type="range"
                    aria-label="Blur Strength"
                    min="2"
                    max="25"
                    step="1"
                    value={autoBlurConfig.strength}
                    onChange={(e) => handleUpdateAutoBlur({ strength: Number(e.target.value) })}
                    className="w-full accent-blue-500 cursor-pointer"
                  />
                </div>

                <div className="space-y-2">
                  <span className="block text-xs font-semibold text-slate-300">Blur Style</span>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'blur' as AutoBlurStyle, label: 'Blur' },
                      { id: 'pixelate' as AutoBlurStyle, label: 'Pixelate' },
                      { id: 'solid' as AutoBlurStyle, label: 'Solid Color' },
                    ].map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => handleUpdateAutoBlur({ style: st.id })}
                        className={`py-2 px-2.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                          autoBlurConfig.style === st.id
                            ? 'bg-blue-600/25 border-blue-400 text-white'
                            : 'bg-[#060913]/60 border-white/[0.08] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Upload Progress */}
        {uploading && (
          <div className="p-4 rounded-xl bg-violet-950/30 border border-violet-500/35 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-violet-200 font-medium">ဆာဗာသို့ ဗီဒီယို တင်သွင်းနေပါသည်...</span>
              <span className="font-mono text-violet-300 tabular-nums">{uploadProgress}%</span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-violet-500 to-blue-500 transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!file || uploading}
            className="inline-flex items-center gap-2 px-7 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
          >
            <span>{uploading ? 'တင်သွင်းနေပါသည်...' : 'ဗီဒီယို လုပ်ဆောင်မှု စတင်မည်'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
