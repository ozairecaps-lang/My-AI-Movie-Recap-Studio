import React, { useState, useEffect, useRef } from 'react';
import {
  RotateCcw,
  Download,
  FileText,
  Subtitles,
  Film,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Volume2,
  Edit3,
  Save,
  ArrowLeft,
  Terminal,
  Languages,
  Mic,
  Sliders,
  Gauge,
  Split,
  Merge,
  Music,
  XCircle,
  Trash2,
  Move,
  RefreshCw,
  EyeOff,
} from 'lucide-react';
import {
  Project,
  ProjectRecapScript,
  ProjectDialogueScript,
} from '../../server/types';
import { BlurredVideoPreview } from './BlurredVideoPreview';
import {
  AutoBlurConfig,
  AutoBlurStyle,
  DEFAULT_AUTO_BLUR_CONFIG,
  sanitizeAutoBlurConfig,
  getAutoBlurRenderSignature,
} from '../utils/autoBlur';
import { SPEAKING_SPEED_OPTIONS, getSpeedOption } from '../utils/speed';
import {
  SubtitleCue,
  SubtitleStyleConfig,
  DEFAULT_SUBTITLE_STYLE,
  parseSrtContent,
  splitSubtitleCue,
  mergeSubtitleCues,
  updateSubtitleCue,
} from '../utils/subtitle';
import {
  DUBBING_VOICE_OPTIONS,
  DEFAULT_DUBBING_VOICE_ID,
  resolveSingleDubbingVoice,
  applySingleDubbingVoiceToSegments,
  formatBytes,
  formatTimecode,
} from '../utils/editorMath';
import { normalizeDubbingSegmentsWithSilence } from '../utils/dubbingTimeline';

interface ProjectStudioViewProps {
  projectId: string | null;
  projects?: Project[];
  onSelectProject?: (projectId: string) => void;
  onBack: () => void;
  groqApiKey?: string;
}

