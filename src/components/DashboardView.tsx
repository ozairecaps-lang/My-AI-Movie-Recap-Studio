import React, { useEffect, useState } from 'react';
import {
  Subtitles,
  Clapperboard,
  Mic,
  ArrowRight,
  FolderKanban,
  CheckCircle2,
  Clock,
  HardDrive,
  Server,
  Play,
  Trash2,
  Plus,
} from 'lucide-react';
import { Project, ProcessingMode } from '../../server/types';
import { formatBytes } from '../utils/editorMath';

interface StorageStats {
  totalBytes: number;
  sourceVideosBytes: number;
  renderedExportsBytes: number;
  tempFilesBytes: number;
  projectCount: number;
  activeJobsCount: number;
}

interface HealthInfo {
  geminiConfigured: boolean;
  groqConfigured: boolean;
  ttsProvider: string;
  ttsReady: boolean;
  ffmpegInstalled: boolean;
  maxUploadMb: number;
}

interface DashboardViewProps {
  projects: Project[];
  summary: {
    total: number;
    completed: number;
    processing: number;
    failed: number;
  };
  onNavigateToCreate: (mode?: ProcessingMode) => void;
  onSelectProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onCreateDemo: (mode: ProcessingMode) => void;
  loadingDemo?: boolean;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  projects,
  summary,
  onNavigateToCreate,
  onSelectProject,
  onDeleteProject,
  onCreateDemo,
  loadingDemo = false,
}) => {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setHealth(d))
      .catch(() => {});

    fetch('/api/storage')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStorage(d))
      .catch(() => {});
  }, [projects.length, summary.processing]);

  const recentProjects = projects.slice(0, 5);
  const recentLogs = projects
    .flatMap((p) =>
      (p.logs || []).map((log) => ({
        ...log,
        projectId: p.id,
        projectTitle: p.title,
      }))
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 6);

  const modes: Array<{
    id: ProcessingMode;
    title: string;
    subtitle: string;
    description: string;
    icon: React.ReactNode;
    accentClass: string;
  }> = [
    {
      id: 'subtitle',
      title: '၁။ Subtitle Mode (စာတန်းထိုးစနစ်)',
      subtitle: 'SRT · ASS · Burned MP4',
      description:
        'တရုတ်စကားပြောများကို မှတ်သား၍ သဘာဝကျသော မြန်မာစာတန်းများ ပြန်ဆိုပေးခြင်း၊ Split/Merge ပြုလုပ်ခြင်း၊ စာတန်းတည်နေရာနှင့် Auto Blur Mask ချိန်ညှိထုတ်လုပ်ခြင်း။',
      icon: <Subtitles className="w-5 h-5 text-blue-400" />,
      accentClass: 'hover:border-blue-500/60',
    },
    {
      id: 'recap',
      title: '၂။ Recap Mode (ဇာတ်လမ်းပြန်ပြောစနစ်)',
      subtitle: 'Story Analysis · Narration · Subtitles',
      description:
        'ဇာတ်ကွက်၊ ဇာတ်ကောင်နှင့် ဇာတ်လမ်းအစဉ်ကို ခွဲခြမ်းစိတ်ဖြာပြီး နှစ်သက်ရာ Recap အရှည်နှင့် Narration Style ဖြင့် မြန်မာဇာတ်ကြောင်းပြော MP4 ထုတ်လုပ်ခြင်း။',
      icon: <Clapperboard className="w-5 h-5 text-violet-400" />,
      accentClass: 'hover:border-violet-500/60',
    },
    {
      id: 'dubbing',
      title: '၃။ Dubbing Mode (မြန်မာအသံသွင်းစနစ်)',
      subtitle: 'Single Selected Voice · BGM Mix · Sync Audio',
      description:
        'တရုတ်စကားပြောများကို တစ်ကြောင်းချင်း မြန်မာဘာသာပြန်၍ ရွေးချယ်ထားသော မြန်မာ AI အသံတစ်မျိုးတည်းဖြင့် အစအဆုံး အချိန်ကိုက် အသံသွင်းခြင်း။',
      icon: <Mic className="w-5 h-5 text-indigo-400" />,
      accentClass: 'hover:border-indigo-500/60',
    },
  ];

  const getStatusLabel = (status: Project['status']) => {
    switch (status) {
      case 'completed':
        return { text: 'ပြီးစီးပြီး', color: 'text-emerald-400' };
      case 'waiting_approval':
        return { text: 'အတည်ပြုရန် စောင့်ဆိုင်း', color: 'text-violet-300' };
      case 'processing':
      case 'uploaded':
        return { text: 'လုပ်ဆောင်နေဆဲ', color: 'text-amber-400' };
      case 'cancelled':
        return { text: 'ရပ်တန့်ထားသည်', color: 'text-slate-400' };
      default:
        return { text: 'မအောင်မြင်ပါ', color: 'text-rose-400' };
    }
  };

  return (
    <div className="space-y-8 pb-12">
      {/* Studio Overview Header */}
      <section className="rounded-2xl bg-gradient-to-br from-[#0F172A]/90 via-[#121633]/80 to-[#0B1020]/90 backdrop-blur-md border border-white/10 p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="space-y-2 max-w-2xl">
          <p className="text-xs font-medium text-violet-300">
            My AI Movie Recap Studio · Chinese-to-Burmese Production Suite
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight [text-wrap:balance]">
            တရုတ်ရုပ်ရှင်များကို မြန်မာစာတန်း၊ ဇာတ်လမ်းပြန်ပြောနှင့် အသံသွင်းဗီဒီယိုများအဖြစ် ဖန်တီးပါ
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed">
            Whisper Large V3၊ Gemini Multimodal AI နှင့် FFmpeg ဗီဒီယိုအင်ဂျင်တို့ဖြင့် တိကျသော အချိန်ကိုက် စာတန်းထိုးခြင်း၊ ဇာတ်လမ်းအနှစ်ချုပ်ပြန်ပြောခြင်းနှင့် မြန်မာ AI အသံသွင်းခြင်းတို့ကို တစ်နေရာတည်းတွင် ဆောင်ရွက်နိုင်ပါသည်။
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => onNavigateToCreate('recap')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>ပရောဂျက် အသစ်စတင်မည်</span>
          </button>

          <button
            type="button"
            onClick={() => onCreateDemo('recap')}
            disabled={loadingDemo}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-200 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <Play className="w-4 h-4 text-violet-400 shrink-0" />
            <span>{loadingDemo ? 'နမူနာဖန်တီးနေသည်...' : 'နမူနာ ဗီဒီယိုဖြင့် စမ်းသပ်မည်'}</span>
          </button>
        </div>
      </section>

      {/* Project Statistics Strip (Tabular Numerals) */}
      <section aria-label="Project Statistics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-xl bg-[#0B1020]/90 border border-white/[0.08] flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">စုစုပေါင်း ပရောဂျက်</p>
            <p className="text-2xl font-bold text-white tabular-nums mt-1">{summary.total}</p>
          </div>
          <FolderKanban className="w-5 h-5 text-blue-400 shrink-0" />
        </div>

        <div className="p-5 rounded-xl bg-[#0B1020]/90 border border-white/[0.08] flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">ထုတ်လုပ်ပြီးစီးမှု</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums mt-1">{summary.completed}</p>
          </div>
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
        </div>

        <div className="p-5 rounded-xl bg-[#0B1020]/90 border border-white/[0.08] flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">လုပ်ဆောင်ဆဲ / စောင့်ဆိုင်း</p>
            <p className="text-2xl font-bold text-amber-400 tabular-nums mt-1">{summary.processing}</p>
          </div>
          <Clock className="w-5 h-5 text-amber-400 shrink-0" />
        </div>

        <div className="p-5 rounded-xl bg-[#0B1020]/90 border border-white/[0.08] flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">အသုံးပြုထားသော Storage</p>
            <p className="text-2xl font-bold text-violet-300 tabular-nums mt-1">
              {storage ? formatBytes(storage.totalBytes) : '—'}
            </p>
          </div>
          <HardDrive className="w-5 h-5 text-violet-400 shrink-0" />
        </div>
      </section>

      {/* Three Primary Processing Modes */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">
            အဓိက ဗီဒီယိုလုပ်ဆောင်မှု စနစ် ၃ မျိုး (Processing Modes)
          </h2>
          <span className="text-xs text-slate-400">နှစ်သက်ရာ စနစ်ကို ရွေးချယ်စတင်ပါ</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onNavigateToCreate(m.id)}
              className={`text-left p-6 rounded-2xl bg-[#0B1020]/85 backdrop-blur-md border border-white/[0.09] ${m.accentClass} transition-colors cursor-pointer flex flex-col justify-between gap-4 group`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-lg bg-white/[0.05] border border-white/10 flex items-center justify-center">
                    {m.icon}
                  </div>
                  <span className="text-[11px] font-mono text-slate-400">{m.subtitle}</span>
                </div>
                <h3 className="text-base font-semibold text-white group-hover:text-violet-300 transition-colors">
                  {m.title}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">{m.description}</p>
              </div>

              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs font-medium text-violet-300">
                <span>ဤစနစ်ဖြင့် စတင်မည်</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Two-Column Workspace Lower Section: Recent Projects + System/Storage/History */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Projects */}
        <section className="lg:col-span-2 rounded-2xl bg-[#0B1020]/85 border border-white/[0.08] p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
            <h2 className="text-base font-semibold text-white">လတ်တလော ပရောဂျက်များ (Recent Projects)</h2>
            <button
              type="button"
              onClick={() => onNavigateToCreate('recap')}
              className="text-xs font-medium text-violet-300 hover:text-white cursor-pointer whitespace-nowrap shrink-0"
            >
              + အသစ်ဖန်တီးမည်
            </button>
          </div>

          {recentProjects.length === 0 ? (
            <div className="py-12 text-center space-y-3">
              <FolderKanban className="w-10 h-10 text-slate-600 mx-auto" />
              <p className="text-sm font-medium text-slate-300">ပရောဂျက် မရှိသေးပါ</p>
              <p className="text-xs text-slate-500">
                တရုတ်ဗီဒီယို ဖိုင်တစ်ခု တင်သွင်းပြီး Subtitle, Recap သို့မဟုတ် Dubbing စတင်နိုင်ပါသည်။
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {recentProjects.map((proj) => {
                const statusInfo = getStatusLabel(proj.status);
                const modeName =
                  proj.settings?.mode === 'subtitle'
                    ? 'Subtitle'
                    : proj.settings?.mode === 'dubbing'
                    ? 'Dubbing'
                    : 'Recap';

                return (
                  <div
                    key={proj.id}
                    className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => onSelectProject(proj.id)}
                          className="font-semibold text-sm text-white hover:text-violet-300 transition-colors truncate cursor-pointer text-left"
                        >
                          {proj.title}
                        </button>
                      </div>
                      <p className="text-xs text-slate-400 flex items-center gap-2 flex-wrap tabular-nums">
                        <span>{modeName} Mode</span>
                        <span aria-hidden="true">·</span>
                        <span>{Math.round(proj.duration)}s</span>
                        <span aria-hidden="true">·</span>
                        <span className={statusInfo.color}>{statusInfo.text}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-slate-300">{proj.progress}%</span>
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onSelectProject(proj.id)}
                        className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-violet-600/25 border border-white/10 text-xs font-medium text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        စတူဒီယိုဖွင့်မည်
                      </button>
                      {confirmDeleteId === proj.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              onDeleteProject(proj.id);
                            }}
                            className="px-2 py-1 rounded-lg bg-rose-600 text-white text-[11px] font-semibold cursor-pointer"
                          >
                            ဖျက်မည်
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1 rounded-lg bg-white/10 text-slate-300 text-[11px] cursor-pointer"
                          >
                            မဖျက်ပါ
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(proj.id)}
                          aria-label={`Delete ${proj.title}`}
                          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/5 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right Column: AI Service Status, Storage & Processing Status, Recent History */}
        <div className="space-y-6">
          {/* AI Service Status */}
          <section className="rounded-2xl bg-[#0B1020]/85 border border-white/[0.08] p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-blue-400" />
              <span>AI Service Status</span>
            </h2>

            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Google Gemini Multimodal</span>
                <span className={health?.geminiConfigured ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {health?.geminiConfigured ? 'Ready' : 'Not configured'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Groq Whisper Large V3</span>
                <span className={health?.groqConfigured ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
                  {health?.groqConfigured ? 'Ready' : 'Fallback / Setup'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Burmese TTS Adapter</span>
                <span className="text-emerald-400 font-medium capitalize">
                  {health?.ttsProvider || 'edge'} TTS
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">FFmpeg / FFprobe Core</span>
                <span className={health?.ffmpegInstalled ? 'text-emerald-400 font-medium' : 'text-rose-400'}>
                  {health?.ffmpegInstalled ? 'Active' : 'Missing'}
                </span>
              </div>
            </div>
          </section>

          {/* Storage & Processing Status */}
          <section className="rounded-2xl bg-[#0B1020]/85 border border-white/[0.08] p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-violet-400" />
              <span>Storage & Processing Status</span>
            </h2>

            <div className="space-y-2.5 text-xs tabular-nums">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Active Background Jobs</span>
                <span className="font-mono text-white">{storage?.activeJobsCount ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Source Videos</span>
                <span className="font-mono text-slate-200">
                  {storage ? formatBytes(storage.sourceVideosBytes) : '0 B'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Rendered Exports</span>
                <span className="font-mono text-emerald-400">
                  {storage ? formatBytes(storage.renderedExportsBytes) : '0 B'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Temporary Cache</span>
                <span className="font-mono text-amber-300">
                  {storage ? formatBytes(storage.tempFilesBytes) : '0 B'}
                </span>
              </div>
              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between">
                <span className="text-slate-400">Max Upload Limit</span>
                <span className="font-mono text-slate-300">{health?.maxUploadMb ?? 100} MB</span>
              </div>
            </div>
          </section>

          {/* Processing History Mini Feed */}
          <section className="rounded-2xl bg-[#0B1020]/85 border border-white/[0.08] p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white">လတ်တလော လုပ်ငန်းမှတ်တမ်း</h2>
            {recentLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-3">မှတ်တမ်း မရှိသေးပါ</p>
            ) : (
              <div className="space-y-2.5">
                {recentLogs.map((log, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onSelectProject(log.projectId)}
                    className="w-full text-left block space-y-0.5 hover:bg-white/[0.03] p-1.5 -mx-1.5 rounded-lg transition-colors cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-medium text-slate-200 truncate">{log.projectTitle}</span>
                      <span className="font-mono text-slate-500 shrink-0">Step {log.step}</span>
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-1">{log.message}</p>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
