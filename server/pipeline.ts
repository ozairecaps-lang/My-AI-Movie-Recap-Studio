import fs from 'fs';
import path from 'path';
import {
  Project,
  ProcessingMode,
  DialogueTranslationSegment,
} from './types';
import {
  getVideoMetadata,
  extractAudio,
  extractFrames,
  renderFinalRecap,
  generateDemoVideo,
  assembleDubbingVideoWithSilencePreserved,
} from './ffmpeg';
import {
  transcribeChineseAudio,
  generateRecapWithGroq,
  translateDialogueWithGroq,
  extractOcrWithGroqVision,
  detectOverlayRegionsWithGroqVision,
  getGroqApiKey,
} from './groq';
import {
  extractOcrFromFrames,
  detectOverlayRegionsFromFrames,
  generateBurmeseRecapScript,
  translateChineseDialogueSegments,
  transcribeChineseAudioWithGemini,
} from './gemini';
import {
  generateBurmeseNarration,
  generateBurmeseDubbingSegmentClips,
  validateDubbingVoiceId,
} from './tts';
import { getProviderConfig } from './providers';
import { combineTranscriptAndOcr } from '../src/utils/transcript';
import { applySingleDubbingVoiceToSegments } from '../src/utils/editorMath';
import {
  buildSpeakingAndSilenceTimeline,
  mergeTranslatedSpeakingSegments,
  normalizeDubbingSegmentsWithSilence,
} from '../src/utils/dubbingTimeline';
import {
  generateSrtContent,
  generateAssContent,
  breakBurmeseLines,
  SubtitleCue,
} from '../src/utils/subtitle';
import {
  DEFAULT_AUTO_BLUR_CONFIG,
  sanitizeAutoBlurConfig,
  getAutoBlurRenderSignature,
  AutoBlurRegion,
} from '../src/utils/autoBlur';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'projects');

let projects: Project[] = [];
const activeJobControllers = new Map<string, AbortController>();

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export function loadProjects(): Project[] {
  ensureDirs();
  if (fs.existsSync(PROJECTS_FILE)) {
    try {
      const data = fs.readFileSync(PROJECTS_FILE, 'utf8');
      projects = JSON.parse(data);
    } catch (err) {
      console.error('Error reading projects.json:', err);
      projects = [];
    }
  } else {
    projects = [];
  }
  return projects;
}

export function saveProjects() {
  ensureDirs();
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8');
}

export function getAllProjects(): Project[] {
  return loadProjects();
}

export function getProjectById(id: string): Project | undefined {
  loadProjects();
  return projects.find((p) => p.id === id);
}