export const ProjectStudioView: React.FC<ProjectStudioViewProps> = ({
  projectId,
  projects = [],
  onSelectProject,
  onBack,
  groqApiKey,
}) => {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [activeTab, setActiveTab] = useState<'video' | 'script' | 'subtitles' | 'chinese' | 'logs'>('video');

  // Script / Dialogue Editing State
  const [editableScript, setEditableScript] = useState<ProjectRecapScript | null>(null);
  const [editableDialogue, setEditableDialogue] = useState<ProjectDialogueScript | null>(null);
  const [dubbingVoice, setDubbingVoice] = useState<string>(DEFAULT_DUBBING_VOICE_ID);
  const [isEditingScript, setIsEditingScript] = useState(false);
  const [savingScript, setSavingScript] = useState(false);
  const [approving, setApproving] = useState(false);

  // Audio Mixer, Speed & Subtitle Style State
  const [reRendering, setReRendering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [uploadingBgm, setUploadingBgm] = useState(false);
  const [savingSubtitles, setSavingSubtitles] = useState(false);

  const [audioMixVolume, setAudioMixVolume] = useState<number>(0.15);
  const [narrationVolume, setNarrationVolume] = useState<number>(1.0);
  const [bgmVolume, setBgmVolume] = useState<number>(0.2);
  const [speakingRate, setSpeakingRate] = useState<string>('1.00x');
  const [ttsVoice, setTtsVoice] = useState<string>('my-MM-NilarNeural');
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(true);
  const [previewingSpeed, setPreviewingSpeed] = useState(false);

  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleConfig>(DEFAULT_SUBTITLE_STYLE);
  const [autoBlurConfig, setAutoBlurConfig] = useState<AutoBlurConfig>(DEFAULT_AUTO_BLUR_CONFIG);
  const [activePreviewSubtitle, setActivePreviewSubtitle] = useState<string | null>(null);
  const [currentPlayTime, setCurrentPlayTime] = useState<number>(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgmInputRef = useRef<HTMLInputElement | null>(null);
  const loadedProjectIdRef = useRef<string | null>(null);
  const loadedSrtStampRef = useRef<string | null>(null);
  const autoBlurSaveTimerRef = useRef<number | null>(null);

  const showNotice = (type: 'success' | 'error', text: string) => {
    setBanner({ type, text });
    setTimeout(() => {
      setBanner((prev) => (prev?.text === text ? null : prev));
    }, 4500);
  };

  const fetchProject = async (targetId: string) => {
    try {
      const res = await fetch(`/api/projects/${targetId}`);
      if (!res.ok) throw new Error('ပရောဂျက် ရှာမတွေ့ပါ');
      const data: Project = await res.json();
      setProject(data);

      const isInitialProjectLoad = loadedProjectIdRef.current !== data.id;
      if (isInitialProjectLoad) {
        loadedProjectIdRef.current = data.id;
        loadedSrtStampRef.current = null;
        setSubtitleCues([]);
        setEditableScript(data.recapScript ? JSON.parse(JSON.stringify(data.recapScript)) : null);
        setEditableDialogue(data.dialogueScript ? JSON.parse(JSON.stringify(data.dialogueScript)) : null);
        setDubbingVoice(
          resolveSingleDubbingVoice(data.settings?.dubbingVoice || data.settings?.ttsVoice)
        );
        if (data.settings) {
          setAudioMixVolume(data.settings.originalAudioVolume ?? 0.15);
          setNarrationVolume(data.settings.narrationVolume ?? 1.0);
          setBgmVolume(data.settings.bgmVolume ?? 0.2);
          setSpeakingRate(data.settings.speakingRate || '1.00x');
          setTtsVoice(data.settings.ttsVoice || 'my-MM-NilarNeural');
          setBurnSubtitles(data.settings.burnSubtitles ?? true);
          const portrait = data.videoHeight > data.videoWidth;
          setSubtitleStyle({
            ...DEFAULT_SUBTITLE_STYLE,
            posY: portrait ? 77 : 90,
            ...(data.settings.subtitleStyle || {}),
          });
          setAutoBlurConfig(
            sanitizeAutoBlurConfig(data.autoBlur?.config ?? data.settings.autoBlur)
          );
        }
      } else if (!isEditingScript && !savingScript) {
        if (data.recapScript && !editableScript) {
          setEditableScript(JSON.parse(JSON.stringify(data.recapScript)));
        }
        if (data.dialogueScript && !editableDialogue) {
          setEditableDialogue(JSON.parse(JSON.stringify(data.dialogueScript)));
          setDubbingVoice(
            resolveSingleDubbingVoice(data.settings?.dubbingVoice || data.settings?.ttsVoice)
          );
        }
      }

      const srtStamp = data.subtitles?.srtPath
        ? `${data.id}:${data.subtitles.cuesCount}:${data.export?.renderedAt || data.updatedAt}`
        : null;
      if (srtStamp && loadedSrtStampRef.current !== srtStamp && !savingSubtitles) {
        try {
          const srtRes = await fetch(`/api/files/${data.id}/subtitles.srt?t=${Date.now()}`);
          if (srtRes.ok) {
            const srtText = await srtRes.text();
            setSubtitleCues(parseSrtContent(srtText));
            loadedSrtStampRef.current = srtStamp;
          }
        } catch {}
      }

      setError(null);
    } catch (err: any) {
      setError(err.message || 'ဒေတာ ရယူခြင်း မအောင်မြင်ပါ');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchProject(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!project || !projectId) return;
    const shouldPoll = project.status === 'processing' || project.status === 'uploaded';
    if (!shouldPoll) return;
    const interval = setInterval(() => {
      fetchProject(projectId);
    }, 2500);
    return () => clearInterval(interval);
  }, [project?.status, project?.currentStep, projectId]);

  const handleSelectGlobalDubbingVoice = (voiceId: string) => {
    const unified = resolveSingleDubbingVoice(voiceId);
    setDubbingVoice(unified);
    if (editableDialogue) {
      setEditableDialogue({
        ...editableDialogue,
        segments: applySingleDubbingVoiceToSegments(editableDialogue.segments || [], unified),
      });
    }
  };

  const handleSaveScript = async (overrideVoiceId?: string) => {
    if (!projectId) return;
    try {
      setSavingScript(true);
      const isDubbing = project?.settings?.mode === 'dubbing';
      const activeDubbingVoice = resolveSingleDubbingVoice(overrideVoiceId || dubbingVoice);
      const payload: any = {};
      if (editableScript) payload.script = editableScript;
      if (editableDialogue) {
        payload.dialogueScript = isDubbing
          ? {
              ...editableDialogue,
              segments: normalizeDubbingSegmentsWithSilence(
                applySingleDubbingVoiceToSegments(
                  editableDialogue.segments || [],
                  activeDubbingVoice
                ),
                activeDubbingVoice
              ),
            }
          : editableDialogue;
      }
      if (isDubbing) {
        payload.settings = {
          dubbingVoice: activeDubbingVoice,
          ttsVoice: activeDubbingVoice,
          ttsProvider: 'gemini',
        };
      }
      const res = await fetch(`/api/projects/${projectId}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('ဇာတ်ညွှန်း သိမ်းဆည်းခြင်း မအောင်မြင်ပါ');
      const updated: Project = await res.json();
      setProject(updated);
      if (updated.dialogueScript) {
        setEditableDialogue(JSON.parse(JSON.stringify(updated.dialogueScript)));
      }
      if (updated.settings?.dubbingVoice) {
        setDubbingVoice(resolveSingleDubbingVoice(updated.settings.dubbingVoice));
      }
      setIsEditingScript(false);
      showNotice(
        'success',
        isDubbing
          ? 'ဇာတ်ညွှန်းနှင့် Single Dubbing အသံဆက်တင်ကို သိမ်းဆည်းပြီးပါပြီ'
          : 'ဇာတ်ညွှန်းကို သိမ်းဆည်းပြီးပါပြီ'
      );
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setSavingScript(false);
    }
  };

  const handlePreviewSpeed = async (rateToTest?: string, voiceOverride?: string) => {
    try {
      setPreviewingSpeed(true);
      const isDubbing = project?.settings?.mode === 'dubbing';
      const targetVoice = voiceOverride || (isDubbing ? dubbingVoice : ttsVoice);
      const res = await fetch('/api/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId: targetVoice,
          rate: rateToTest || speakingRate,
          provider: isDubbing ? 'gemini' : project?.settings?.ttsProvider,
        }),
      });
      if (!res.ok) throw new Error('အသံစမ်းသပ်မှု မအောင်မြင်ပါ');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (previewAudioRef.current) {
        previewAudioRef.current.src = url;
        previewAudioRef.current.play();
      }
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setPreviewingSpeed(false);
    }
  };

  const handleApproveAndProceed = async () => {
    if (!projectId) return;
    try {
      setApproving(true);
      const isDubbing = project?.settings?.mode === 'dubbing';
      const activeDubbingVoice = resolveSingleDubbingVoice(dubbingVoice);

      await fetch(`/api/projects/${projectId}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editableScript ? { script: editableScript } : {}),
            ...(editableDialogue
              ? {
                  dialogueScript: isDubbing
                    ? {
                        ...editableDialogue,
                        segments: normalizeDubbingSegmentsWithSilence(
                          applySingleDubbingVoiceToSegments(
                            editableDialogue.segments || [],
                            activeDubbingVoice
                          ),
                          activeDubbingVoice
                        ),
                      }
                    : editableDialogue,
                }
              : {}),
            ...(isDubbing
              ? {
                  settings: {
                    dubbingVoice: activeDubbingVoice,
                    ttsVoice: activeDubbingVoice,
                    ttsProvider: 'gemini',
                  },
                }
              : {}),
        }),
      });

      const res = await fetch(`/api/projects/${projectId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            speakingRate,
            ttsVoice: isDubbing ? activeDubbingVoice : ttsVoice,
            ...(isDubbing
              ? { dubbingVoice: activeDubbingVoice, ttsProvider: 'gemini' }
              : {}),
            originalAudioVolume: audioMixVolume,
            narrationVolume,
            bgmVolume,
            burnSubtitles,
            subtitleStyle,
            autoBlur: autoBlurConfig,
          },
        }),
      });
      if (!res.ok) throw new Error('အတည်ပြုခြင်း မအောင်မြင်ပါ');
      await fetchProject(projectId);
      showNotice('success', 'အတည်ပြုပြီး MP4 ထုတ်လုပ်မှု စတင်ပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setApproving(false);
    }
  };

  const handleCancelJob = async () => {
    if (!projectId) return;
    try {
      setCancelling(true);
      const res = await fetch(`/api/projects/${projectId}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error('ရပ်တန့်ခြင်း မအောင်မြင်ပါ');
      await fetchProject(projectId);
      showNotice('success', 'လုပ်ငန်းစဉ်ကို ရပ်တန့်ပြီးပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (!projectId) return;
    try {
      setLoading(true);
      const res = await fetch(`/api/projects/${projectId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groqApiKey }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'ပြန်လည်စတင်ခြင်း မအောင်မြင်ပါ');
      }
      await fetchProject(projectId);
      showNotice('success', 'လုပ်ငန်းစဉ်ကို ပြန်လည်စတင်ပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCleanupTemp = async () => {
    if (!projectId) return;
    try {
      setCleaningUp(true);
      const res = await fetch(`/api/projects/${projectId}/cleanup`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cleanup failed');
      await fetchProject(projectId);
      showNotice(
        'success',
        `ယာယီဖိုင်များ ရှင်းလင်းပြီး (${formatBytes(data.freedBytes || 0)} လွတ်မြောက်)`
      );
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setCleaningUp(false);
    }
  };

  const handleBgmUpload = async (file: File) => {
    if (!projectId) return;
    try {
      setUploadingBgm(true);
      const fd = new FormData();
      fd.append('bgm', file);
      const res = await fetch(`/api/projects/${projectId}/bgm`, {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'BGM upload failed');
      setProject(data.project);
      showNotice('success', `နောက်ခံတေးဂီတ "${file.name}" ထည့်သွင်းပြီးပါပြီ`);
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setUploadingBgm(false);
    }
  };

  const handleSaveSubtitles = async (nextCues?: SubtitleCue[], nextStyle?: SubtitleStyleConfig) => {
    if (!projectId) return;
    try {
      setSavingSubtitles(true);
      const res = await fetch(`/api/projects/${projectId}/subtitles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cues: nextCues ?? subtitleCues,
          subtitleStyle: nextStyle ?? subtitleStyle,
        }),
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || 'စာတန်းသိမ်းဆည်းခြင်း မအောင်မြင်ပါ');
      setProject(updated);
      showNotice('success', 'SRT & ASS စာတန်းနှင့် တည်နေရာဆက်တင်များ သိမ်းဆည်းပြီးပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setSavingSubtitles(false);
    }
  };

  const handleUpdateAutoBlur = (patch: Partial<AutoBlurConfig>, immediate = true) => {
    const next = sanitizeAutoBlurConfig({ ...autoBlurConfig, ...patch });
    setAutoBlurConfig(next);
    if (!projectId) return;

    const persist = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/auto-blur`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        if (res.ok) {
          const updated: Project = await res.json();
          setProject(updated);
        }
      } catch {}
    };

    if (autoBlurSaveTimerRef.current) {
      window.clearTimeout(autoBlurSaveTimerRef.current);
      autoBlurSaveTimerRef.current = null;
    }

    if (immediate) {
      void persist();
    } else {
      autoBlurSaveTimerRef.current = window.setTimeout(() => {
        void persist();
      }, 250);
    }
  };

  const handleReRender = async () => {
    if (!projectId) return;
    try {
      setReRendering(true);
      const isDubbing = project?.settings?.mode === 'dubbing';
      const activeDubbingVoice = resolveSingleDubbingVoice(dubbingVoice);

      if (subtitleCues.length > 0) {
        await fetch(`/api/projects/${projectId}/subtitles`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cues: subtitleCues, subtitleStyle }),
        });
      }

      const res = await fetch(`/api/projects/${projectId}/re-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            speakingRate,
            ttsVoice: isDubbing ? activeDubbingVoice : ttsVoice,
            ...(isDubbing
              ? { dubbingVoice: activeDubbingVoice, ttsProvider: 'gemini' }
              : {}),
            originalAudioVolume: audioMixVolume,
            narrationVolume,
            bgmVolume,
            burnSubtitles,
            subtitleStyle,
            autoBlur: autoBlurConfig,
          },
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'ဗီဒီယို ပြန်လည်တည်းဖြတ်ခြင်း မအောင်မြင်ပါ');
      }
      const resData = await res.json().catch(() => null);
      if (resData?.project) {
        setProject(resData.project);
        if (resData.project.dialogueScript) {
          setEditableDialogue(JSON.parse(JSON.stringify(resData.project.dialogueScript)));
        }
        if (resData.project.settings?.dubbingVoice) {
          setDubbingVoice(resolveSingleDubbingVoice(resData.project.settings.dubbingVoice));
        }
      } else {
        await fetchProject(projectId);
      }
      if (videoRef.current) {
        videoRef.current.load();
      }
      showNotice('success', 'ဗီဒီယို အသစ်ပြန်လည် ပေါင်းစပ်ပြီးစီးပါပြီ');
    } catch (err: any) {
      showNotice('error', err.message);
    } finally {
      setReRendering(false);
    }
  };

  const seekToTime = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      videoRef.current.play().catch(() => {});
    }
  };

  // No project selected yet -> show project selector for Video Editor tab
  if (!projectId) {
    return (
      <div className="space-y-6 pb-16">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white">ဗီဒီယို တည်းဖြတ်စက် (Video Editor)</h1>
          <p className="text-sm text-slate-400">
            စာတန်းတည်နေရာ၊ Auto Blur Mask၊ BGM အသံပေါင်းစပ်မှုနှင့် Split/Merge ပြုလုပ်ရန် ပရောဂျက်တစ်ခု ရွေးချယ်ပါ။
          </p>
        </div>

        {projects.length === 0 ? (
          <div className="p-12 rounded-2xl bg-[#0B1020] border border-dashed border-white/10 text-center space-y-3">
            <Film className="w-10 h-10 text-slate-600 mx-auto" />
            <p className="text-sm text-slate-300 font-medium">တည်းဖြတ်ရန် ပရောဂျက် မရှိသေးပါ</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectProject?.(p.id)}
                className="text-left p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] hover:border-violet-500/50 transition-colors cursor-pointer space-y-2"
              >
                <p className="font-semibold text-white truncate">{p.title}</p>
                <p className="text-xs text-slate-400 tabular-nums">
                  {(p.settings?.mode || 'recap').toUpperCase()} · {Math.round(p.duration)}s · {p.progress}%
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (loading && !project) {
    return (
      <div className="py-24 text-center space-y-4">
        <div className="w-10 h-10 border-4 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-slate-300 text-sm">ပရောဂျက် ဒေတာများကို ရယူနေပါသည်...</p>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-8 rounded-2xl bg-[#0B1020] border border-white/10 text-center space-y-4 max-w-lg mx-auto">
        <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />
        <h2 className="text-lg font-bold text-white">ပရောဂျက် ဖွင့်၍မရပါ</h2>
        <p className="text-sm text-slate-400">{error || 'ပရောဂျက် မရှိတော့ပါ'}</p>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm font-medium cursor-pointer"
        >
          နောက်သို့ ပြန်သွားမည်
        </button>
      </div>
    );
  }

  const mode = project.settings?.mode || 'recap';
  const isCompleted = project.status === 'completed';
  const isWaitingApproval = project.status === 'waiting_approval';
  const isFailed = project.status === 'failed';
  const isCancelled = project.status === 'cancelled';
  const isProcessing = project.status === 'processing' || project.status === 'uploaded';

  const stepsList = [
    { num: 1, title: 'ဗီဒီယို တင်သွင်း' },
    { num: 2, title: 'Metadata စစ်ဆေး' },
    { num: 3, title: 'အသံခွဲထုတ်' },
    { num: 4, title: 'တရုတ် ASR' },
    { num: 5, title: 'ဖရိမ်ထုတ်ယူ' },
    { num: 6, title: 'စာတန်း OCR' },
    { num: 7, title: 'ဇာတ်လမ်းခွဲခြမ်း' },
    { num: 8, title: 'မြန်မာ AI ဘာသာပြန်' },
    { num: 9, title: 'စစ်ဆေးအတည်ပြု' },
    { num: 10, title: 'မြန်မာ TTS' },
    { num: 11, title: 'SRT / ASS' },
    { num: 12, title: 'FFmpeg Render' },
    { num: 13, title: 'ပြီးစီးမှု' },
  ];

  return (
    <div className="space-y-6 pb-20">
      <audio ref={previewAudioRef} className="hidden" />
      <input
        ref={bgmInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.aac,audio/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) handleBgmUpload(e.target.files[0]);
        }}
      />

      {banner && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            banner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
        <div className="flex items-start sm:items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="p-2 rounded-xl bg-[#0B1020] hover:bg-white/[0.06] text-slate-300 border border-white/10 transition-colors cursor-pointer shrink-0"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-xl font-bold text-white truncate max-w-xl">{project.title}</h1>
              <span
                className={`text-xs font-semibold ${
                  isCompleted
                    ? 'text-emerald-400'
                    : isWaitingApproval
                    ? 'text-violet-300'
                    : isProcessing
                    ? 'text-amber-400'
                    : isCancelled
                    ? 'text-slate-400'
                    : 'text-rose-400'
                }`}
              >
                {isCompleted
                  ? 'ပြီးစီးပြီး'
                  : isWaitingApproval
                  ? 'အဆင့် ၉ · အတည်ပြုရန်'
                  : isProcessing
                  ? `လုပ်ဆောင်နေဆဲ (${project.progress}%)`
                  : isCancelled
                  ? 'ရပ်တန့်ထားသည်'
                  : 'မအောင်မြင်ပါ'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5 tabular-nums truncate">
              {mode.toUpperCase()} Mode · {project.originalFilename} · {Math.round(project.duration)}s ·{' '}
              {project.videoWidth}×{project.videoHeight} · Speed {project.settings.speakingRate}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {isProcessing && (
            <button
              type="button"
              onClick={handleCancelJob}
              disabled={cancelling}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-200 text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
            >
              <XCircle className="w-4 h-4" />
              <span>{cancelling ? 'ရပ်တန့်နေသည်...' : 'လုပ်ငန်းရပ်မည် (Cancel)'}</span>
            </button>
          )}

          {(isFailed || isCancelled) && (
            <button
              type="button"
              onClick={handleRetry}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-4 h-4" />
              <span>ပြန်လည်စတင်မည် (Retry)</span>
            </button>
          )}

          {!isProcessing && (
            <button
              type="button"
              onClick={handleCleanupTemp}
              disabled={cleaningUp}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-200 text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5 text-slate-400" />
              <span>{cleaningUp ? 'ရှင်းလင်းနေသည်...' : 'ယာယီဖိုင် ရှင်းလင်းမည်'}</span>
            </button>
          )}

          {isCompleted && (
            <a
              href={`/api/files/${project.id}/final_recap.mp4?download=1`}
              download={`${project.title}.mp4`}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4" />
              <span>MP4 ဒေါင်းလုဒ်</span>
            </a>
          )}
        </div>
      </div>

      {/* Progress & 13-Step Stepper */}
      <div className="p-4 sm:p-5 rounded-2xl bg-[#0B1020]/90 border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[11px] font-mono text-violet-300">
              Pipeline Step {project.currentStep}/13
            </p>
            <p className="text-sm font-semibold text-white">
              {project.currentStepTitle || 'လုပ်ဆောင်နေပါသည်...'}
            </p>
          </div>
          <span className="text-lg font-bold font-mono text-violet-300 tabular-nums">
            {project.progress}%
          </span>
        </div>

        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              isCompleted
                ? 'bg-emerald-500'
                : isFailed
                ? 'bg-rose-500'
                : 'bg-gradient-to-r from-violet-500 to-blue-500'
            }`}
            style={{ width: `${project.progress}%` }}
          />
        </div>

        <div className="overflow-x-auto pb-1">
          <div className="flex items-center gap-1.5 min-w-max">
            {stepsList.map((s) => {
              const past = project.currentStep > s.num || isCompleted;
              const current = project.currentStep === s.num && !isCompleted;
              return (
                <div
                  key={s.num}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border whitespace-nowrap ${
                    past
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : current
                      ? 'bg-violet-600/20 border-violet-500 text-violet-200'
                      : 'bg-[#060913]/60 border-white/[0.06] text-slate-500'
                  }`}
                >
                  {s.num}. {s.title}
                </div>
              );
            })}
          </div>
        </div>

        {project.error && (
          <p className="text-xs text-rose-300 font-mono bg-rose-950/30 border border-rose-500/30 rounded-lg p-3">
            {project.error}
          </p>
        )}
      </div>

      {/* Step 9 Waiting Approval Banner */}
      {isWaitingApproval && (
        <div className="p-5 sm:p-6 rounded-2xl bg-gradient-to-r from-violet-950/60 via-indigo-950/50 to-[#0B1020] border border-violet-500/50 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-violet-300 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" />
                <span>အဆင့် ၉ · စာသားနှင့် အသံဆက်တင်များ အတည်ပြုရန်</span>
              </p>
              <h2 className="text-base font-bold text-white">
                Script / Dialogue ကို စစ်ဆေးတည်းဖြတ်ပြီး MP4 ထုတ်လုပ်မှု ဆက်လက်လုပ်ဆောင်ပါ
              </h2>
            </div>

            <button
              type="button"
              onClick={handleApproveAndProceed}
              disabled={approving}
              className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-sm font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{approving ? 'စတင်နေပါသည်...' : 'အတည်ပြုပြီး MP4 ထုတ်မည်'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Studio Tabs */}
      <div className="flex border-b border-white/[0.08] gap-1 overflow-x-auto">
        {[
          { id: 'video', label: 'ဗီဒီယို တည်းဖြတ်စက် (Editor)', icon: <Film className="w-4 h-4" /> },
          {
            id: 'script',
            label: mode === 'dubbing' ? 'Script & Dubbing Voice' : 'Script & ဇာတ်ညွှန်း',
            icon: <FileText className="w-4 h-4" />,
          },
          { id: 'subtitles', label: 'SRT/ASS Split & Merge', icon: <Subtitles className="w-4 h-4" /> },
          { id: 'chinese', label: 'တရုတ်မူရင်း & OCR', icon: <Languages className="w-4 h-4" /> },
          { id: 'logs', label: `Logs (${project.logs.length})`, icon: <Terminal className="w-4 h-4" /> },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id as any)}
            className={`flex items-center gap-2 px-4 py-3 text-xs sm:text-sm font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === t.id
                ? 'border-violet-500 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* TAB 1: VIDEO EDITOR */}
      {activeTab === 'video' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {/* Aspect-Ratio Preserved Video Preview (Live Auto Blur + Crisp Subtitles, Zero Manual Mask UI) */}
            {(() => {
              const regions = project.autoBlur?.regions || [];
              const sig = getAutoBlurRenderSignature(autoBlurConfig, regions.length);
              const renderedMatchesConfig =
                isCompleted && project.autoBlur?.renderedSignature === sig;
              const previewSrc = renderedMatchesConfig
                ? `/api/files/${project.id}/final_recap.mp4?v=${encodeURIComponent(
                    project.export?.renderedAt || project.updatedAt
                  )}`
                : `/api/files/${project.id}/video.mp4`;

              return (
                <BlurredVideoPreview
                  videoRef={videoRef}
                  src={previewSrc}
                  videoWidth={project.videoWidth || 1280}
                  videoHeight={project.videoHeight || 720}
                  autoBlurRegions={regions}
                  autoBlurConfig={autoBlurConfig}
                  applyLiveCanvasBlur={!renderedMatchesConfig}
                  activePreviewSubtitle={activePreviewSubtitle}
                  showSubtitleOverlay={!renderedMatchesConfig}
                  subtitleStyle={subtitleStyle}
                  onTimeUpdate={(t) => {
                    setCurrentPlayTime(t);
                    if (subtitleCues.length > 0) {
                      const found = subtitleCues.find((c) => t >= c.startTime && t <= c.endTime);
                      setActivePreviewSubtitle(found ? found.text : null);
                    }
                  }}
                />
              );
            })()}

            {/* Interactive Timeline Cue Scrubber */}
            <div className="p-4 rounded-xl bg-[#0B1020] border border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">Timeline Cues ({subtitleCues.length})</span>
                <span className="font-mono text-slate-400 tabular-nums">
                  {formatTimecode(currentPlayTime)} /{' '}
                  {formatTimecode(
                    (isCompleted && mode === 'dubbing' && project.narration?.durationSeconds) ||
                      project.duration ||
                      0
                  )}
                </span>
              </div>

              {subtitleCues.length === 0 ? (
                <p className="text-xs text-slate-500">
                  စာတန်း Timeline cues များ Step 11 ပြီးစီးပါက ဤနေရာတွင် ပေါ်လာပါမည်။
                </p>
              ) : (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {subtitleCues.map((cue) => {
                    const active =
                      currentPlayTime >= cue.startTime && currentPlayTime <= cue.endTime;
                    return (
                      <button
                        key={cue.id}
                        type="button"
                        onClick={() => seekToTime(cue.startTime)}
                        className={`px-2.5 py-1.5 rounded-lg border text-left shrink-0 max-w-[200px] cursor-pointer transition-colors ${
                          active
                            ? 'bg-violet-600/25 border-violet-400 text-white'
                            : 'bg-[#060913] border-white/[0.08] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <p className="text-[10px] font-mono text-violet-300 tabular-nums">
                          {formatTimecode(cue.startTime)} – {formatTimecode(cue.endTime)}
                        </p>
                        <p className="text-xs truncate">{cue.text}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Export Shortcuts */}
            <div className="p-4 rounded-xl bg-[#0B1020] border border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-300 font-medium">
                ဒေါင်းလုဒ်ရယူနိုင်သော ဖိုင်များ:
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {isCompleted && (
                  <a
                    href={`/api/files/${project.id}/final_recap.mp4?download=1`}
                    download={`${project.title}.mp4`}
                    className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold"
                  >
                    MP4
                  </a>
                )}
                {project.subtitles?.srtPath && (
                  <a
                    href={`/api/files/${project.id}/subtitles.srt?download=1`}
                    download={`${project.title}.srt`}
                    className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-200 text-xs font-medium"
                  >
                    SRT
                  </a>
                )}
                {project.subtitles?.assPath && (
                  <a
                    href={`/api/files/${project.id}/subtitles.ass?download=1`}
                    download={`${project.title}.ass`}
                    className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-200 text-xs font-medium"
                  >
                    ASS
                  </a>
                )}
                {(project.recapScript || project.dialogueScript) && (
                  <a
                    href={`/api/files/${project.id}/${
                      mode === 'recap' ? 'recap_script.txt' : 'dialogue_script.txt'
                    }?download=1`}
                    download={`${project.title}_script.txt`}
                    className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-200 text-xs font-medium"
                  >
                    Script (.txt)
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Right Inspector: Audio Mixer, BGM, Subtitle Position/Blur/Mask, Speed & Re-Render */}
          <div className="space-y-4">
            {/* Auto Blur Mask Controls Only (Toggle, Strength, Blur/Pixelate/Solid Color — Zero Manual Mask Editing) */}
            <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-4">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <EyeOff className="w-4 h-4 text-blue-400" />
                  <span>Auto Blur Mask</span>
                </h3>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    aria-label="Toggle Auto Blur"
                    checked={autoBlurConfig.enabled}
                    onChange={(e) => handleUpdateAutoBlur({ enabled: e.target.checked }, true)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 peer"
                  />
                  <div className="w-10 h-5 bg-slate-800 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
                </label>
              </div>

              <p className="text-[11px] text-slate-400 leading-relaxed">
                ဗီဒီယိုထဲရှိ မူရင်းစာသား၊ Logo၊ Watermark နှင့် Fixed Graphic များကို နောက်ကွယ်မှ အလိုအလျောက် ရှာဖွေဝါးပေးပါသည်။
              </p>

              {autoBlurConfig.enabled && (
                <div className="space-y-3 text-xs">
                  <div>
                    <div className="flex justify-between text-slate-300 mb-1 tabular-nums">
                      <span>Blur Strength</span>
                      <span className="font-mono text-blue-300">{autoBlurConfig.strength}</span>
                    </div>
                    <input
                      type="range"
                      aria-label="Blur Strength"
                      min="2"
                      max="25"
                      step="1"
                      value={autoBlurConfig.strength}
                      onChange={(e) =>
                        handleUpdateAutoBlur({ strength: Number(e.target.value) }, false)
                      }
                      className="w-full accent-blue-500 cursor-pointer"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <span className="block text-slate-300 font-medium">Blur Style</span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[
                        { id: 'blur' as AutoBlurStyle, label: 'Blur' },
                        { id: 'pixelate' as AutoBlurStyle, label: 'Pixelate' },
                        { id: 'solid' as AutoBlurStyle, label: 'Solid Color' },
                      ].map((st) => (
                        <button
                          key={st.id}
                          type="button"
                          onClick={() => handleUpdateAutoBlur({ style: st.id }, true)}
                          className={`py-2 px-2 rounded-lg border text-center text-[11px] font-semibold cursor-pointer transition-colors ${
                            autoBlurConfig.style === st.id
                              ? 'bg-blue-600/25 border-blue-400 text-white'
                              : 'bg-[#060913] border-white/[0.08] text-slate-400 hover:text-slate-200'
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

            {/* Burmese Subtitle Position & Size */}
            <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-4">
              <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Move className="w-4 h-4 text-blue-400" />
                  <span>စာတန်း တည်နေရာ & အရွယ်အစား</span>
                </h3>
                <button
                  type="button"
                  onClick={() => handleSaveSubtitles()}
                  disabled={savingSubtitles}
                  className="text-xs font-semibold text-violet-300 hover:text-white cursor-pointer"
                >
                  {savingSubtitles ? 'သိမ်းနေ...' : 'Style သိမ်းမည်'}
                </button>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <div className="flex justify-between text-slate-300 mb-1 tabular-nums">
                    <span>အလျားလိုက် တည်နေရာ (X)</span>
                    <span className="font-mono text-violet-300">{subtitleStyle.posX}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="90"
                    step="1"
                    value={subtitleStyle.posX}
                    onChange={(e) =>
                      setSubtitleStyle({ ...subtitleStyle, posX: Number(e.target.value) })
                    }
                    className="w-full accent-violet-500 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-slate-300 mb-1 tabular-nums">
                    <span>ဒေါင်လိုက် တည်နေရာ (Y)</span>
                    <span className="font-mono text-violet-300">{subtitleStyle.posY}%</span>
                  </div>
                  <input
                    type="range"
                    min="8"
                    max="94"
                    step="1"
                    value={subtitleStyle.posY}
                    onChange={(e) =>
                      setSubtitleStyle({ ...subtitleStyle, posY: Number(e.target.value) })
                    }
                    className="w-full accent-violet-500 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-slate-300 mb-1 tabular-nums">
                    <span>စာလုံးအရွယ်အစား (Font Scale)</span>
                    <span className="font-mono text-violet-300">
                      {subtitleStyle.fontSizeScale.toFixed(2)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.75"
                    max="1.75"
                    step="0.05"
                    value={subtitleStyle.fontSizeScale}
                    onChange={(e) =>
                      setSubtitleStyle({
                        ...subtitleStyle,
                        fontSizeScale: Number(e.target.value),
                      })
                    }
                    className="w-full accent-violet-500 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Audio Mixer + BGM + Speed + Re-render */}
            <div className="p-5 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2 border-b border-white/[0.06] pb-3">
                <Sliders className="w-4 h-4 text-violet-400" />
                <span>Audio Mixer · BGM · Speaking Speed</span>
              </h3>

              <div className="space-y-3 text-xs">
                <div>
                  <div className="flex justify-between text-slate-300 mb-1 tabular-nums">
                    <span>မူရင်းတရုတ်အသံ (Original Audio)</span>
                    <span className="font-mono text-violet-300">
                      {Math.round(audioMixVolume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={audioMixVolume}
                    onChange={(e) => setAudioMixVolume(parseFloat(e.target.value))}
                    className="w-full accent-violet-500 cursor-pointer"
                  />
                </div>

                {mode !== 'subtitle' && (
                  <>
                    <div>
                      <div className="flex justify-between text-slate-300 mb-1 tabular-nums">
                        <span>မြန်မာ AI အသံ (Narration/Dubbing)</span>
                        <span className="font-mono text-violet-300">
                          {Math.round(narrationVolume * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.2"
                        max="1.5"
                        step="0.05"
                        value={narrationVolume}
                        onChange={(e) => setNarrationVolume(parseFloat(e.target.value))}
                        className="w-full accent-violet-500 cursor-pointer"
                      />
                    </div>

                    {/* BGM Upload & Mix */}
                    <div className="pt-2 border-t border-white/[0.06] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-300 flex items-center gap-1.5">
                          <Music className="w-3.5 h-3.5 text-indigo-400" />
                          <span>နောက်ခံတေးဂီတ (BGM Track)</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => bgmInputRef.current?.click()}
                          disabled={uploadingBgm}
                          className="text-violet-300 hover:text-white font-semibold cursor-pointer"
                        >
                          {uploadingBgm
                            ? 'တင်နေသည်...'
                            : project.settings.bgmFilename
                            ? 'BGM ပြောင်းမည်'
                            : '+ BGM ထည့်မည်'}
                        </button>
                      </div>
                      {project.settings.bgmFilename && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-slate-400 tabular-nums">
                            <span className="truncate">{project.settings.bgmFilename}</span>
                            <span className="font-mono">{Math.round(bgmVolume * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={bgmVolume}
                            onChange={(e) => setBgmVolume(parseFloat(e.target.value))}
                            className="w-full accent-indigo-500 cursor-pointer"
                          />
                        </div>
                      )}
                    </div>

                    {/* Global Dubbing Voice Selector (Single Voice Only) */}
                    {mode === 'dubbing' && (
                      <div className="pt-2 border-t border-white/[0.06] space-y-2">
                        <div className="flex items-center justify-between">
                          <label
                            htmlFor="editor-dubbing-voice-select"
                            className="text-slate-300 flex items-center gap-1.5 font-medium"
                          >
                            <Mic className="w-3.5 h-3.5 text-violet-400" />
                            <span>Dubbing Voice (Single Voice)</span>
                          </label>
                          <button
                            type="button"
                            onClick={() => handlePreviewSpeed(speakingRate, dubbingVoice)}
                            disabled={previewingSpeed}
                            className="text-violet-300 hover:text-white font-medium cursor-pointer"
                          >
                            {previewingSpeed ? 'ဖွင့်နေ...' : 'အသံစမ်းမည်'}
                          </button>
                        </div>
                        <select
                          id="editor-dubbing-voice-select"
                          aria-label="Global Dubbing Voice"
                          value={dubbingVoice}
                          onChange={(e) => handleSelectGlobalDubbingVoice(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg bg-[#060913] border border-white/15 text-xs text-white cursor-pointer"
                        >
                          {DUBBING_VOICE_OPTIONS.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.englishLabel}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Speaking Speed */}
                    <div className="pt-2 border-t border-white/[0.06] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-300 flex items-center gap-1.5">
                          <Gauge className="w-3.5 h-3.5 text-violet-400" />
                          <span>Speed: <span className="font-mono text-white">{speakingRate}</span></span>
                        </span>
                        <button
                          type="button"
                          onClick={() => handlePreviewSpeed(speakingRate)}
                          disabled={previewingSpeed}
                          className="text-violet-300 hover:text-white font-medium cursor-pointer"
                        >
                          {previewingSpeed ? 'ဖွင့်နေ...' : 'စမ်းနားထောင်မည်'}
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {SPEAKING_SPEED_OPTIONS.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setSpeakingRate(s.id)}
                            className={`py-1.5 px-2 rounded-lg border text-center text-[11px] font-mono cursor-pointer ${
                              speakingRate === s.id
                                ? 'bg-violet-600/25 border-violet-400 text-white'
                                : 'bg-[#060913] border-white/[0.06] text-slate-400'
                            }`}
                          >
                            {s.id}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={handleReRender}
                disabled={reRendering || isProcessing}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white text-xs font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reRendering ? 'animate-spin' : ''}`} />
                <span>{reRendering ? 'ဗီဒီယို ပြန်ပေါင်းစပ်နေသည်...' : 'ပြင်ဆင်ချက်များဖြင့် Re-render မည်'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: SCRIPT & CHARACTER VOICES */}
      {activeTab === 'script' && (
        <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
            <div>
              <h2 className="text-base font-bold text-white">
                {mode === 'recap'
                  ? 'မြန်မာ ဇာတ်လမ်းပြန်ပြော ဇာတ်ညွှန်း (Recap Script)'
                  : mode === 'dubbing'
                  ? 'တစ်ကြောင်းချင်း ဘာသာပြန်နှင့် Global Dubbing အသံ (Single Voice)'
                  : 'တစ်ကြောင်းချင်း ဘာသာပြန် စာတန်းများ (Dialogue Translation)'}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {mode === 'dubbing'
                  ? 'စာသားများကို တည်းဖြတ်ပြီး ရွေးချယ်ထားသော မြန်မာ AI အသံတစ်မျိုးတည်းကို ဇာတ်ကောင်အားလုံးအတွက် အသုံးပြုပါမည်။'
                  : 'စာသားများကို တည်းဖြတ်ပြီး သိမ်းဆည်းနိုင်ပါသည်။'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {!isEditingScript ? (
                <button
                  type="button"
                  onClick={() => setIsEditingScript(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-violet-300 text-xs font-semibold cursor-pointer"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>တည်းဖြတ်မည်</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSaveScript()}
                  disabled={savingScript}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{savingScript ? 'သိမ်းနေသည်...' : 'သိမ်းဆည်းမည်'}</span>
                </button>
              )}
            </div>
          </div>

          {mode === 'recap' ? (
            !editableScript ? (
              <p className="py-10 text-center text-sm text-slate-400">
                ဇာတ်ညွှန်း ရေးသားနေဆဲ ဖြစ်ပါသည်...
              </p>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-400">ခေါင်းစဉ်</label>
                    <input
                      type="text"
                      disabled={!isEditingScript}
                      value={editableScript.title}
                      onChange={(e) =>
                        setEditableScript({ ...editableScript, title: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#060913] border border-white/10 text-sm text-white disabled:opacity-80"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-400">အမျိုးအစား & Narration Style</label>
                    <input
                      type="text"
                      disabled={!isEditingScript}
                      value={editableScript.genre}
                      onChange={(e) =>
                        setEditableScript({ ...editableScript, genre: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#060913] border border-white/10 text-sm text-white disabled:opacity-80"
                    />
                  </div>
                </div>

                {editableScript.scenesSummary && editableScript.scenesSummary.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-slate-300">
                      ဇာတ်ကွက်အစဉ်လိုက် ခွဲခြမ်းစိတ်ဖြာချက် (Scenes Chronology)
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {editableScript.scenesSummary.map((sc, i) => (
                        <div
                          key={i}
                          className="p-3 rounded-xl bg-[#060913] border border-white/[0.06] text-xs space-y-1"
                        >
                          <p className="font-mono text-violet-300">{sc.timeRange}</p>
                          <p className="text-slate-300">{sc.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-slate-300">ဇာတ်လမ်း အကျဉ်းချုပ်</h3>
                  <textarea
                    rows={3}
                    disabled={!isEditingScript}
                    value={editableScript.synopsis}
                    onChange={(e) =>
                      setEditableScript({ ...editableScript, synopsis: e.target.value })
                    }
                    className="w-full p-3 rounded-xl bg-[#060913] border border-white/10 text-sm text-slate-200 leading-relaxed disabled:opacity-80"
                  />
                </div>

                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-slate-300">
                    ဇာတ်ကြောင်းပြော စာပိုဒ်များ ({editableScript.narrationSegments.length})
                  </h3>
                  {editableScript.narrationSegments.map((seg, idx) => (
                    <div
                      key={seg.id || idx}
                      className="p-3.5 rounded-xl bg-[#060913] border border-white/[0.06] space-y-1.5"
                    >
                      <span className="text-[11px] font-mono text-violet-300">Segment #{idx + 1}</span>
                      <textarea
                        rows={2}
                        disabled={!isEditingScript}
                        value={seg.text}
                        onChange={(e) => {
                          const next = [...editableScript.narrationSegments];
                          next[idx] = { ...next[idx], text: e.target.value };
                          setEditableScript({ ...editableScript, narrationSegments: next });
                        }}
                        className="w-full p-2.5 rounded-lg bg-[#0B1020] border border-white/10 text-sm text-slate-100 disabled:opacity-85"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : !editableDialogue ? (
            <p className="py-10 text-center text-sm text-slate-400">
              ဘာသာပြန် စာကြောင်းများ ပြုစုနေဆဲ ဖြစ်ပါသည်...
            </p>
          ) : (
            <div className="space-y-6">
              {/* Single Global Dubbing Voice Selector */}
              {mode === 'dubbing' && (
                <div className="p-4 rounded-xl bg-[#060913] border border-violet-500/30 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-white flex items-center gap-2">
                        <Mic className="w-4 h-4 text-violet-400" />
                        <span>Global Dubbing Voice (Single Voice Only — All Characters)</span>
                      </h3>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        ရွေးချယ်ထားသော မြန်မာ AI အသံတစ်မျိုးတည်းကိုသာ ဇာတ်ကောင်နှင့် စကားပြောအပိုင်းအားလုံးတွင် အသုံးပြုပါမည်။
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handlePreviewSpeed(speakingRate, dubbingVoice)}
                        disabled={previewingSpeed}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-300 hover:text-white cursor-pointer"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>{previewingSpeed ? 'ဖွင့်နေ...' : 'အသံစမ်းမည်'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveScript()}
                        disabled={savingScript}
                        className="text-xs font-semibold text-violet-300 hover:text-white cursor-pointer"
                      >
                        {savingScript ? 'သိမ်းနေ...' : 'အသံရွေးချယ်မှု သိမ်းမည်'}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {DUBBING_VOICE_OPTIONS.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => handleSelectGlobalDubbingVoice(v.id)}
                        className={`p-3 rounded-xl border text-left cursor-pointer transition-colors ${
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

              {/* Dialogue Lines (Speaking Editable vs Silence 1.0x Preserved) */}
              <div className="space-y-2.5">
                {editableDialogue.segments.map((seg, idx) => {
                  const isSilence =
                    seg.kind === 'silence' ||
                    (mode === 'dubbing' && !seg.chineseText?.trim() && !seg.burmeseText?.trim());

                  if (isSilence) {
                    return (
                      <div
                        key={seg.id || idx}
                        className="px-4 py-3 rounded-xl bg-[#060913]/60 border border-dashed border-white/[0.08] flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-slate-400 tabular-nums">
                            #{idx + 1} · {formatTimecode(seg.start)} – {formatTimecode(seg.end)}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px] font-mono">
                            SILENCE · 1.00x Original Speed
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-500">
                          မူရင်းအမြန်နှုန်းအတိုင်း ထိန်းသိမ်းထားသည် (No AI Voice · No Subtitle)
                        </span>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={seg.id || idx}
                      className="p-4 rounded-xl bg-[#060913] border border-white/[0.06] space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-violet-300 tabular-nums">
                            #{idx + 1} · {formatTimecode(seg.start)} – {formatTimecode(seg.end)}
                          </span>
                          {mode === 'dubbing' && (
                            <span className="px-2 py-0.5 rounded bg-violet-500/15 text-violet-200 text-[11px] font-mono tabular-nums">
                              SPEAKING
                              {typeof seg.videoSpeedFactor === 'number'
                                ? ` · Video ${seg.videoSpeedFactor.toFixed(2)}x`
                                : ''}
                              {typeof seg.ttsDuration === 'number'
                                ? ` · TTS ${seg.ttsDuration.toFixed(2)}s`
                                : ''}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isEditingScript ? (
                            <input
                              type="text"
                              value={seg.speaker || 'Speaker 1'}
                              onChange={(e) => {
                                const next = [...editableDialogue.segments];
                                next[idx] = { ...next[idx], speaker: e.target.value };
                                setEditableDialogue({ ...editableDialogue, segments: next });
                              }}
                              className="px-2 py-1 rounded bg-[#0B1020] border border-white/10 text-xs text-slate-200 w-28"
                            />
                          ) : (
                            <span className="text-slate-300 font-medium">
                              {seg.speaker || 'Speaker 1'}
                              {seg.emotion ? ` · ${seg.emotion}` : ''}
                            </span>
                          )}
                        </div>
                      </div>

                      <p className="text-xs text-slate-400">{seg.chineseText}</p>
                      <textarea
                        rows={2}
                        disabled={!isEditingScript}
                        value={seg.burmeseText}
                        onChange={(e) => {
                          const next = [...editableDialogue.segments];
                          next[idx] = { ...next[idx], burmeseText: e.target.value };
                          setEditableDialogue({ ...editableDialogue, segments: next });
                        }}
                        className="w-full p-2.5 rounded-lg bg-[#0B1020] border border-white/10 text-sm text-white disabled:opacity-90"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SUBTITLE CUE EDITOR (SPLIT / MERGE / TIMING) */}
      {activeTab === 'subtitles' && (
        <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
            <div>
              <h2 className="text-base font-bold text-white">
                စာတန်း အချိန်ကိုက် တည်းဖြတ်ခြင်း (Split · Merge · Timing)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                စာတန်းအပိုင်းများကို ခွဲခြင်း (Split)၊ ပေါင်းစပ်ခြင်း (Merge) နှင့် အချိန်ညှိ၍ SRT & ASS အဖြစ် သိမ်းဆည်းနိုင်ပါသည်။
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleSaveSubtitles()}
                disabled={savingSubtitles || subtitleCues.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{savingSubtitles ? 'သိမ်းနေ...' : 'SRT & ASS သိမ်းမည်'}</span>
              </button>

              {project.subtitles?.srtPath && (
                <a
                  href={`/api/files/${project.id}/subtitles.srt?download=1`}
                  download={`${project.title}.srt`}
                  className="px-3 py-2 rounded-lg bg-white/[0.06] border border-white/10 text-xs text-slate-200 font-medium"
                >
                  SRT
                </a>
              )}
              {project.subtitles?.assPath && (
                <a
                  href={`/api/files/${project.id}/subtitles.ass?download=1`}
                  download={`${project.title}.ass`}
                  className="px-3 py-2 rounded-lg bg-white/[0.06] border border-white/10 text-xs text-slate-200 font-medium"
                >
                  ASS
                </a>
              )}
            </div>
          </div>

          {subtitleCues.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">
              စာတန်းများ ထုတ်လုပ်ပြီးပါက ဤနေရာတွင် Split/Merge တည်းဖြတ်နိုင်ပါမည်။
            </p>
          ) : (
            <div className="space-y-2.5 max-h-[560px] overflow-y-auto pr-1">
              {subtitleCues.map((cue, idx) => (
                <div
                  key={cue.id}
                  className="p-3.5 rounded-xl bg-[#060913] border border-white/[0.07] space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs tabular-nums">
                      <span className="font-mono text-violet-300 font-semibold">#{cue.id}</span>
                      <label className="text-slate-400 flex items-center gap-1">
                        <span>Start</span>
                        <input
                          type="number"
                          step="0.1"
                          value={cue.startTime}
                          onChange={(e) =>
                            setSubtitleCues((prev) =>
                              updateSubtitleCue(prev, cue.id, {
                                startTime: parseFloat(e.target.value) || 0,
                              })
                            )
                          }
                          className="w-20 px-2 py-1 rounded bg-[#0B1020] border border-white/10 font-mono text-white"
                        />
                      </label>
                      <label className="text-slate-400 flex items-center gap-1">
                        <span>End</span>
                        <input
                          type="number"
                          step="0.1"
                          value={cue.endTime}
                          onChange={(e) =>
                            setSubtitleCues((prev) =>
                              updateSubtitleCue(prev, cue.id, {
                                endTime: parseFloat(e.target.value) || 0.2,
                              })
                            )
                          }
                          className="w-20 px-2 py-1 rounded bg-[#0B1020] border border-white/10 font-mono text-white"
                        />
                      </label>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSubtitleCues((prev) => splitSubtitleCue(prev, cue.id))}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs text-slate-200 cursor-pointer"
                      >
                        <Split className="w-3 h-3 text-blue-400" />
                        <span>Split</span>
                      </button>

                      {idx < subtitleCues.length - 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSubtitleCues((prev) =>
                              mergeSubtitleCues(prev, cue.id, subtitleCues[idx + 1].id)
                            )
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs text-slate-200 cursor-pointer"
                        >
                          <Merge className="w-3 h-3 text-violet-400" />
                          <span>Merge Next</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <textarea
                    rows={2}
                    value={cue.text}
                    onChange={(e) =>
                      setSubtitleCues((prev) =>
                        updateSubtitleCue(prev, cue.id, { text: e.target.value })
                      )
                    }
                    className="w-full p-2.5 rounded-lg bg-[#0B1020] border border-white/10 text-sm text-white"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: SOURCE CHINESE TRANSCRIPT & OCR */}
      {activeTab === 'chinese' && (
        <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">တရုတ်စကားပြော မှတ်တမ်း</h3>
              <span className="text-xs font-mono text-violet-300">
                Provider: {project.transcription?.provider || 'whisper'} ·{' '}
                {project.transcription?.segments?.length || 0} segs
              </span>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {(project.transcription?.segments || []).map((seg) => (
                <div
                  key={seg.id}
                  className="p-3 rounded-xl bg-[#060913] border border-white/[0.06] text-xs space-y-1"
                >
                  <p className="font-mono text-violet-400 tabular-nums">
                    [{seg.start.toFixed(1)}s – {seg.end.toFixed(1)}s]
                  </p>
                  <p className="text-slate-200">{seg.text}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Gemini Vision OCR</h3>
              <span className="text-xs font-mono text-blue-300">
                {project.ocr?.detections?.length || 0} detections
              </span>
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {(project.ocr?.detections || []).length === 0 ? (
                <p className="text-xs text-slate-500">မျက်နှာပြင် စာတန်း မတွေ့ရှိပါ</p>
              ) : (
                (project.ocr?.detections || []).map((ocr, i) => (
                  <div
                    key={i}
                    className="p-3 rounded-xl bg-[#060913] border border-white/[0.06] text-xs space-y-1"
                  >
                    <p className="font-mono text-blue-400 tabular-nums">
                      [{ocr.timestamp.toFixed(1)}s]
                    </p>
                    <p className="text-slate-200">{ocr.chineseText}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: LOGS */}
      {activeTab === 'logs' && (
        <div className="p-6 rounded-2xl bg-[#0B1020] border border-white/[0.08] space-y-3">
          <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
            <h2 className="text-sm font-semibold text-white">လုပ်ငန်းစဉ် မှတ်တမ်းများ</h2>
            <span className="text-xs font-mono text-slate-400">{project.logs.length} entries</span>
          </div>
          <div className="space-y-2 max-h-96 overflow-y-auto font-mono text-xs">
            {project.logs.map((log, idx) => (
              <div
                key={idx}
                className={`p-3 rounded-xl border flex items-start gap-3 ${
                  log.type === 'error'
                    ? 'bg-rose-950/20 border-rose-500/30 text-rose-300'
                    : log.type === 'warn'
                    ? 'bg-amber-950/20 border-amber-500/30 text-amber-300'
                    : log.type === 'success'
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
                    : 'bg-[#060913] border-white/[0.06] text-slate-300'
                }`}
              >
                <span className="text-slate-500 shrink-0 tabular-nums">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-violet-300 font-bold shrink-0">S{log.step}</span>
                <span className="flex-1 font-sans">{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
