import React, { useState } from 'react';
import {
  History,
  Clock,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Terminal,
  RotateCcw,
  Search,
} from 'lucide-react';
import { Project } from '../../server/types';

interface ProcessingHistoryViewProps {
  projects: Project[];
  onSelectProject: (projectId: string) => void;
  onRefreshProjects?: () => void;
}

export const ProcessingHistoryView: React.FC<ProcessingHistoryViewProps> = ({
  projects,
  onSelectProject,
  onRefreshProjects,
}) => {
  const [filterType, setFilterType] = useState<'all' | 'error' | 'success' | 'info' | 'warn'>('all');
  const [query, setQuery] = useState('');
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const allLogs: Array<{
    projectId: string;
    projectTitle: string;
    projectStatus: Project['status'];
    timestamp: string;
    step: number;
    message: string;
    type: 'info' | 'warn' | 'error' | 'success';
  }> = [];

  for (const p of projects) {
    for (const log of p.logs || []) {
      allLogs.push({
        projectId: p.id,
        projectTitle: p.title,
        projectStatus: p.status,
        timestamp: log.timestamp,
        step: log.step,
        message: log.message,
        type: log.type,
      });
    }
  }

  allLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const filteredLogs = allLogs.filter((l) => {
    if (filterType !== 'all' && l.type !== filterType) return false;
    if (
      query.trim() &&
      !l.projectTitle.toLowerCase().includes(query.toLowerCase()) &&
      !l.message.toLowerCase().includes(query.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const handleRetryProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    try {
      setRetryingId(projectId);
      await fetch(`/api/projects/${projectId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      onRefreshProjects?.();
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="space-y-6 pb-16">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <History className="w-6 h-6 text-violet-400" />
          <span>လုပ်ငန်း မှတ်တမ်း (Project History)</span>
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          တရုတ်စကားပြော မှတ်သားခြင်း၊ Gemini ဇာတ်ညွှန်းရေးသားခြင်းနှင့် FFmpeg ဗီဒီယိုတည်းဖြတ်မှု မှတ်တမ်းအားလုံး
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ပရောဂျက် သို့မဟုတ် မှတ်တမ်းစာသားဖြင့် ရှာဖွေပါ..."
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-[#0B1020] border border-white/10 text-xs text-white focus:border-violet-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto">
          {[
            { id: 'all', label: 'All' },
            { id: 'success', label: 'Success' },
            { id: 'error', label: 'Errors' },
            { id: 'warn', label: 'Warnings' },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilterType(f.id as any)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border cursor-pointer whitespace-nowrap ${
                filterType === f.id
                  ? 'bg-violet-600/20 border-violet-500 text-white'
                  : 'bg-[#0B1020] border-white/[0.08] text-slate-400 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="py-16 text-center rounded-2xl bg-[#0B1020] border border-dashed border-white/10 space-y-3">
          <Terminal className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="text-slate-300 font-medium text-sm">လုပ်ငန်းမှတ်တမ်း မရှိသေးပါ</p>
        </div>
      ) : (
        <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400 border-b border-white/[0.06] pb-3 tabular-nums">
            <span>မှတ်တမ်း စုစုပေါင်း: {filteredLogs.length}</span>
            <span>Newest First</span>
          </div>

          <div className="divide-y divide-white/[0.06]">
            {filteredLogs.map((log, index) => {
              const isError = log.type === 'error';
              const isSuccess = log.type === 'success';
              const canRetry =
                log.projectStatus === 'failed' || log.projectStatus === 'cancelled';

              return (
                <div
                  key={index}
                  onClick={() => onSelectProject(log.projectId)}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:bg-white/[0.02] px-2 -mx-2 rounded-lg transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 shrink-0">
                      {isError ? (
                        <AlertCircle className="w-4 h-4 text-rose-400" />
                      ) : isSuccess ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Clock className="w-4 h-4 text-violet-400" />
                      )}
                    </div>

                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="font-semibold text-white">{log.projectTitle}</span>
                        <span className="font-mono text-violet-300">Step {log.step}</span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{log.message}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                    {canRetry && (
                      <button
                        type="button"
                        onClick={(e) => handleRetryProject(e, log.projectId)}
                        disabled={retryingId === log.projectId}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-600/20 border border-violet-500/40 text-violet-200 text-xs font-medium cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Retry</span>
                      </button>
                    )}
                    <span className="text-[11px] text-slate-500 font-mono tabular-nums">
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                    <ArrowRight className="w-4 h-4 text-slate-500" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
