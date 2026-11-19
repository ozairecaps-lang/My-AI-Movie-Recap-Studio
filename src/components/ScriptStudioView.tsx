import React, { useState, useEffect } from 'react';
import {
  FileText,
  Save,
  CheckCircle2,
  Clapperboard,
  Mic,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import {
  Project,
  ProjectRecapScript,
  ProjectDialogueScript,
} from '../../server/types';
import {
  DUBBING_VOICE_OPTIONS,
  DEFAULT_DUBBING_VOICE_ID,
  resolveSingleDubbingVoice,
  applySingleDubbingVoiceToSegments,
  formatTimecode,
} from '../utils/editorMath';
import { normalizeDubbingSegmentsWithSilence } from '../utils/dubbingTimeline';

interface ScriptStudioViewProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenEditor: (projectId: string) => void;
  onRefreshProjects: () => void;
}

export const ScriptStudioView: React.FC<ScriptStudioViewProps> = ({
  projects,
  selectedProjectId,
  onSelectProject,
  onOpenEditor,
  onRefreshProjects,
}) => {
  const activeId =
    selectedProjectId && projects.some((p) => p.id === selectedProjectId)
      ? selectedProjectId
      : projects[0]?.id || null;

  const project = projects.find((p) => p.id === activeId) || null;

  const [recapScript, setRecapScript] = useState<ProjectRecapScript | null>(null);
  const [dialogueScript, setDialogueScript] = useState<ProjectDialogueScript | null>(null);
  const [dubbingVoice, setDubbingVoice] = useState<string>(DEFAULT_DUBBING_VOICE_ID);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!project) {
      setRecapScript(null);
      setDialogueScript(null);
      setDubbingVoice(DEFAULT_DUBBING_VOICE_ID);
      return;
    }
    setRecapScript(project.recapScript ? JSON.parse(JSON.stringify(project.recapScript)) : null);
    setDialogueScript(
      project.dialogueScript ? JSON.parse(JSON.stringify(project.dialogueScript)) : null
    );
    setDubbingVoice(
      resolveSingleDubbingVoice(project.settings?.dubbingVoice || project.settings?.ttsVoice)
    );
  }, [project?.id, project?.updatedAt]);

  const showNotice = (type: 'success' | 'error', text: string) => {
    setNotice({ type, text });
    setTimeout(() => setNotice((prev) => (prev?.text === text ? null : prev)), 4000);
  };

  const handleSelectGlobalDubbingVoice = (voiceId: string) => {
    const unified = resolveSingleDubbingVoice(voiceId);
    setDubbingVoice(unified);
    if (dialogueScript) {
      setDialogueScript({
        ...dialogueScript,
        segments: applySingleDubbingVoiceToSegments(dialogueScript.segments || [], unified),
      });
    }
  };

  const buildSavePayload = () => {
    const isDubbing = project?.settings?.mode === 'dubbing';
    const payload: any = {};
    if (recapScript) payload.script = recapScript;
    if (dialogueScript) {
      payload.dialogueScript = isDubbing
        ? {
            ...dialogueScript,
            segments: normalizeDubbingSegmentsWithSilence(
              applySingleDubbingVoiceToSegments(dialogueScript.segments || [], dubbingVoice),
              dubbingVoice
            ),
          }
        : dialogueScript;
    }
    if (isDubbing) {
      payload.settings = {
        dubbingVoice,
        ttsVoice: dubbingVoice,
        ttsProvider: 'gemini',
      };
    }
    return payload;
  };

  const handleSave = async () => {
    if (!project) return;
    try {
      setSaving(true);
      const res = await fetch(`/api/projects/${project.id}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSavePayload()),
      });
      if (!res.ok) throw new Error('ဇာတ်ညွှန်း သိမ်းဆည်းခြင်း မအောင်မြင်ပါ');
      onRefreshProjects();
      showNotice('success', 'ဇာတ်ညွှန်းနှင့် Dubbing အသံဆက်တင်ကို သိမ်းဆည်းပြီးပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleApproveAndRender = async () => {
    if (!project) return;
    try {
      setApproving(true);
      const isDubbing = project.settings?.mode === 'dubbing';
      await fetch(`/api/projects/${project.id}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSavePayload()),
      });
      const res = await fetch(`/api/projects/${project.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isDubbing
            ? {
                settings: {
                  dubbingVoice,
                  ttsVoice: dubbingVoice,
                  ttsProvider: 'gemini',
                },
              }
            : {}
        ),
      });
      if (!res.ok) throw new Error('အတည်ပြုခြင်း မအောင်မြင်ပါ');
      onRefreshProjects();
      onOpenEditor(project.id);
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="space-y-6 pb-16">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <FileText className="w-6 h-6 text-violet-400" />
            <span>Script စတူဒီယို (Script Studio)</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Recap ဇာတ်ညွှန်းများ၊ Subtitle/Dubbing စာကြောင်းများနှင့် Dubbing အသံဆက်တင်ကို တည်းဖြတ်အတည်ပြုပါ။
          </p>
        </div>

        {projects.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={activeId || ''}
              onChange={(e) => onSelectProject(e.target.value)}
              aria-label="Select project for Script Studio"
              className="px-3.5 py-2 rounded-xl bg-[#0B1020] border border-white/10 text-xs text-white cursor-pointer max-w-xs"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({(p.settings?.mode || 'recap').toUpperCase()})
                </option>
              ))}
            </select>
          </div>
        )}
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

      {!project ? (
        <div className="p-12 rounded-2xl bg-[#0B1020] border border-dashed border-white/10 text-center space-y-3">
          <Sparkles className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-300 font-medium">ပရောဂျက် မရှိသေးပါ</p>
        </div>
      ) : (
        <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
            <div>
              <h2 className="text-base font-bold text-white">{project.title}</h2>
              <p className="text-xs text-slate-400">
                {(project.settings?.mode || 'recap').toUpperCase()} Mode · {project.currentStepTitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || (!recapScript && !dialogueScript)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saving ? 'သိမ်းနေသည်...' : 'သိမ်းဆည်းမည်'}</span>
              </button>

              {project.status === 'waiting_approval' && (
                <button
                  type="button"
                  onClick={handleApproveAndRender}
                  disabled={approving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{approving ? 'စတင်နေ...' : 'အတည်ပြုပြီး MP4 ထုတ်မည်'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => onOpenEditor(project.id)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/35 text-violet-200 text-xs font-semibold cursor-pointer"
              >
                <Clapperboard className="w-3.5 h-3.5" />
                <span>Video Editor ဖွင့်မည်</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {project.settings?.mode === 'recap' ? (
            !recapScript ? (
              <p className="py-10 text-center text-sm text-slate-400">
                ဇာတ်ညွှန်း ပြုစုနေဆဲ ဖြစ်ပါသည် (Step 8 မပြီးသေးပါ)
              </p>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400">ဇာတ်ကား ခေါင်းစဉ်</label>
                    <input
                      type="text"
                      value={recapScript.title}
                      onChange={(e) => setRecapScript({ ...recapScript, title: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-[#060913] border border-white/10 text-sm text-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400">အမျိုးအစား</label>
                    <input
                      type="text"
                      value={recapScript.genre}
                      onChange={(e) => setRecapScript({ ...recapScript, genre: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-[#060913] border border-white/10 text-sm text-white"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-400">ဇာတ်လမ်း အကျဉ်းချုပ်</label>
                  <textarea
                    rows={3}
                    value={recapScript.synopsis}
                    onChange={(e) => setRecapScript({ ...recapScript, synopsis: e.target.value })}
                    className="w-full p-3 rounded-xl bg-[#060913] border border-white/10 text-sm text-slate-200 leading-relaxed"
                  />
                </div>

                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-slate-300">
                    ဇာတ်ကြောင်းပြော စာပိုဒ်များ ({recapScript.narrationSegments.length})
                  </h3>
                  {recapScript.narrationSegments.map((seg, i) => (
                    <div
                      key={seg.id || i}
                      className="p-3.5 rounded-xl bg-[#060913] border border-white/[0.06] space-y-1.5"
                    >
                      <p className="text-[11px] font-mono text-violet-300">Segment {i + 1}</p>
                      <textarea
                        rows={2}
                        value={seg.text}
                        onChange={(e) => {
                          const next = [...recapScript.narrationSegments];
                          next[i] = { ...next[i], text: e.target.value };
                          setRecapScript({ ...recapScript, narrationSegments: next });
                        }}
                        className="w-full p-2.5 rounded-lg bg-[#0B1020] border border-white/10 text-sm text-white"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : !dialogueScript ? (
            <p className="py-10 text-center text-sm text-slate-400">
              ဘာသာပြန် စာကြောင်းများ ပြုစုနေဆဲ ဖြစ်ပါသည်...
            </p>
          ) : (
            <div className="space-y-5">
              {project.settings?.mode === 'dubbing' && (
                <div className="p-4 rounded-xl bg-[#060913] border border-violet-500/30 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-white flex items-center gap-2">
                        <Mic className="w-4 h-4 text-violet-400" />
                        <span>Global Dubbing Voice (Single Voice for All Characters)</span>
                      </h3>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        ရွေးချယ်ထားသော အသံတစ်မျိုးတည်းကိုသာ ဇာတ်ကောင်နှင့် စကားပြောအပိုင်းအားလုံးတွင် အသုံးပြုပါမည်။
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {DUBBING_VOICE_OPTIONS.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => handleSelectGlobalDubbingVoice(v.id)}
                        className={`p-3 rounded-lg border text-left cursor-pointer transition-colors ${
                          dubbingVoice === v.id
                            ? 'bg-violet-600/20 border-violet-500 text-white'
                            : 'bg-[#0B1020] border-white/[0.08] text-slate-300 hover:border-white/20'
                        }`}
                      >
                        <p className="text-xs font-semibold">{v.englishLabel}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">{v.label}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2.5">
                {dialogueScript.segments.map((seg, i) => {
                  const isDubbing = project.settings?.mode === 'dubbing';
                  const isSilence =
                    seg.kind === 'silence' ||
                    (isDubbing && !seg.chineseText?.trim() && !seg.burmeseText?.trim());

                  if (isSilence) {
                    return (
                      <div
                        key={seg.id || i}
                        className="px-3.5 py-2.5 rounded-xl bg-[#060913]/60 border border-dashed border-white/[0.08] flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-slate-400 tabular-nums">
                            #{i + 1} · {formatTimecode(seg.start)} – {formatTimecode(seg.end)}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px] font-mono">
                            SILENCE · 1.00x Original Speed
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500">
                          မူရင်းအမြန်နှုန်းအတိုင်း ထိန်းသိမ်းထားသည် (No AI Voice)
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={seg.id || i}
                      className="p-3.5 rounded-xl bg-[#060913] border border-white/[0.06] space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-violet-300 tabular-nums">
                            #{i + 1} · {formatTimecode(seg.start)} – {formatTimecode(seg.end)}
                          </span>
                          {isDubbing && (
                            <span className="px-2 py-0.5 rounded bg-violet-500/15 text-violet-200 text-[11px] font-mono tabular-nums">
                              SPEAKING
                              {typeof seg.videoSpeedFactor === 'number'
                                ? ` · Video ${seg.videoSpeedFactor.toFixed(2)}x`
                                : ''}
                            </span>
                          )}
                        </div>
                        <span className="text-slate-400">
                          {seg.speaker || 'Speaker 1'}
                          {seg.emotion ? ` · ${seg.emotion}` : ''}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">{seg.chineseText}</p>
                      <textarea
                        rows={2}
                        value={seg.burmeseText}
                        onChange={(e) => {
                          const next = [...dialogueScript.segments];
                          next[i] = { ...next[i], burmeseText: e.target.value };
                          setDialogueScript({ ...dialogueScript, segments: next });
                        }}
                        className="w-full p-2.5 rounded-lg bg-[#0B1020] border border-white/10 text-sm text-white"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
