import React, { useState, useRef, useEffect } from 'react';
import { Volume2, Play, Gauge, CheckCircle2, Sparkles } from 'lucide-react';
import { TtsProviderType } from '../../server/types';
import { SPEAKING_SPEED_OPTIONS, DEFAULT_SPEED_ID, getSpeedOption } from '../utils/speed';
import { CHARACTER_VOICE_OPTIONS } from '../utils/editorMath';

export const VoiceStudioView: React.FC = () => {
  const [provider, setProvider] = useState<TtsProviderType>('edge');
  const [voiceId, setVoiceId] = useState<string>('my-MM-NilarNeural');
  const [rate, setRate] = useState<string>(() => {
    try {
      return localStorage.getItem('MYAI_SPEAKING_RATE') || DEFAULT_SPEED_ID;
    } catch {
      return DEFAULT_SPEED_ID;
    }
  });
  const [sampleText, setSampleText] = useState(
    'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ တရုတ်ရုပ်ရှင် ဇာတ်လမ်းပြန်ပြော အသံထွက် စနစ်ကို စမ်းသပ်နေပါတယ်။'
  );
  const [generating, setGenerating] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch('/api/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg?.ttsProvider) setProvider(cfg.ttsProvider);
        if (cfg?.defaultVoice) setVoiceId(cfg.defaultVoice);
      })
      .catch(() => {});
  }, []);

  const showNotice = (type: 'success' | 'error', text: string) => {
    setNotice({ type, text });
    setTimeout(() => setNotice((p) => (p?.text === text ? null : p)), 4000);
  };

  const handlePreview = async () => {
    try {
      setGenerating(true);
      const res = await fetch('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId,
          rate,
          sampleText,
          provider,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'အသံထုတ်လုပ်မှု မအောင်မြင်ပါ');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveDefaultVoice = async () => {
    try {
      setSavingDefault(true);
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsProvider: provider,
          defaultVoice: voiceId,
        }),
      });
      if (!res.ok) throw new Error('သိမ်းဆည်းခြင်း မအောင်မြင်ပါ');
      try {
        localStorage.setItem('MYAI_SPEAKING_RATE', rate);
      } catch {}
      showNotice('success', 'မူလ AI အသံနှင့် TTS Engine ကို သိမ်းဆည်းပြီးပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setSavingDefault(false);
    }
  };

  const PRESETS = [
    'ဒီနေ့ည သူတို့နှစ်ယောက်ကြားက လျှို့ဝှက်ချက်အားလုံး ပေါ်ထွက်လာတော့မှာပါ။',
    'သူ ဘာကြောင့် နောက်ပြန်မလှည့်ဘဲ ထွက်သွားခဲ့တာလဲဆိုတာ နောက်ဆုံးခန်းမှာ သိရပါလိမ့်မယ်။',
    'ငါ မင်းကို ဘယ်တုန်းကမှ လိမ်ညာခဲ့ဖူးတာ မရှိဘူး။',
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-16">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Volume2 className="w-6 h-6 text-violet-400" />
            <span>အသံ စတူဒီယို (Voice Studio)</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            မြန်မာ AI အသံအင်ဂျင် ၃ မျိုး (Edge Neural, Google Voice, Gemini 3.8 TTS) နှင့် စကားပြောနှုန်း 0.75x – 3.00x ကို စမ်းသပ်နားထောင်ပါ။
          </p>
        </div>

        <button
          type="button"
          onClick={handleSaveDefaultVoice}
          disabled={savingDefault}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-semibold text-white cursor-pointer whitespace-nowrap shrink-0"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{savingDefault ? 'သိမ်းနေသည်...' : 'မူလအသံအဖြစ် သတ်မှတ်မည်'}</span>
        </button>
      </div>

      {notice && (
        <div
          className={`p-3.5 rounded-xl border text-xs ${
            notice.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Provider & Character Voices */}
        <div className="lg:col-span-2 p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-6">
          <div className="space-y-2.5">
            <label className="text-xs font-semibold text-slate-300">
              ၁။ TTS Provider Engine ရွေးချယ်ရန်
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {[
                { id: 'edge' as TtsProviderType, label: 'Edge Neural TTS', desc: 'မြန်မာ Nilar / Thiha' },
                { id: 'google' as TtsProviderType, label: 'Google Myanmar TTS', desc: 'မြန်မာ စကားပြောအသံ' },
                { id: 'gemini' as TtsProviderType, label: 'Gemini 3.8 TTS', desc: 'Multi-character Studio Voices' },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProvider(p.id)}
                  className={`p-3 rounded-xl border text-left cursor-pointer transition-colors ${
                    provider === p.id
                      ? 'bg-violet-600/20 border-violet-500 text-white'
                      : 'bg-[#060913] border-white/[0.08] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <p className="text-xs font-semibold">{p.label}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{p.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <label className="text-xs font-semibold text-slate-300">
              ၂။ ဇာတ်ကောင်အသံ ရွေးချယ်ရန် (Character / Narrator Voice)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {CHARACTER_VOICE_OPTIONS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVoiceId(v.id)}
                  className={`p-3 rounded-xl border text-left cursor-pointer transition-colors ${
                    voiceId === v.id
                      ? 'bg-violet-600/20 border-violet-500 text-white'
                      : 'bg-[#060913] border-white/[0.08] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <p className="text-xs font-semibold">{v.label}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {v.gender === 'female' ? 'အမျိုးသမီး' : 'အမျိုးသား'} · {v.tone}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300">
                ၃။ စမ်းသပ်မည့် မြန်မာစာသား
              </label>
              <div className="flex items-center gap-1.5 flex-wrap">
                {PRESETS.map((txt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setSampleText(txt)}
                    className="text-[11px] px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-violet-300 cursor-pointer"
                  >
                    နမူနာ {idx + 1}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              rows={3}
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              className="w-full p-3 rounded-xl bg-[#060913] border border-white/10 text-sm text-white leading-relaxed"
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-4 pt-2">
            <button
              type="button"
              onClick={handlePreview}
              disabled={generating || !sampleText.trim()}
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Play className="w-4 h-4" />
              <span>{generating ? 'အသံထုတ်လုပ်နေသည်...' : 'အသံထုတ်၍ နားထောင်မည်'}</span>
            </button>

            <audio ref={audioRef} controls className="w-full h-10" />
          </div>
        </div>

        {/* Right: 9 Speaking Speeds */}
        <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-4">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Gauge className="w-4 h-4 text-violet-400" />
              <span>စကားပြောနှုန်း (Speed)</span>
            </h2>
            <span className="font-mono text-xs font-bold text-violet-300">{rate}</span>
          </div>

          <div className="grid grid-cols-1 gap-1.5">
            {SPEAKING_SPEED_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setRate(s.id)}
                className={`px-3 py-2 rounded-xl border flex items-center justify-between text-xs cursor-pointer transition-colors ${
                  rate === s.id
                    ? 'bg-violet-600/20 border-violet-500 text-white'
                    : 'bg-[#060913] border-white/[0.06] text-slate-400 hover:text-slate-200'
                }`}
              >
                <span className="font-mono font-semibold">{s.id}</span>
                <span>{s.burmeseName}</span>
              </button>
            ))}
          </div>

          <p className="text-[11px] text-slate-400 pt-2 border-t border-white/[0.06]">
            <Sparkles className="w-3.5 h-3.5 inline mr-1 text-violet-400" />
            {getSpeedOption(rate).description}
          </p>
        </div>
      </div>
    </div>
  );
};
