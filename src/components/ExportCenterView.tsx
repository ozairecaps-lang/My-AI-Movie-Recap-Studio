import React, { useState } from 'react';
import {
  PackageCheck,
  Download,
  Film,
  Subtitles,
  FileText,
  Trash2,
  Clapperboard,
} from 'lucide-react';
import { Project } from '../../server/types';
import { formatBytes } from '../utils/editorMath';

interface ExportCenterViewProps {
  projects: Project[];
  onOpenEditor: (projectId: string) => void;
  onRefreshProjects: () => void;
}

export const ExportCenterView: React.FC<ExportCenterViewProps> = ({
  projects,
  onOpenEditor,
  onRefreshProjects,
}) => {
  const [cleaningId, setCleaningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleCleanup = async (projectId: string) => {
    try {
      setCleaningId(projectId);
      const res = await fetch(`/api/projects/${projectId}/cleanup`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setNotice(`ယာယီဖိုင်များ ရှင်းလင်းပြီး (${formatBytes(data.freedBytes || 0)} လွတ်မြောက်)`);
        onRefreshProjects();
      }
    } finally {
      setCleaningId(null);
    }
  };

  return (
    <div className="space-y-6 pb-16">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <PackageCheck className="w-6 h-6 text-emerald-400" />
          <span>ထုတ်ယူရန် စင်တာ (Export Center)</span>
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          ပြီးစီးပြီးသော ဗီဒီယို MP4 ဖိုင်များ၊ SRT / ASS စာတန်းဖိုင်များနှင့် Script ဖိုင်များကို ဒေါင်းလုဒ်ရယူပြီး ယာယီဖိုင်များကို ရှင်းလင်းပါ။
        </p>
      </div>

      {notice && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-xs flex items-center justify-between">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="cursor-pointer">
            ✕
          </button>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="p-12 rounded-2xl bg-[#0B1020] border border-dashed border-white/10 text-center space-y-3">
          <Film className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-300 font-medium">ထုတ်ယူရန် ပရောဂျက် မရှိသေးပါ</p>
        </div>
      ) : (
        <div className="space-y-4">
          {projects.map((p) => {
            const isCompleted = p.status === 'completed';
            const mode = p.settings?.mode || 'recap';
            const scriptFile = mode === 'recap' ? 'recap_script.txt' : 'dialogue_script.txt';
            const hasScript = Boolean(p.recapScript || p.dialogueScript);
            const hasSrt = Boolean(p.subtitles?.srtPath);
            const hasAss = Boolean(p.subtitles?.assPath);

            return (
              <div
                key={p.id}
                className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-base font-semibold text-white truncate">{p.title}</h2>
                    <span
                      className={`text-xs font-medium ${
                        isCompleted ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {isCompleted ? 'Ready to Export' : `${p.progress}%`}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 tabular-nums">
                    {mode.toUpperCase()} Mode · {Math.round(p.duration)}s · {p.videoWidth}×
                    {p.videoHeight} · {formatBytes(p.fileSize)}
                    {p.tempCleaned ? ' · Temp Cleaned' : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {isCompleted && (
                    <a
                      href={`/api/files/${p.id}/final_recap.mp4?download=1`}
                      download={`${p.title}.mp4`}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>MP4</span>
                    </a>
                  )}

                  {hasSrt && (
                    <a
                      href={`/api/files/${p.id}/subtitles.srt?download=1`}
                      download={`${p.title}.srt`}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs text-slate-200 font-medium"
                    >
                      <Subtitles className="w-3.5 h-3.5 text-blue-400" />
                      <span>SRT</span>
                    </a>
                  )}

                  {hasAss && (
                    <a
                      href={`/api/files/${p.id}/subtitles.ass?download=1`}
                      download={`${p.title}.ass`}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs text-slate-200 font-medium"
                    >
                      <Subtitles className="w-3.5 h-3.5 text-violet-400" />
                      <span>ASS</span>
                    </a>
                  )}

                  {hasScript && (
                    <a
                      href={`/api/files/${p.id}/${scriptFile}?download=1`}
                      download={`${p.title}_script.txt`}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs text-slate-200 font-medium"
                    >
                      <FileText className="w-3.5 h-3.5 text-slate-300" />
                      <span>Script</span>
                    </a>
                  )}

                  <button
                    type="button"
                    onClick={() => handleCleanup(p.id)}
                    disabled={cleaningId === p.id || p.status === 'processing'}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-xs text-slate-300 cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{cleaningId === p.id ? 'Cleaning...' : 'Clean Temp'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onOpenEditor(p.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/35 text-xs text-violet-200 font-medium cursor-pointer"
                  >
                    <Clapperboard className="w-3.5 h-3.5" />
                    <span>Editor</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