export function deleteProject(id: string): boolean {
  cancelProjectJob(id);
  loadProjects();
  const index = projects.findIndex((p) => p.id === id);
  if (index === -1) return false;

  const projectDir = path.join(UPLOADS_DIR, id);
  if (fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  projects.splice(index, 1);
  saveProjects();
  return true;
}

export function addProject(project: Project): Project {
  loadProjects();
  projects.unshift(project);
  saveProjects();
  return project;
}

export function updateProject(id: string, updates: Partial<Project>): Project | undefined {
  loadProjects();
  const index = projects.findIndex((p) => p.id === id);
  if (index === -1) return undefined;

  projects[index] = {
    ...projects[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  saveProjects();
  return projects[index];
}

export function appendProjectLog(
  id: string,
  step: number,
  message: string,
  type: 'info' | 'warn' | 'error' | 'success' = 'info'
) {
  loadProjects();
  const p = projects.find((proj) => proj.id === id);
  if (p) {
    p.logs.push({
      timestamp: new Date().toISOString(),
      step,
      message,
      type,
    });
    saveProjects();
  }
}

/**
 * Cancel an active background pipeline job and terminate running FFmpeg processes
 */
export function cancelProjectJob(projectId: string): boolean {
  const controller = activeJobControllers.get(projectId);
  if (controller) {
    controller.abort();
    activeJobControllers.delete(projectId);
  }
  const proj = getProjectById(projectId);
  if (proj && (proj.status === 'processing' || proj.status === 'uploaded')) {
    updateProject(projectId, {
      status: 'cancelled',
      currentStepTitle: 'အသုံးပြုသူမှ လုပ်ငန်းစဉ်ကို ရပ်တန့်လိုက်ပါသည် (Cancelled)',
      error: null,
    });
    appendProjectLog(projectId, proj.currentStep || 1, 'လုပ်ငန်းစဉ်ကို ရပ်တန့်ပြီးပါပြီ (Job cancelled)', 'warn');
    return true;
  }
  return false;
}

export function getActiveJobIds(): string[] {
  return Array.from(activeJobControllers.keys());
}

/**
 * Reconcile any orphaned 'processing' or 'uploaded' jobs left behind after a server restart
 */
export function reconcileStaleJobsOnStartup(): number {
  loadProjects();
  let fixed = 0;
  for (const p of projects) {
    if ((p.status === 'processing' || p.status === 'uploaded') && !activeJobControllers.has(p.id)) {
      p.status = 'failed';
      p.error =
        'ဆာဗာ ပြန်လည်စတင်ချိန်တွင် လုပ်ငန်းစဉ် ရပ်တန့်သွားပါသည် — Retry ခလုတ်ကို နှိပ်၍ ဆက်လက်လုပ်ဆောင်နိုင်ပါသည်';
      p.currentStepTitle = 'ဆာဗာ ရပ်တန့်မှုကြောင့် ပြန်လည်စတင်ရန် လိုအပ်ပါသည် (Retry Ready)';
      p.updatedAt = new Date().toISOString();
      p.logs.push({
        timestamp: new Date().toISOString(),
        step: p.currentStep || 1,
        message: 'Server restarted mid-job; marked ready for Retry.',
        type: 'warn',
      });
      fixed++;
    }
  }
  if (fixed > 0) {
    saveProjects();
  }
  return fixed;
}

/**
 * Clean up intermediate temporary files for a project while preserving source video and final outputs
 */
export function cleanupProjectTempFiles(projectId: string): { freedBytes: number } {
  const projectDir = path.join(UPLOADS_DIR, projectId);
  if (!fs.existsSync(projectDir)) return { freedBytes: 0 };

  let freedBytes = 0;
  const tempDirs = [
    'frames',
    'narration_segments',
    'dubbing_segments',
    'dubbing_video_segments',
    'audio_chunks',
  ];
  for (const dirName of tempDirs) {
    const target = path.join(projectDir, dirName);
    if (fs.existsSync(target)) {
      freedBytes += getDirSize(target);
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  const tempFiles = ['audio.mp3', 'extracted_audio.mp3'];
  for (const fName of fs.readdirSync(projectDir)) {
    if (
      tempFiles.includes(fName) ||
      fName.includes('.raw_') ||
      fName.includes('.edge_') ||
      fName.includes('.google_') ||
      fName.includes('.gem_')
    ) {
      const fPath = path.join(projectDir, fName);
      if (fs.existsSync(fPath) && fs.statSync(fPath).isFile()) {
        freedBytes += fs.statSync(fPath).size;
        fs.unlinkSync(fPath);
      }
    }
  }

  updateProject(projectId, { tempCleaned: true });
  appendProjectLog(
    projectId,
    13,
    `ယာယီဖိုင်များ ရှင်းလင်းပြီးပါပြီ (${(freedBytes / (1024 * 1024)).toFixed(2)} MB သက်သာ)`,
    'info'
  );
  return { freedBytes };
}

function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

/**
 * Compute real disk storage statistics across uploads and project data
 */
export function getStorageStats(): {
  totalBytes: number;
  sourceVideosBytes: number;
  renderedExportsBytes: number;
  tempFilesBytes: number;
  projectCount: number;
  activeJobsCount: number;
} {
  ensureDirs();
  loadProjects();
  let sourceVideosBytes = 0;
  let renderedExportsBytes = 0;
  let tempFilesBytes = 0;
  let totalBytes = 0;

  if (fs.existsSync(UPLOADS_DIR)) {
    for (const projEntry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const pDir = path.join(UPLOADS_DIR, projEntry.name);
      for (const item of fs.readdirSync(pDir, { withFileTypes: true })) {
        const full = path.join(pDir, item.name);
        if (item.isDirectory()) {
          const sz = getDirSize(full);
          tempFilesBytes += sz;
          totalBytes += sz;
        } else if (item.isFile()) {
          const sz = fs.statSync(full).size;
          totalBytes += sz;
          if (item.name === 'video.mp4') {
            sourceVideosBytes += sz;
          } else if (
            item.name === 'final_recap.mp4' ||
            item.name === 'subtitles.srt' ||
            item.name === 'subtitles.ass' ||
            item.name.endsWith('_script.txt')
          ) {
            renderedExportsBytes += sz;
          } else {
            tempFilesBytes += sz;
          }
        }
      }
    }
  }

  return {
    totalBytes,
    sourceVideosBytes,
    renderedExportsBytes,
    tempFilesBytes,
    projectCount: projects.length,
    activeJobsCount: activeJobControllers.size,
  };
}

function isAbortError(err: any): boolean {
  return (
    err?.name === 'AbortError' ||
    err?.message === 'JOB_CANCELLED' ||
    String(err?.message || '').includes('aborted')
  );
}

/**
 * Run automated background processing pipeline with real progress & cancellation support
 */
export async function runProjectPipeline(
  projectId: string,
  startFromStep = 1,
  groqApiKey?: string
): Promise<void> {
  const p = getProjectById(projectId);
  if (!p) return;

  // Cancel any stale controller for this project
  activeJobControllers.get(projectId)?.abort();
  const controller = new AbortController();
  activeJobControllers.set(projectId, controller);
  const { signal } = controller;

  const projectDir = path.join(UPLOADS_DIR, projectId);
  const videoPath = path.join(projectDir, 'video.mp4');
  const audioPath = path.join(projectDir, 'audio.mp3');
  const framesDir = path.join(projectDir, 'frames');

  updateProject(projectId, {
    status: 'processing',
    error: null,
  });

  try {
    const checkAborted = () => {
      if (signal.aborted) throw new Error('JOB_CANCELLED');
    };

    // STEP 2: Probe video metadata
    let sourceHasAudio = true;
    if (startFromStep <= 2) {
      checkAborted();
      updateProject(projectId, {
        currentStep: 2,
        progress: 10,
        currentStepTitle: 'ဗီဒီယို ဖိုင် စစ်ဆေးခြင်းနှင့် ကြာချိန်တွက်ချက်ခြင်း',
      });
      appendProjectLog(projectId, 2, 'ဗီဒီယို ဖိုင်ကို FFprobe ဖြင့် စစ်ဆေးနေပါသည်...', 'info');

      if (!fs.existsSync(videoPath)) {
        throw new Error('တင်ထားသော ဗီဒီယိုဖိုင် မရှိပါ (video.mp4 not found)');
      }

      const meta = await getVideoMetadata(videoPath);
      sourceHasAudio = meta.hasAudio;
      updateProject(projectId, {
        duration: meta.duration,
        videoWidth: meta.width,
        videoHeight: meta.height,
      });

      appendProjectLog(
        projectId,
        2,
        `ဗီဒီယို အချက်အလက်: ${Math.round(meta.duration)}s · ${meta.width}x${meta.height} · ${
          meta.hasAudio ? 'Audio stream detected' : 'Silent video (no audio track)'
        }`,
        'success'
      );
    } else if (fs.existsSync(videoPath)) {
      const meta = await getVideoMetadata(videoPath);
      sourceHasAudio = meta.hasAudio;
    }

    // Automatic background Auto-Blur region detection (text, logos, watermarks, fixed graphics)
    if (startFromStep <= 6) {
      checkAborted();
      const projAfterMeta = getProjectById(projectId);
      if (!projAfterMeta?.autoBlur?.detectedAt) {
        const videoDuration = projAfterMeta?.duration || 30;
        const interval = Math.max(2, Math.floor(videoDuration / 10));
        const hasFrames =
          fs.existsSync(framesDir) &&
          fs.readdirSync(framesDir).some((f) => f.endsWith('.jpg') || f.endsWith('.png'));
        if (!hasFrames) {
          await extractFrames(videoPath, framesDir, interval, 12, signal);
        }

        let detectedRegions: AutoBlurRegion[] = [];
        const hasGroq = Boolean((groqApiKey && groqApiKey.trim()) || getGroqApiKey());
        try {
          detectedRegions = await detectOverlayRegionsFromFrames(
            framesDir,
            interval,
            videoDuration
          );
        } catch (abErr: any) {
          if (hasGroq) {
            try {
              detectedRegions = await detectOverlayRegionsWithGroqVision(
                framesDir,
                interval,
                videoDuration,
                groqApiKey
              );
            } catch {}
          } else {
            console.warn('Auto blur detection warning:', abErr?.message || abErr);
          }
        }

        const existingCfg = sanitizeAutoBlurConfig(
          projAfterMeta?.autoBlur?.config ?? projAfterMeta?.settings.autoBlur
        );
        updateProject(projectId, {
          autoBlur: {
            regions: detectedRegions,
            config: existingCfg,
            detectedAt: new Date().toISOString(),
            renderedSignature: projAfterMeta?.autoBlur?.renderedSignature,
          },
        });
        appendProjectLog(
          projectId,
          2,
          `Auto Blur Mask: မူရင်းစာသား/Logo/Watermark ဧရိယာ ${detectedRegions.length} ခု အလိုအလျောက် ရှာဖွေသတ်မှတ်ပြီးပါပြီ`,
          'info'
        );
      }
    }

    // STEP 3: Extract Audio with FFmpeg (skip cleanly if video has no audio stream)
    if (startFromStep <= 3) {
      checkAborted();
      updateProject(projectId, {
        currentStep: 3,
        progress: 22,
        currentStepTitle: 'FFmpeg ဖြင့် အသံဖိုင် သီးသန့် ခွဲထုတ်ခြင်း',
      });

      if (!sourceHasAudio) {
        appendProjectLog(
          projectId,
          3,
          'ဗီဒီယိုတွင် အသံလမ်းကြောင်း မပါဝင်ပါ — မျက်နှာပြင် ဖရိမ်များနှင့် OCR မှ ဆက်လက်ခွဲခြမ်းပါမည်',
          'warn'
        );
      } else {
        appendProjectLog(projectId, 3, 'ဗီဒီယိုမှ တရုတ်စကားပြော အသံလမ်းကြောင်းကို ခွဲထုတ်နေပါသည်...', 'info');
        await extractAudio(videoPath, audioPath, signal);
        appendProjectLog(projectId, 3, 'အသံလမ်းကြောင်း ခွဲထုတ်ခြင်း အောင်မြင်ပါသည် (16kHz mono MP3)', 'success');
      }
    }

    // STEP 4: Chinese Speech Recognition (Groq Whisper -> Gemini 3.5 Transcribe fallback)
    if (startFromStep <= 4) {
      checkAborted();
      if (!sourceHasAudio || !fs.existsSync(audioPath)) {
        updateProject(projectId, {
          currentStep: 4,
          progress: 35,
          currentStepTitle: 'အသံလမ်းကြောင်း မပါဝင်သဖြင့် Visual OCR အဆင့်သို့ ကူးပြောင်းနေသည်',
          transcription: {
            segments: [],
            language: 'zh',
            provider: 'none',
          },
        });
      } else {
        updateProject(projectId, {
          currentStep: 4,
          progress: 35,
          currentStepTitle: 'Groq Whisper Large V3 ဖြင့် တရုတ်စကားပြောများကို စာသားပြောင်းခြင်း',
        });
        appendProjectLog(
          projectId,
          4,
          'တရုတ်ဘာသာစကား စကားပြောများကို Whisper Large V3 ဖြင့် နားထောင်မှတ်သားနေပါသည်...',
          'info'
        );

        try {
          const transResult = await transcribeChineseAudio(audioPath, groqApiKey);
          updateProject(projectId, {
            transcription: {
              segments: transResult.segments,
              language: 'zh',
              provider: 'groq',
            },
          });
          appendProjectLog(
            projectId,
            4,
            `Groq Whisper ဖြင့် စကားပြော အပိုင်း ${transResult.segments.length} ခု မှတ်သားပြီးပါပြီ`,
            'success'
          );
        } catch (groqErr: any) {
          appendProjectLog(
            projectId,
            4,
            `Groq Whisper ချိတ်ဆက်မှု အဆင်မပြေပါ (${groqErr.message})။ Gemini 3.5 Transcribe ဖြင့် မှတ်သားနေပါသည်...`,
            'warn'
          );

          const currentDur = getProjectById(projectId)?.duration || 30;
          const gemResult = await transcribeChineseAudioWithGemini(audioPath, currentDur);
          updateProject(projectId, {
            transcription: {
              segments: gemResult.segments,
              language: 'zh',
              provider: 'gemini',
            },
          });
          appendProjectLog(
            projectId,
            4,
            `Gemini Transcribe ဖြင့် စကားပြော အပိုင်း ${gemResult.segments.length} ခု မှတ်သားပြီးပါပြီ`,
            'success'
          );
        }
      }
    }

    // STEP 5: Extract Video Frames (reuse frames if already extracted for Auto Blur)
    if (startFromStep <= 5) {
      checkAborted();
      updateProject(projectId, {
        currentStep: 5,
        progress: 48,
        currentStepTitle: 'FFmpeg ဖြင့် ဗီဒီယို မျက်နှာပြင် ဖရိမ်များကို ခွဲထုတ်ခြင်း',
      });

      const existingFrames = fs.existsSync(framesDir)
        ? fs
            .readdirSync(framesDir)
            .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
            .sort()
        : [];
      if (existingFrames.length > 0) {
        appendProjectLog(
          projectId,
          5,
          `ဖရိမ် စုစုပေါင်း ${existingFrames.length} ခု အဆင်သင့် ထုတ်ယူပြီးပါပြီ`,
          'success'
        );
      } else {
        const currentProj = getProjectById(projectId);
        const videoDuration = currentProj?.duration || 30;
        const interval = Math.max(2, Math.floor(videoDuration / 10));
        const extracted = await extractFrames(videoPath, framesDir, interval, 12, signal);

        appendProjectLog(projectId, 5, `ဖရိမ် စုစုပေါင်း ${extracted.length} ခု ထုတ်ယူပြီးပါပြီ`, 'success');
      }
    }

    // STEP 6: Vision OCR (Gemini Vision with Groq Llama 4 Scout Vision failover)
    if (startFromStep <= 6) {
      checkAborted();
      updateProject(projectId, {
        currentStep: 6,
        progress: 58,
        currentStepTitle: 'AI Vision ဖြင့် မျက်နှာပြင်ပေါ်ရှိ တရုတ်စာတန်းများကို ဖတ်ရှုခြင်း',
      });

      const currentProj = getProjectById(projectId);
      const videoDuration = currentProj?.duration || 30;
      const interval = Math.max(2, Math.floor(videoDuration / 10));

      let ocrDetections = [] as any[];
      const hasGroq = Boolean((groqApiKey && groqApiKey.trim()) || getGroqApiKey());
      try {
        ocrDetections = await extractOcrFromFrames(framesDir, interval);
      } catch (ocrErr: any) {
        appendProjectLog(
          projectId,
          6,
          `Gemini Vision OCR မအောင်မြင်ပါ (${ocrErr.message}) — Groq Vision OCR ဖြင့် ဆက်လက်ဖတ်ရှုနေပါသည်...`,
          'warn'
        );
        if (hasGroq) {
          ocrDetections = await extractOcrWithGroqVision(framesDir, interval, groqApiKey);
        }
      }

      updateProject(projectId, {
        ocr: {
          detections: ocrDetections,
          frameCount: fs.existsSync(framesDir) ? fs.readdirSync(framesDir).length : 0,
        },
      });

      appendProjectLog(
        projectId,
        6,
        `မျက်နှာပြင် စာတန်း/စာသား ${ocrDetections.length} ခု ဖတ်ရှုတွေ့ရှိပါသည်`,
        'info'
      );
    }

    // STEP 7 & 8: Translation / Scene & Story Recap Script (Bidirectional Gemini <-> Groq failover)
    if (startFromStep <= 8) {
      checkAborted();
      const currentProj = getProjectById(projectId)!;
      const transcript = currentProj.transcription?.segments || [];
      const ocr = currentProj.ocr?.detections || [];
      const mode = currentProj.settings.mode || 'recap';
      const providerCfg = getProviderConfig();
      const hasGroq = Boolean((groqApiKey && groqApiKey.trim()) || getGroqApiKey());

      if (mode === 'dubbing') {
        const videoDuration = currentProj.duration || 30;
        const speechSource =
          transcript.length > 0
            ? transcript
            : ocr.map((o, idx) => ({
                id: idx + 1,
                start: Math.max(0, o.timestamp),
                end: Math.min(videoDuration, o.timestamp + 2.8),
                text: o.chineseText,
              }));

        const timelinePartition = buildSpeakingAndSilenceTimeline(speechSource, videoDuration);
        const speakingSlots = timelinePartition.filter((s) => s.kind === 'speaking');
        const silenceCount = timelinePartition.length - speakingSlots.length;

        updateProject(projectId, {
          currentStep: 8,
          progress: 70,
          currentStepTitle: 'စကားပြောအပိုင်းများကိုသာ မြန်မာ Dubbing ဘာသာပြန်ခြင်း (Silence 1.0x ထိန်းသိမ်း)',
        });
        appendProjectLog(
          projectId,
          8,
          `Groq Timeline ခွဲခြမ်းမှု: Speaking ${speakingSlots.length} ခု · Silence ${silenceCount} ခု (Silence များတွင် AI အသံ မထည့်ပါ)`,
          'info'
        );

        let translatedSpeaking: DialogueTranslationSegment[] = [];
        if (speakingSlots.length > 0) {
          const speakingSpeechSegments = speakingSlots.map((s, idx) => ({
            id: idx + 1,
            start: s.start,
            end: s.end,
            text: s.text,
          }));

          if (providerCfg.textProvider === 'groq') {
            try {
              translatedSpeaking = await translateDialogueWithGroq(
                speakingSpeechSegments,
                [],
                groqApiKey
              );
            } catch (groqErr: any) {
              appendProjectLog(
                projectId,
                8,
                `Groq ဘာသာပြန် မအောင်မြင်ပါ (${groqErr.message}) — Gemini ဖြင့် ဆက်လက်ဘာသာပြန်နေပါသည်...`,
                'warn'
              );
              translatedSpeaking = await translateChineseDialogueSegments(
                speakingSpeechSegments,
                []
              );
            }
          } else {
            try {
              translatedSpeaking = await translateChineseDialogueSegments(
                speakingSpeechSegments,
                []
              );
            } catch (gemErr: any) {
              if (!hasGroq) throw gemErr;
              appendProjectLog(
                projectId,
                8,
                `Gemini ဘာသာပြန် မအောင်မြင်ပါ (${gemErr.message}) — Groq Llama 3.3 ဖြင့် အလိုအလျောက် ပြောင်းလဲဘာသာပြန်နေပါသည်...`,
                'warn'
              );
              translatedSpeaking = await translateDialogueWithGroq(
                speakingSpeechSegments,
                [],
                groqApiKey
              );
            }
          }
        }

        const globalDubbingVoice = validateDubbingVoiceId(
          currentProj.settings.dubbingVoice || currentProj.settings.ttsVoice,
          providerCfg.dubbingDefaultVoice
        );
        const mergedTimeline = mergeTranslatedSpeakingSegments(
          timelinePartition,
          translatedSpeaking,
          globalDubbingVoice
        );
        const unifiedSegments = applySingleDubbingVoiceToSegments(mergedTimeline, globalDubbingVoice);
        const nextSettings = { ...currentProj.settings };
        delete nextSettings.characterVoices;
        nextSettings.dubbingVoice = globalDubbingVoice;
        nextSettings.ttsVoice = globalDubbingVoice;
        nextSettings.ttsProvider = 'gemini';

        updateProject(projectId, {
          dialogueScript: {
            segments: unifiedSegments,
            approved: false,
          },
          settings: nextSettings,
          status: 'waiting_approval',
          currentStep: 9,
          progress: 75,
          currentStepTitle: 'မြန်မာ ဘာသာပြန် (Speaking Only) နှင့် Gemini Dubbing အသံ စစ်ဆေးအတည်ပြုရန်',
        });

        appendProjectLog(
          projectId,
          9,
          `Speaking ${speakingSlots.length} ခုကိုသာ မြန်မာ Dubbing ဘာသာပြန်ပြီးပါပြီ (Silence ${silenceCount} ခု အလွတ်ထားရှိသည်)`,
          'success'
        );
        return;
      } else if (mode === 'subtitle') {
        const modeTitle = 'တရုတ်စကားပြောများကို အချိန်ကိုက် မြန်မာစာတန်း ဘာသာပြန်ခြင်း (Subtitle)';

        updateProject(projectId, {
          currentStep: 8,
          progress: 70,
          currentStepTitle: modeTitle,
        });
        appendProjectLog(projectId, 8, `${modeTitle} (${providerCfg.textProvider})...`, 'info');

        let dialogueSegments: DialogueTranslationSegment[];
        if (providerCfg.textProvider === 'groq') {
          try {
            dialogueSegments = await translateDialogueWithGroq(transcript, ocr, groqApiKey);
          } catch (groqErr: any) {
            appendProjectLog(
              projectId,
              8,
              `Groq ဘာသာပြန် မအောင်မြင်ပါ (${groqErr.message}) — Gemini ဖြင့် ဆက်လက်ဘာသာပြန်နေပါသည်...`,
              'warn'
            );
            dialogueSegments = await translateChineseDialogueSegments(transcript, ocr);
          }
        } else {
          try {
            dialogueSegments = await translateChineseDialogueSegments(transcript, ocr);
          } catch (gemErr: any) {
            if (!hasGroq) throw gemErr;
            appendProjectLog(
              projectId,
              8,
              `Gemini ဘာသာပြန် မအောင်မြင်ပါ (${gemErr.message}) — Groq Llama 3.3 ဖြင့် အလိုအလျောက် ပြောင်းလဲဘာသာပြန်နေပါသည်...`,
              'warn'
            );
            dialogueSegments = await translateDialogueWithGroq(transcript, ocr, groqApiKey);
          }
        }

        updateProject(projectId, {
          dialogueScript: {
            segments: dialogueSegments,
            approved: false,
          },
          status: 'waiting_approval',
          currentStep: 9,
          progress: 75,
          currentStepTitle: 'မြန်မာ စာတန်းများကို Split/Merge နှင့် အတည်ပြုရန်',
        });

        appendProjectLog(
          projectId,
          9,
          `စကားပြော အပိုင်း ${dialogueSegments.length} ခုကို မြန်မာဘာသာသို့ ပြန်ဆိုပြီးပါပြီ။ အတည်ပြုရန် စောင့်ဆိုင်းနေပါသည်`,
          'success'
        );
        return;
      } else {
        updateProject(projectId, {
          currentStep: 8,
          progress: 70,
          currentStepTitle: 'ဇာတ်လမ်း၊ ဇာတ်ကောင်နှင့် မြန်မာ Recap ဇာတ်ညွှန်း ဖန်တီးခြင်း',
        });
        appendProjectLog(
          projectId,
          8,
          `AI (${providerCfg.textProvider}) ဖြင့် ဇာတ်လမ်းခွဲခြမ်းစိတ်ဖြာနေပါသည်...`,
          'info'
        );

        const { summaryContext } = combineTranscriptAndOcr(transcript, ocr);

        let recapScript;
        if (providerCfg.textProvider === 'groq') {
          try {
            recapScript = await generateRecapWithGroq({
              chineseTimelineContext: summaryContext,
              recapLength: currentProj.settings.recapLength,
              narrationStyle: currentProj.settings.narrationStyle,
              videoDuration: currentProj.duration,
              framesDir,
              customGroqKey: groqApiKey,
            });
          } catch (groqErr: any) {
            appendProjectLog(
              projectId,
              8,
              `Groq Recap မအောင်မြင်ပါ (${groqErr.message}) — Gemini ဖြင့် ဆက်လက်ဖန်တီးနေပါသည်...`,
              'warn'
            );
            recapScript = await generateBurmeseRecapScript({
              chineseTimelineContext: summaryContext,
              recapLength: currentProj.settings.recapLength,
              narrationStyle: currentProj.settings.narrationStyle,
              videoDuration: currentProj.duration,
              framesDir,
            });
          }
        } else {
          try {
            recapScript = await generateBurmeseRecapScript({
              chineseTimelineContext: summaryContext,
              recapLength: currentProj.settings.recapLength,
              narrationStyle: currentProj.settings.narrationStyle,
              videoDuration: currentProj.duration,
              framesDir,
            });
          } catch (gemErr: any) {
            if (!hasGroq) throw gemErr;
            appendProjectLog(
              projectId,
              8,
              `Gemini Recap မအောင်မြင်ပါ (${gemErr.message}) — Groq AI ဖြင့် အလိုအလျောက် ပြောင်းလဲဖန်တီးနေပါသည်...`,
              'warn'
            );
            recapScript = await generateRecapWithGroq({
              chineseTimelineContext: summaryContext,
              recapLength: currentProj.settings.recapLength,
              narrationStyle: currentProj.settings.narrationStyle,
              videoDuration: currentProj.duration,
              framesDir,
              customGroqKey: groqApiKey,
            });
          }
        }

        updateProject(projectId, {
          recapScript,
          status: 'waiting_approval',
          currentStep: 9,
          progress: 75,
          currentStepTitle: 'မြန်မာ ဇာတ်ကြောင်းပြော စာသားကို စစ်ဆေးခြင်းနှင့် အတည်ပြုခြင်း',
        });

        appendProjectLog(
          projectId,
          9,
          `မြန်မာ ဇာတ်ကြောင်းပြောစာသား အပိုင်း ${recapScript.narrationSegments.length} ခု ရေးသားပြီးပါပြီ`,
          'success'
        );
        return;
      }
    }

    if (startFromStep <= 10) {
      await continueAfterScriptApproval(projectId);
    }
  } catch (err: any) {
    if (isAbortError(err)) {
      updateProject(projectId, {
        status: 'cancelled',
        currentStepTitle: 'လုပ်ငန်းစဉ် ရပ်တန့်ထားပါသည် (Cancelled)',
      });
      return;
    }
    console.error(`Pipeline error on project ${projectId}:`, err);
    updateProject(projectId, {
      status: 'failed',
      error: err.message || 'လုပ်ငန်းဆောင်ရွက်စဉ် အမှားအယွင်း ဖြစ်ပေါ်ခဲ့သည်',
    });
    appendProjectLog(projectId, p.currentStep || 1, `ချွတ်ယွင်းချက်: ${err.message}`, 'error');
  } finally {
    if (activeJobControllers.get(projectId) === controller) {
      activeJobControllers.delete(projectId);
    }
  }
}

/**
 * Steps 10-13: Voice synthesis, Subtitle SRT/ASS generation, FFmpeg render & BGM mix, Export
 */
export async function continueAfterScriptApproval(projectId: string): Promise<void> {
  const currentProj = getProjectById(projectId);
  if (!currentProj) return;

  activeJobControllers.get(projectId)?.abort();
  const controller = new AbortController();
  activeJobControllers.set(projectId, controller);
  const { signal } = controller;

  const mode = currentProj.settings.mode || 'recap';
  const projectDir = path.join(UPLOADS_DIR, projectId);
  const videoPath = path.join(projectDir, 'video.mp4');
  const finalVideoPath = path.join(projectDir, 'final_recap.mp4');
  const bgmAudioPath = currentProj.settings.bgmFilename
    ? path.join(projectDir, currentProj.settings.bgmFilename)
    : undefined;

  updateProject(projectId, {
    status: 'processing',
    error: null,
  });

  try {
    const checkAborted = () => {
      if (signal.aborted) throw new Error('JOB_CANCELLED');
    };

    let finalSrtPath = '';
    let finalAssPath = '';
    let cuesCount = 0;

    if (mode === 'subtitle') {
      checkAborted();
      const dialogueSegments = currentProj.dialogueScript?.segments || [];
      updateProject(projectId, {
        currentStep: 11,
        progress: 85,
        currentStepTitle: 'မြန်မာစာတန်း SRT & ASS ဖိုင်များ ပြင်ဆင်ခြင်း',
      });

      const subtitleCues: SubtitleCue[] = dialogueSegments.map((seg, idx) => ({
        id: idx + 1,
        startTime: seg.start,
        endTime: seg.end,
        text: breakBurmeseLines(seg.burmeseText, 45),
      }));

      const srtContent = generateSrtContent(subtitleCues);
      finalSrtPath = path.join(projectDir, 'subtitles.srt');
      fs.writeFileSync(finalSrtPath, srtContent, 'utf8');

      const assContent = generateAssContent(
        subtitleCues,
        currentProj.videoWidth || 1280,
        currentProj.videoHeight || 720,
        currentProj.settings.subtitleStyle
      );
      finalAssPath = path.join(projectDir, 'subtitles.ass');
      fs.writeFileSync(finalAssPath, assContent, 'utf8');
      cuesCount = subtitleCues.length;

      updateProject(projectId, {
        subtitles: {
          srtPath: finalSrtPath,
          assPath: finalAssPath,
          cuesCount,
        },
        currentStep: 12,
        progress: 92,
        currentStepTitle: 'FFmpeg ဖြင့် မြန်မာစာတန်းများကို ဗီဒီယိုထဲသို့ ထိုးသွင်းနေပါသည်',
      });

      const latestForBlur = getProjectById(projectId) || currentProj;
      const activeAutoBlur = {
        regions: latestForBlur.autoBlur?.regions || [],
        config: sanitizeAutoBlurConfig(latestForBlur.autoBlur?.config ?? latestForBlur.settings.autoBlur),
      };

      const renderRes = await renderFinalRecap({
        videoPath,
        narrationAudioPath: '',
        bgmAudioPath,
        srtPath: finalSrtPath,
        outputPath: finalVideoPath,
        originalAudioVolume: currentProj.settings.originalAudioVolume ?? 1.0,
        bgmVolume: currentProj.settings.bgmVolume ?? 0.2,
        burnSubtitles: currentProj.settings.burnSubtitles,
        subtitleStyle: currentProj.settings.subtitleStyle,
        autoBlur: activeAutoBlur,
        signal,
      });
      if (renderRes.assPath) finalAssPath = renderRes.assPath;
    } else if (mode === 'recap') {
      checkAborted();
      if (!currentProj.recapScript) throw new Error('Recap script missing');

      updateProject(projectId, {
        currentStep: 10,
        progress: 82,
        currentStepTitle: 'မြန်မာ AI သဘာဝအသံဖြင့် ဇာတ်ကြောင်းပြော အသံဖိုင် ဖန်တီးခြင်း',
      });

      const { audioPath, srtPath, assPath, totalDuration, cues, providerUsed } =
        await generateBurmeseNarration({
          segments: currentProj.recapScript.narrationSegments,
          voiceId: currentProj.settings.ttsVoice,
          provider: currentProj.settings.ttsProvider,
          rate: currentProj.settings.speakingRate,
          outputDir: projectDir,
          videoWidth: currentProj.videoWidth || 1280,
          videoHeight: currentProj.videoHeight || 720,
          subtitleStyle: currentProj.settings.subtitleStyle,
          signal,
        });

      finalSrtPath = srtPath;
      finalAssPath = assPath;
      cuesCount = cues.length;

      updateProject(projectId, {
        narration: {
          audioPath,
          durationSeconds: totalDuration,
          voiceUsed: currentProj.settings.ttsVoice,
          providerUsed,
        },
        subtitles: {
          srtPath,
          assPath,
          cuesCount,
        },
        currentStep: 12,
        progress: 92,
        currentStepTitle: 'FFmpeg ဖြင့် ရုပ်သံ၊ မြန်မာအသံနှင့် စာတန်းများ ပေါင်းစပ်တည်းဖြတ်ခြင်း',
      });

      const latestForBlur = getProjectById(projectId) || currentProj;
      const activeAutoBlur = {
        regions: latestForBlur.autoBlur?.regions || [],
        config: sanitizeAutoBlurConfig(latestForBlur.autoBlur?.config ?? latestForBlur.settings.autoBlur),
      };

      await renderFinalRecap({
        videoPath,
        narrationAudioPath: audioPath,
        bgmAudioPath,
        srtPath,
        outputPath: finalVideoPath,
        originalAudioVolume: currentProj.settings.originalAudioVolume ?? 0.15,
        narrationVolume: currentProj.settings.narrationVolume ?? 1.0,
        bgmVolume: currentProj.settings.bgmVolume ?? 0.2,
        burnSubtitles: currentProj.settings.burnSubtitles,
        subtitleStyle: currentProj.settings.subtitleStyle,
        autoBlur: activeAutoBlur,
        signal,
      });
    } else if (mode === 'dubbing') {
      checkAborted();
      const providerCfg = getProviderConfig();
      const globalDubbingVoice = validateDubbingVoiceId(
        currentProj.settings.dubbingVoice || currentProj.settings.ttsVoice,
        providerCfg.dubbingDefaultVoice
      );
      const rawSegments = currentProj.dialogueScript?.segments || [];
      const hasTimelinePartition = rawSegments.some((s) => s.kind === 'silence' || s.kind === 'speaking');
      const normalizedSegments = hasTimelinePartition
        ? normalizeDubbingSegmentsWithSilence(
            applySingleDubbingVoiceToSegments(rawSegments, globalDubbingVoice),
            globalDubbingVoice
          )
        : mergeTranslatedSpeakingSegments(
            buildSpeakingAndSilenceTimeline(
              rawSegments.map((s, idx) => ({
                id: idx + 1,
                start: s.start,
                end: s.end,
                text: s.chineseText || s.burmeseText || '',
              })),
              currentProj.duration || 30
            ),
            rawSegments,
            globalDubbingVoice
          );

      const speakingCount = normalizedSegments.filter((s) => s.kind === 'speaking').length;
      const silenceCount = normalizedSegments.length - speakingCount;

      updateProject(projectId, {
        currentStep: 10,
        progress: 82,
        currentStepTitle: `Speaking ${speakingCount} ခုအတွက် Gemini TTS (${globalDubbingVoice}) အသံထုတ်လုပ်နေပါသည် (Silence ${silenceCount} ခု ချန်လှပ်)...`,
      });

      const { timelineItems, providerUsed, voiceUsed } = await generateBurmeseDubbingSegmentClips({
        segments: normalizedSegments,
        voiceId: globalDubbingVoice,
        rate: currentProj.settings.speakingRate,
        outputDir: projectDir,
        signal,
      });

      updateProject(projectId, {
        currentStep: 12,
        progress: 90,
        currentStepTitle: 'Speaking ဗီဒီယိုအပိုင်းများကိုသာ AI အသံနှင့် အမြန်နှုန်းညှိ၍ Silence (1.0x) နှင့် ပေါင်းစပ်နေပါသည်...',
      });

      const dubbingAudioOut = path.join(projectDir, 'dubbing.mp3');
      finalSrtPath = path.join(projectDir, 'subtitles.srt');
      finalAssPath = path.join(projectDir, 'subtitles.ass');

      const latestForBlur = getProjectById(projectId) || currentProj;
      const activeAutoBlur = {
        regions: latestForBlur.autoBlur?.regions || [],
        config: sanitizeAutoBlurConfig(latestForBlur.autoBlur?.config ?? latestForBlur.settings.autoBlur),
      };

      const assembled = await assembleDubbingVideoWithSilencePreserved({
        videoPath,
        segments: timelineItems,
        outputPath: finalVideoPath,
        combinedAudioOutputPath: dubbingAudioOut,
        srtOutputPath: finalSrtPath,
        assOutputPath: finalAssPath,
        bgmAudioPath,
        originalAudioVolume: currentProj.settings.originalAudioVolume ?? 0.15,
        narrationVolume: currentProj.settings.narrationVolume ?? 1.0,
        bgmVolume: currentProj.settings.bgmVolume ?? 0.2,
        burnSubtitles: currentProj.settings.burnSubtitles,
        subtitleStyle: currentProj.settings.subtitleStyle,
        autoBlur: activeAutoBlur,
        signal,
      });

      cuesCount = assembled.cues.length;
      const timingById = new Map(assembled.segmentTimings.map((t) => [t.id, t]));
      const updatedSegments = normalizedSegments.map((seg, idx) => {
        const timing = timingById.get(seg.id) || assembled.segmentTimings[idx];
        if (!timing) return seg;
        return {
          ...seg,
          videoSpeedFactor: timing.videoSpeedFactor,
          outputStart: timing.outputStart,
          outputEnd: timing.outputEnd,
          ...(timing.ttsDuration !== undefined ? { ttsDuration: timing.ttsDuration } : {}),
        };
      });

      updateProject(projectId, {
        dialogueScript: {
          segments: updatedSegments,
          approved: true,
        },
        narration: {
          audioPath: assembled.audioPath,
          durationSeconds: assembled.totalDuration,
          voiceUsed,
          providerUsed,
        },
        subtitles: {
          srtPath: assembled.srtPath,
          assPath: assembled.assPath,
          cuesCount,
        },
      });

      appendProjectLog(
        projectId,
        12,
        `Silence-preserved Dubbing Assembly ပြီးစီးပါပြီ (Speaking ${speakingCount} ခု အသံ/အမြန်နှုန်းညှိပြီး · Silence ${silenceCount} ခု 1.0x မူရင်းအတိုင်း · စုစုပေါင်း ${assembled.totalDuration.toFixed(1)}s)`,
        'success'
      );
    }

    // STEP 13: Verify output video & write Script text & finalize
    if (!fs.existsSync(finalVideoPath) || fs.statSync(finalVideoPath).size < 1000) {
      throw new Error('FFmpeg render did not produce a valid MP4 output file');
    }

    const latestProj = getProjectById(projectId) || currentProj;
    const scriptTxtPath = path.join(
      projectDir,
      mode === 'recap' ? 'recap_script.txt' : 'dialogue_script.txt'
    );
    let scriptFullText = '';
    if (mode === 'recap' && latestProj.recapScript) {
      scriptFullText = `${latestProj.recapScript.title}\n\nဇာတ်လမ်းအကျဉ်း:\n${latestProj.recapScript.synopsis}\n\nဇာတ်ကြောင်းပြော စာသားများ:\n${latestProj.recapScript.narrationSegments
        .map((s) => `${s.id}. ${s.text}`)
        .join('\n\n')}`;
    } else if (latestProj.dialogueScript) {
      scriptFullText = `တရုတ်စကားပြော နှင့် မြန်မာဘာသာပြန် စာသားများ:\n\n${latestProj.dialogueScript.segments
        .map((s) =>
          s.kind === 'silence'
            ? `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] [SILENCE · 1.00x Original Speed — No AI Voice]`
            : `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.speaker || ''}${
                s.videoSpeedFactor ? ` (${s.videoSpeedFactor.toFixed(2)}x video speed)` : ''
              }\nတရုတ်: ${s.chineseText}\nမြန်မာ: ${s.burmeseText}`
        )
        .join('\n\n')}`;
    }
    fs.writeFileSync(scriptTxtPath, scriptFullText, 'utf8');

    const renderedAutoBlurCfg = sanitizeAutoBlurConfig(
      latestProj.autoBlur?.config ?? latestProj.settings.autoBlur
    );
    const renderedAutoBlurRegions = latestProj.autoBlur?.regions || [];

    updateProject(projectId, {
      status: 'completed',
      error: null,
      currentStep: 13,
      progress: 100,
      currentStepTitle: 'ပြီးစီးပါပြီ! အပြီးသတ် MP4, SRT နှင့် ASS ဖိုင်များကို ဒေါင်းလုဒ်လုပ်နိုင်ပါပြီ',
      autoBlur: {
        regions: renderedAutoBlurRegions,
        config: renderedAutoBlurCfg,
        detectedAt: latestProj.autoBlur?.detectedAt,
        renderedSignature: getAutoBlurRenderSignature(
          renderedAutoBlurCfg,
          renderedAutoBlurRegions.length
        ),
      },
      export: {
        videoPath: finalVideoPath,
        srtPath: finalSrtPath,
        assPath: finalAssPath,
        scriptPath: scriptTxtPath,
        renderedAt: new Date().toISOString(),
      },
    });

    appendProjectLog(
      projectId,
      13,
      `အပြီးသတ် MP4 ဗီဒီယို ဖန်တီးမှု အောင်မြင်ပါပြီ (${mode.toUpperCase()} MODE)`,
      'success'
    );
  } catch (err: any) {
    if (isAbortError(err)) {
      updateProject(projectId, {
        status: 'cancelled',
        currentStepTitle: 'လုပ်ငန်းစဉ် ရပ်တန့်ထားပါသည် (Cancelled)',
      });
      return;
    }
    console.error(`Post-approval pipeline error on project ${projectId}:`, err);
    updateProject(projectId, {
      status: 'failed',
      error: err.message || 'ဗီဒီယို တည်းဖြတ်ပေါင်းစပ်စဉ် ချွတ်ယွင်းချက် ဖြစ်ပေါ်ခဲ့သည်',
    });
    appendProjectLog(projectId, 12, `ချွတ်ယွင်းချက်: ${err.message}`, 'error');
  } finally {
    if (activeJobControllers.get(projectId) === controller) {
      activeJobControllers.delete(projectId);
    }
  }
}

/**
 * Create a sample project with real Mandarin speech video for instant workflow verification
 */
export async function createDemoProject(mode: ProcessingMode = 'recap'): Promise<Project> {
  const projectId = 'demo_' + Date.now().toString(36);
  const projectDir = path.join(UPLOADS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const videoPath = path.join(projectDir, 'video.mp4');
  await generateDemoVideo(videoPath);
  const meta = await getVideoMetadata(videoPath);

  const providerCfg = getProviderConfig();
  const demoVoice =
    mode === 'dubbing'
      ? validateDubbingVoiceId(providerCfg.dubbingDefaultVoice)
      : providerCfg.defaultVoice || 'my-MM-NilarNeural';

  const demoProject: Project = {
    id: projectId,
    title: `နမူနာ တရုတ်ရုပ်ရှင် (${
      mode === 'subtitle' ? 'Subtitle Mode' : mode === 'dubbing' ? 'Dubbing Mode' : 'Recap Mode'
    })`,
    originalFilename: 'chinese_sample_clip.mp4',
    fileSize: fs.statSync(videoPath).size,
    duration: meta.duration,
    videoWidth: meta.width,
    videoHeight: meta.height,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'uploaded',
    currentStep: 1,
    progress: 5,
    currentStepTitle: 'ဗီဒီယို အဆင်သင့်ဖြစ်ပါပြီ',
    mode,
    settings: {
      mode,
      recapLength: 'short',
      narrationStyle: 'dramatic',
      ttsVoice: demoVoice,
      ...(mode === 'dubbing' ? { dubbingVoice: demoVoice, ttsProvider: 'gemini' as const } : {}),
      speakingRate: '1.00x',
      originalAudioVolume: mode === 'subtitle' ? 1.0 : 0.15,
      narrationVolume: 1.0,
      bgmVolume: 0.2,
      burnSubtitles: true,
      fontSize: 18,
      autoBlur: { ...DEFAULT_AUTO_BLUR_CONFIG },
    },
    autoBlur: {
      regions: [],
      config: { ...DEFAULT_AUTO_BLUR_CONFIG },
    },
    logs: [
      {
        timestamp: new Date().toISOString(),
        step: 1,
        message: `နမူနာ ဗီဒီယိုဖိုင် ဖန်တီးပြီးပါပြီ [${mode.toUpperCase()} MODE]`,
        type: 'info',
      },
    ],
  };

  addProject(demoProject);
  return demoProject;
}
