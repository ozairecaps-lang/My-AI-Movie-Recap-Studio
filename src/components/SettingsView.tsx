import React, { useState, useEffect, useRef } from 'react';
import {
  Settings as SettingsIcon,
  Key,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Play,
  Pause,
  Save,
  RefreshCw,
  Cpu,
  Mic,
  Clock,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import { SpeechSegment, TtsProviderType, TextProviderType, ProviderConfig } from '../../server/types';
import {
  DUBBING_VOICE_OPTIONS,
  DEFAULT_DUBBING_VOICE_ID,
  resolveSingleDubbingVoice,
} from '../utils/editorMath';

interface SettingsViewProps {
  groqApiKey: string;
  onSaveGroqApiKey: (key: string) => void;
}

interface GroqStatus {
  isAvailable: boolean;
  maskedKey: string | null;
  model: string;
  language: string;
}

interface GroqTestResult {
  success: boolean;
  model: string;
  language: string;
  text: string;
  duration: number;
  segments: SpeechSegment[];
  error?: string;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  groqApiKey,
  onSaveGroqApiKey,
}) => {
  const [localKey, setLocalKey] = useState(groqApiKey);
  const [savingKey, setSavingKey] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Provider Config Adapter State
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
    ttsProvider: 'edge',
    textProvider: 'gemini',
    defaultVoice: 'my-MM-NilarNeural',
    dubbingDefaultVoice: DEFAULT_DUBBING_VOICE_ID,
    geminiTtsVoice: 'Kore',
    updatedAt: '',
  });
  const [savingProviders, setSavingProviders] = useState(false);

  // Gemini Live Readiness Check
  const [testingGemini, setTestingGemini] = useState(false);
  const [geminiCheckResult, setGeminiCheckResult] = useState<{ ok: boolean; msg: string } | null>(
    null
  );

  // Groq Verification State
  const [groqStatus, setGroqStatus] = useState<GroqStatus | null>(null);
  const [verifyingStatus, setVerifyingStatus] = useState(false);
  const [isTestingGroq, setIsTestingGroq] = useState(false);
  const [groqTestResult, setGroqTestResult] = useState<GroqTestResult | null>(null);
  const [groqTestError, setGroqTestError] = useState<string | null>(null);

  const [isPlayingSample, setIsPlayingSample] = useState(false);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);
  const [health, setHealth] = useState<any>(null);

  const showNotice = (type: 'success' | 'error', text: string) => {
    setBanner({ type, text });
    setTimeout(() => setBanner((p) => (p?.text === text ? null : p)), 4000);
  };

  const fetchGroqStatus = async () => {
    try {
      setVerifyingStatus(true);
      const res = await fetch('/api/groq/verify');
      if (res.ok) setGroqStatus(await res.json());
    } finally {
      setVerifyingStatus(false);
    }
  };

  useEffect(() => {
    fetchGroqStatus();
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setHealth(d))
      .catch(() => {});
    fetch('/api/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d) =>
          d &&
          setProviderConfig({
            ...d,
            dubbingDefaultVoice: resolveSingleDubbingVoice(d.dubbingDefaultVoice),
          })
      )
      .catch(() => {});
  }, []);

  const handleSaveProviders = async () => {
    try {
      setSavingProviders(true);
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerConfig),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Provider settings save failed');
      setProviderConfig(data.config);
      showNotice('success', 'AI နှင့် TTS Provider ဆက်တင်များကို သိမ်းဆည်းပြီးပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setSavingProviders(false);
    }
  };

  const handleTestGemini = async () => {
    try {
      setTestingGemini(true);
      setGeminiCheckResult(null);
      const res = await fetch('/api/test-gemini');
      const data = await res.json();
      if (res.ok && data.success) {
        setGeminiCheckResult({ ok: true, msg: `Connected (${data.model})` });
      } else {
        setGeminiCheckResult({
          ok: false,
          msg: data.error || 'Gemini connection failed on server',
        });
      }
    } catch (err: any) {
      setGeminiCheckResult({ ok: false, msg: err.message });
    } finally {
      setTestingGemini(false);
    }
  };

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localKey.trim()) return;
    try {
      setSavingKey(true);
      const res = await fetch('/api/groq/save-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: localKey.trim() }),
      });
      if (res.ok) {
        onSaveGroqApiKey(localKey.trim());
        await fetchGroqStatus();
        showNotice('success', 'Groq API Key ကို ဆာဗာတွင် လုံခြုံစွာ သိမ်းဆည်းပြီးပါပြီ');
      } else {
        const data = await res.json();
        showNotice('error', data.error || 'Groq API Key သိမ်းဆည်းခြင်း မအောင်မြင်ပါ');
      }
    } catch (err: any) {
      showNotice('error', err.message || 'ဆာဗာသို့ ချိတ်ဆက်၍ မရပါ');
    } finally {
      setSavingKey(false);
    }
  };

  const handleTestGroqConnection = async () => {
    try {
      setIsTestingGroq(true);
      setGroqTestError(null);
      setGroqTestResult(null);
      const res = await fetch('/api/groq/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groqApiKey: localKey.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setGroqTestError(data.error || 'Groq Whisper API စစ်ဆေးမှု မအောင်မြင်ပါ');
      } else {
        setGroqTestResult(data);
        await fetchGroqStatus();
      }
    } catch (err: any) {
      setGroqTestError(err.message || 'ကွန်ရက် ချိတ်ဆက်မှု အမှားဖြစ်ပေါ်ခဲ့သည်');
    } finally {
      setIsTestingGroq(false);
    }
  };

  const handleTogglePlaySample = () => {
    if (!sampleAudioRef.current) return;
    if (isPlayingSample) {
      sampleAudioRef.current.pause();
      setIsPlayingSample(false);
    } else {
      sampleAudioRef.current
        .play()
        .then(() => setIsPlayingSample(true))
        .catch(() => {});
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-16">
      <audio
        ref={sampleAudioRef}
        src="/api/groq/sample-audio"
        onEnded={() => setIsPlayingSample(false)}
        className="hidden"
      />

      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-violet-400" />
          <span>ဆက်တင် & AI Provider Settings</span>
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          TTS Engine Adapter၊ Text/Translation Provider၊ Gemini Multimodal နှင့် Groq Whisper Large V3 တို့ကို စီမံစစ်ဆေးပါ။
        </p>
      </div>

      {banner && (
        <div
          className={`p-3.5 rounded-xl border text-xs ${
            banner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* AI Service Readiness Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-2.5">
          <p className="text-xs font-mono text-violet-300">Story & Vision AI</p>
          <h3 className="font-bold text-white text-sm">Google Gemini Multimodal</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Server-side GEMINI_API_KEY ဖြင့် Story Recap, OCR, Translation နှင့် Gemini 3.8 TTS တို့ကို လုပ်ဆောင်ပါသည်။
          </p>
          <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs">
            <span className={health?.geminiConfigured ? 'text-emerald-400 font-medium' : 'text-amber-400'}>
              {health?.geminiConfigured ? 'Server Configured' : 'Missing Key'}
            </span>
            <button
              type="button"
              onClick={handleTestGemini}
              disabled={testingGemini}
              className="text-violet-300 hover:text-white font-semibold cursor-pointer"
            >
              {testingGemini ? 'Testing...' : 'Test Gemini'}
            </button>
          </div>
          {geminiCheckResult && (
            <p
              className={`text-[11px] font-mono ${
                geminiCheckResult.ok ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {geminiCheckResult.msg}
            </p>
          )}
        </div>

        <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-2.5">
          <p className="text-xs font-mono text-blue-300">Mandarin ASR</p>
          <h3 className="font-bold text-white text-sm">Groq Whisper Large V3</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            whisper-large-v3 (`language: zh`, `verbose_json`) ဖြင့် တိကျသော တရုတ်စကားပြော timestamps ထုတ်ပေးသည်။
          </p>
          <div className="pt-2 border-t border-white/[0.06] text-xs">
            {groqStatus?.isAvailable ? (
              <span className="text-emerald-400 font-medium font-mono">
                Ready ({groqStatus.maskedKey})
              </span>
            ) : (
              <span className="text-amber-400 font-medium">Not configured yet</span>
            )}
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-2.5">
          <p className="text-xs font-mono text-emerald-300">Burmese TTS & FFmpeg</p>
          <h3 className="font-bold text-white text-sm">FFmpeg & HarfBuzz Engine</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Noto Sans Myanmar ယူနီကုဒ်စာတန်း၊ atempo (0.75x–3.00x) နှင့် Background Blur/Masking ထောက်ပံ့ထားသည်။
          </p>
          <div className="pt-2 border-t border-white/[0.06] text-xs text-emerald-400 font-medium">
            FFmpeg Core Active · Max {health?.maxUploadMb ?? 100} MB
          </div>
        </div>
      </div>

      {/* AI Provider Adapter Panel */}
      <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Sliders className="w-5 h-5 text-violet-400" />
              <span>AI & TTS Provider Adapter</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              ပရောဂျက်အသစ်များအတွက် အသုံးပြုမည့် မြန်မာ TTS Engine နှင့် Script/Translation LLM ကို ပြောင်းလဲသတ်မှတ်နိုင်ပါသည်။
            </p>
          </div>
          <button
            type="button"
            onClick={handleSaveProviders}
            disabled={savingProviders}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 text-white text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{savingProviders ? 'သိမ်းနေ...' : 'Provider ဆက်တင် သိမ်းမည်'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2.5">
            <label className="text-xs font-semibold text-slate-300">
              Active Burmese TTS Provider
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'edge' as TtsProviderType, label: 'Edge Neural' },
                { id: 'google' as TtsProviderType, label: 'Google TTS' },
                { id: 'gemini' as TtsProviderType, label: 'Gemini TTS' },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProviderConfig({ ...providerConfig, ttsProvider: p.id })}
                  className={`p-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                    providerConfig.ttsProvider === p.id
                      ? 'bg-violet-600/20 border-violet-500 text-white'
                      : 'bg-[#060913] border-white/[0.08] text-slate-400 hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <label className="text-xs font-semibold text-slate-300">
              Active Text & Translation Engine
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'gemini' as TextProviderType, label: 'Gemini 4 Hydrogen' },
                { id: 'groq' as TextProviderType, label: 'Groq Llama 3.3 70B' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setProviderConfig({ ...providerConfig, textProvider: t.id })}
                  className={`p-3 rounded-xl border text-xs font-semibold cursor-pointer ${
                    providerConfig.textProvider === t.id
                      ? 'bg-blue-600/20 border-blue-500 text-white'
                      : 'bg-[#060913] border-white/[0.08] text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
          <div className="space-y-1.5">
            <label className="text-xs text-slate-400">Default Recap Narrator Voice</label>
            <select
              value={providerConfig.defaultVoice}
              onChange={(e) =>
                setProviderConfig({ ...providerConfig, defaultVoice: e.target.value })
              }
              className="w-full px-3 py-2 rounded-xl bg-[#060913] border border-white/10 text-xs text-white cursor-pointer"
            >
              <option value="my-MM-NilarNeural">နီလာ (my-MM-NilarNeural - Female)</option>
              <option value="my-MM-ThihaNeural">သီဟ (my-MM-ThihaNeural - Male)</option>
              <option value="gemini-Kore">Gemini Kore (Female)</option>
              <option value="gemini-Charon">Gemini Charon (Male)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-slate-400">Default Dubbing Voice (Single Voice)</label>
            <select
              value={resolveSingleDubbingVoice(providerConfig.dubbingDefaultVoice)}
              onChange={(e) =>
                setProviderConfig({ ...providerConfig, dubbingDefaultVoice: e.target.value })
              }
              className="w-full px-3 py-2 rounded-xl bg-[#060913] border border-white/10 text-xs text-white cursor-pointer"
            >
              {DUBBING_VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.englishLabel} · Gemini 3.8 TTS
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-slate-400">Default Gemini TTS Voice</label>
            <select
              value={providerConfig.geminiTtsVoice}
              onChange={(e) =>
                setProviderConfig({
                  ...providerConfig,
                  geminiTtsVoice: e.target.value as any,
                })
              }
              className="w-full px-3 py-2 rounded-xl bg-[#060913] border border-white/10 text-xs text-white cursor-pointer"
            >
              {['Kore', 'Charon', 'Puck', 'Fenrir', 'Zephyr'].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* GROQ WHISPER INTEGRATION & VERIFICATION PANEL */}
      <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Mic className="w-5 h-5 text-blue-400" />
              <span>Groq Whisper Large V3 စစ်ဆေးခြင်း</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              တရုတ်စကားပြော speech-to-text (whisper-large-v3) ချိတ်ဆက်မှုကို တိုက်ရိုက်စမ်းသပ်စစ်ဆေးပါ။
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTogglePlaySample}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-violet-300 text-xs font-medium cursor-pointer"
            >
              {isPlayingSample ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isPlayingSample ? 'ရပ်မည်' : 'စမ်းသပ် တရုတ်အသံ'}</span>
            </button>

            <button
              type="button"
              onClick={fetchGroqStatus}
              disabled={verifyingStatus}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-300 text-xs font-medium cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${verifyingStatus ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#060913] border border-white/[0.06] flex items-center gap-3 text-xs">
          <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
          <div>
            <p className="font-semibold text-slate-200">ဆာဗာ GROQ_API_KEY အခြေအနေ</p>
            <p className="text-slate-400 font-mono mt-0.5">
              {groqStatus?.isAvailable
                ? `Connected: ${groqStatus.maskedKey} (${groqStatus.model})`
                : 'GROQ_API_KEY not set on server yet'}
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveKey} className="space-y-2.5">
          <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Key className="w-3.5 h-3.5 text-blue-400" />
            <span>Groq API Key (gsk_...)</span>
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="password"
              value={localKey}
              onChange={(e) => setLocalKey(e.target.value)}
              placeholder="gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="flex-1 px-4 py-2.5 rounded-xl bg-[#060913] border border-white/10 text-white text-xs font-mono"
            />
            <button
              type="submit"
              disabled={savingKey || !localKey.trim()}
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{savingKey ? 'သိမ်းနေ...' : 'ဆာဗာတွင် သိမ်းမည်'}</span>
            </button>
          </div>
        </form>

        <div className="pt-3 border-t border-white/[0.06] space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-xs text-slate-300">
              တရုတ်အသံဖိုင်အစစ်ဖြင့် Whisper Large V3 (`zh`, `verbose_json`) ချိတ်ဆက်မှုကို တိုက်ရိုက်စမ်းသပ်ပါ။
            </p>
            <button
              type="button"
              onClick={handleTestGroqConnection}
              disabled={isTestingGroq}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 text-white text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Sparkles className={`w-4 h-4 ${isTestingGroq ? 'animate-spin' : ''}`} />
              <span>{isTestingGroq ? 'စမ်းသပ်နေ...' : 'Groq API ချိတ်ဆက်မှု စမ်းသပ်မည်'}</span>
            </button>
          </div>

          {groqTestError && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-3 text-xs text-rose-200">
              <span className="font-mono">{groqTestError}</span>
              <button
                type="button"
                onClick={handleTestGroqConnection}
                className="px-3 py-1 rounded-lg bg-rose-600 text-white font-semibold cursor-pointer shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {groqTestResult?.success && (
            <div className="p-4 rounded-xl bg-[#060913] border border-emerald-500/35 space-y-3 text-xs">
              <div className="flex items-center justify-between text-emerald-300 font-semibold">
                <span>Whisper Large V3 Transcribed ({groqTestResult.duration.toFixed(2)}s)</span>
                <span className="font-mono">{groqTestResult.language}</span>
              </div>
              <p className="text-white leading-relaxed">{groqTestResult.text}</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {groqTestResult.segments.map((seg) => (
                  <div
                    key={seg.id}
                    className="flex items-center justify-between text-slate-300 border-t border-white/[0.05] pt-1"
                  >
                    <span>{seg.text}</span>
                    <span className="font-mono text-violet-300 tabular-nums ml-3">
                      [{seg.start.toFixed(2)}s – {seg.end.toFixed(2)}s]
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* System Font Info */}
      <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] flex items-start gap-3 text-xs text-slate-400">
        <Cpu className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
        <p>
          Noto Sans Myanmar ယူနီကုဒ်ဖောင့်နှင့် FFmpeg HarfBuzz / libass စနစ်ဖြင့် စာတန်းများကို ကြည်လင်ပြတ်သားစွာ ရေးထိုးပေးပါသည်။
        </p>
      </div>
    </div>
  );
};
