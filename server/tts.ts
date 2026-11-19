import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execFile } from 'child_process';
import util from 'util';
import {
  NarrationSegment,
  DialogueTranslationSegment,
  TtsProviderType,
} from './types';
import {
  SubtitleCue,
  SubtitleStyleConfig,
  generateSrtContent,
  generateAssContent,
  breakBurmeseLines,
} from '../src/utils/subtitle';
import { getVideoMetadata } from './ffmpeg';
import { getProviderConfig } from './providers';
import { synthesizeWithGeminiTts } from './gemini';
import { createRequire } from 'module';
import { buildAtempoFilter, parseSpeedMultiplier } from '../src/utils/speed';
import {
  DEFAULT_DUBBING_VOICE_ID,
  DubbingVoiceOption,
  isValidDubbingVoiceId,
  resolveSingleDubbingVoice,
} from '../src/utils/editorMath';

const execFileAsync = util.promisify(execFile);
const require = createRequire(import.meta.url);
const { EdgeTTS } = require('node-edge-tts');
export { EdgeTTS };

export interface TtsVoiceOption {
  id: string;
  name: string;
  gender: 'female' | 'male';
  provider: TtsProviderType;
  sampleText: string;
}

export const BURMESE_VOICES: TtsVoiceOption[] = [
  {
    id: 'my-MM-NilarNeural',
    name: 'နီလာ (မိန်းကလေးအသံ - Edge Neural)',
    gender: 'female',
    provider: 'edge',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
  {
    id: 'my-MM-ThihaNeural',
    name: 'သီဟ (ယောက်ျားလေးအသံ - Edge Neural)',
    gender: 'male',
    provider: 'edge',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
  {
    id: 'gemini-Kore',
    name: 'Kore (မိန်းကလေးအသံ - Gemini 3.8 TTS)',
    gender: 'female',
    provider: 'gemini',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
  {
    id: 'gemini-Charon',
    name: 'Charon (ယောက်ျားလေးအသံ - Gemini 3.8 TTS)',
    gender: 'male',
    provider: 'gemini',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
  {
    id: 'gemini-Zephyr',
    name: 'Zephyr (လူငယ်အသံ - Gemini 3.8 TTS)',
    gender: 'female',
    provider: 'gemini',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
  {
    id: 'gemini-Fenrir',
    name: 'Fenrir (စိတ်လှုပ်ရှားအသံ - Gemini 3.8 TTS)',
    gender: 'male',
    provider: 'gemini',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
  {
    id: 'gemini-Puck',
    name: 'Puck (နွေးထွေးအသံ - Gemini 3.8 TTS)',
    gender: 'male',
    provider: 'gemini',
    sampleText: 'မင်္ဂလာပါ၊ My AI Movie Recap Studio မှ ကြိုဆိုပါတယ်။ ဇာတ်ကားရှင်းပြချက်ကို စတင်နားဆင်ပါတော့မယ်။',
  },
];

export function isValidBurmeseVoiceId(voiceId?: string | null): boolean {
  return Boolean(voiceId && BURMESE_VOICES.some((v) => v.id === voiceId));
}

export function validateDubbingVoiceId(
  voiceId?: string | null,
  fallback: string = DEFAULT_DUBBING_VOICE_ID
): DubbingVoiceOption['id'] {
  const safeFallback = resolveSingleDubbingVoice(fallback, DEFAULT_DUBBING_VOICE_ID);
  return resolveSingleDubbingVoice(voiceId, safeFallback);
}

function splitBurmeseTextForGoogle(text: string, maxLen = 120): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let sliceIdx = remaining.lastIndexOf('။', maxLen);
    if (sliceIdx === -1 || sliceIdx < 40) sliceIdx = remaining.lastIndexOf('၊', maxLen);
    if (sliceIdx === -1 || sliceIdx < 40) sliceIdx = remaining.lastIndexOf(' ', maxLen);
    if (sliceIdx === -1 || sliceIdx < 40) sliceIdx = maxLen;
    else sliceIdx = sliceIdx + 1;
    chunks.push(remaining.substring(0, sliceIdx).trim());
    remaining = remaining.substring(sliceIdx).trim();
  }
  return chunks.filter((c) => c.length > 0);
}

function downloadGoogleTtsChunk(text: string): Promise<Buffer> {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
    text
  )}&tl=my&client=tw-ob`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 9000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Google TTS status: ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google TTS request timeout'));
    });
    req.on('error', reject);
  });
}

export async function synthesizeBurmeseWithGoogle(
  text: string,
  outputPath: string
): Promise<boolean> {
  try {
    const chunks = splitBurmeseTextForGoogle(text);
    if (chunks.length === 0) return false;
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      const buf = await downloadGoogleTtsChunk(chunk);
      if (buf && buf.length > 100) {
        buffers.push(buf);
      }
    }
    if (buffers.length === 0) return false;
    fs.writeFileSync(outputPath, Buffer.concat(buffers));
    const stats = fs.statSync(outputPath);
    return stats.size > 500;
  } catch {
    return false;
  }
}

async function applyAtempoIfNeeded(
  rawPath: string,
  outputPath: string,
  speedMultiplier: number
): Promise<void> {
  const needsAtempo = Math.abs(speedMultiplier - 1.0) >= 0.01;
  if (!needsAtempo) {
    if (rawPath !== outputPath) {
      fs.renameSync(rawPath, outputPath);
    }
    return;
  }
  const atempoFilter = buildAtempoFilter(speedMultiplier);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    rawPath,
    '-filter:a',
    atempoFilter,
    '-acodec',
    'libmp3lame',
    '-b:a',
    '192k',
    outputPath,
  ]);
  try {
    if (rawPath !== outputPath && fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  } catch {}
}

/**
 * Synthesize a single Burmese speech audio segment using configurable TTS adapter:
 * - 'edge': EdgeTTS Neural (my-MM-NilarNeural / my-MM-ThihaNeural)
 * - 'google': Google Myanmar Voice Engine
 * - 'gemini': Gemini 3.8 TTS
 * Falls back cleanly across remaining real speech engines if a provider hits transient 429/quota.
 */
export async function synthesizeBurmeseTts(params: {
  text: string;
  outputPath: string;
  voiceId?: string;
  provider?: TtsProviderType;
  rate?: string;
  segmentIndex?: number;
  skipEdgeTts?: boolean;
  styleHint?: string;
  lockVoice?: boolean;
}): Promise<{ outputPath: string; duration: number; providerUsed: TtsProviderType; isFallback?: boolean }> {
  const {
    text,
    outputPath,
    voiceId = 'my-MM-NilarNeural',
    rate = '1.00x',
    skipEdgeTts = false,
    styleHint,
    lockVoice = false,
  } = params;

  const globalCfg = getProviderConfig();
  const preferredProvider: TtsProviderType =
    voiceId.startsWith('gemini-')
      ? 'gemini'
      : lockVoice
      ? 'edge'
      : params.provider || globalCfg.ttsProvider || 'edge';

  const speedMultiplier = parseSpeedMultiplier(rate);
  const needsAtempo = Math.abs(speedMultiplier - 1.0) >= 0.01;

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Reuse valid existing segment audio on retry
  if (fs.existsSync(outputPath)) {
    try {
      const stats = fs.statSync(outputPath);
      if (stats.size > 800) {
        const meta = await getVideoMetadata(outputPath);
        if (meta.duration > 0.2) {
          return { outputPath, duration: meta.duration, providerUsed: preferredProvider };
        }
      }
      fs.unlinkSync(outputPath);
    } catch {
      try {
        fs.unlinkSync(outputPath);
      } catch {}
    }
  }

  const cleanText = text.trim();
  if (!cleanText) {
    const silenceDuration = Math.max(0.2, 0.5 / speedMultiplier);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=24000:cl=mono',
      '-t',
      String(silenceDuration),
      '-acodec',
      'libmp3lame',
      '-b:a',
      '64k',
      outputPath,
    ]);
    return { outputPath, duration: silenceDuration, providerUsed: preferredProvider };
  }

  const providerOrder: TtsProviderType[] = lockVoice
    ? preferredProvider === 'gemini'
      ? ['gemini', 'edge', 'google']
      : [preferredProvider]
    : preferredProvider === 'gemini'
    ? ['gemini', 'edge', 'google']
    : preferredProvider === 'google'
    ? ['google', 'edge', 'gemini']
    : ['edge', 'google', 'gemini'];

  const errors: string[] = [];
  const genderMatchedEdgeVoice =
    voiceId === 'gemini-Charon' ||
    voiceId === 'gemini-Fenrir' ||
    voiceId === 'gemini-Puck' ||
    voiceId === 'my-MM-ThihaNeural'
      ? 'my-MM-ThihaNeural'
      : 'my-MM-NilarNeural';

  for (const provider of providerOrder) {
    if (provider === 'edge' && skipEdgeTts && providerOrder[0] !== 'edge') {
      continue;
    }

    if (provider === 'edge' && !skipEdgeTts) {
      const edgeVoice = voiceId.startsWith('my-MM-') ? voiceId : genderMatchedEdgeVoice;
      const altVoice = edgeVoice === 'my-MM-NilarNeural' ? 'my-MM-ThihaNeural' : 'my-MM-NilarNeural';
      const candidateVoices = lockVoice
        ? [edgeVoice, edgeVoice, edgeVoice]
        : [edgeVoice, altVoice];

      for (let attempt = 0; attempt < candidateVoices.length; attempt++) {
        const candidateVoice = candidateVoices[attempt];
        const rawPath = needsAtempo ? `${outputPath}.edge_${Date.now()}.mp3` : outputPath;
        try {
          const tts = new EdgeTTS({ voice: candidateVoice, lang: 'my-MM', rate: '+0%' });
          await tts.ttsPromise(cleanText, rawPath);
          if (fs.existsSync(rawPath) && fs.statSync(rawPath).size > 800) {
            await applyAtempoIfNeeded(rawPath, outputPath, speedMultiplier);
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
              const meta = await getVideoMetadata(outputPath);
              const duration = meta.duration > 0.2 ? meta.duration : 3.0 / speedMultiplier;
              return {
                outputPath,
                duration,
                providerUsed: 'edge',
                isFallback: preferredProvider !== 'edge',
              };
            }
          }
          errors.push(`EdgeTTS (${candidateVoice}): empty audio output`);
        } catch (err: any) {
          errors.push(`EdgeTTS (${candidateVoice}): ${err.message}`);
          try {
            if (fs.existsSync(rawPath) && rawPath !== outputPath) fs.unlinkSync(rawPath);
          } catch {}
          if (err.message?.includes('429')) {
            if (lockVoice && attempt < candidateVoices.length - 1) {
              await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
              continue;
            }
            break;
          }
        }
        if (lockVoice && attempt < candidateVoices.length - 1) {
          await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
        }
      }
    }

    if (provider === 'google') {
      const rawPath = needsAtempo ? `${outputPath}.google_${Date.now()}.mp3` : outputPath;
      try {
        const ok = await synthesizeBurmeseWithGoogle(cleanText, rawPath);
        if (ok && fs.existsSync(rawPath)) {
          await applyAtempoIfNeeded(rawPath, outputPath, speedMultiplier);
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
            const meta = await getVideoMetadata(outputPath);
            if (meta.duration > 0.2) {
              return {
                outputPath,
                duration: meta.duration,
                providerUsed: 'google',
                isFallback: preferredProvider !== 'google',
              };
            }
          }
        }
        errors.push('Google Myanmar TTS produced empty output');
      } catch (err: any) {
        errors.push(`Google TTS: ${err.message}`);
        try {
          if (fs.existsSync(rawPath) && rawPath !== outputPath) fs.unlinkSync(rawPath);
        } catch {}
      }
    }

    if (provider === 'gemini') {
      const rawPath = needsAtempo ? `${outputPath}.gem_${Date.now()}.mp3` : outputPath;
      try {
        const geminiVoice = voiceId.startsWith('gemini-')
          ? voiceId.replace('gemini-', '')
          : globalCfg.geminiTtsVoice || 'Kore';
        const ok = await synthesizeWithGeminiTts({
          text: cleanText,
          outputMp3Path: rawPath,
          voiceName: geminiVoice,
          styleHint,
        });
        if (ok && fs.existsSync(rawPath)) {
          await applyAtempoIfNeeded(rawPath, outputPath, speedMultiplier);
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
            const meta = await getVideoMetadata(outputPath);
            if (meta.duration > 0.2) {
              return {
                outputPath,
                duration: meta.duration,
                providerUsed: 'gemini',
                isFallback: preferredProvider !== 'gemini',
              };
            }
          }
        }
      } catch (err: any) {
        errors.push(`Gemini TTS: ${err.message}`);
        try {
          if (fs.existsSync(rawPath) && rawPath !== outputPath) fs.unlinkSync(rawPath);
        } catch {}
      }
    }
  }

  throw new Error(`မြန်မာ AI အသံထုတ်လုပ်မှု မအောင်မြင်ပါ: ${errors.join(' | ')}`);
}

/**
 * Generate a quick voice sample for preview with selected provider and speaking speed
 */
export async function generateVoicePreview(
  voiceId: string,
  rate = '1.00x',
  outputPath: string,
  sampleText?: string,
  provider?: TtsProviderType
): Promise<string> {
  const voice = BURMESE_VOICES.find((v) => v.id === voiceId) || BURMESE_VOICES[0];
  await synthesizeBurmeseTts({
    text: sampleText || voice.sampleText,
    outputPath,
    voiceId: voice.id,
    provider: provider || voice.provider,
    rate,
    segmentIndex: 1,
    lockVoice: voice.provider === 'edge' && (!provider || provider === 'edge'),
  });
  return outputPath;
}

/**
 * Generate complete Burmese narration audio from script segments,
 * concatenate audio, and produce synchronized Burmese SRT & ASS subtitles.
 */
export async function generateBurmeseNarration(params: {
  segments: NarrationSegment[];
  voiceId: string;
  provider?: TtsProviderType;
  rate?: string;
  outputDir: string;
  videoWidth?: number;
  videoHeight?: number;
  subtitleStyle?: Partial<SubtitleStyleConfig>;
  signal?: AbortSignal;
}): Promise<{
  audioPath: string;
  srtPath: string;
  assPath: string;
  totalDuration: number;
  cues: SubtitleCue[];
  providerUsed: TtsProviderType;
}> {
  const {
    segments,
    voiceId,
    provider,
    rate = '1.00x',
    outputDir,
    videoWidth = 1280,
    videoHeight = 720,
    subtitleStyle,
    signal,
  } = params;
  const speedMultiplier = parseSpeedMultiplier(rate);
  const speedSuffix = Math.round(speedMultiplier * 100);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const segmentAudioDir = path.join(outputDir, 'narration_segments');
  if (!fs.existsSync(segmentAudioDir)) {
    fs.mkdirSync(segmentAudioDir, { recursive: true });
  }

  const generatedAudioFiles: string[] = [];
  const subtitleCues: SubtitleCue[] = [];
  let currentTime = 0.5;
  let skipEdgeForBatch = false;
  let lastProviderUsed: TtsProviderType = provider || 'edge';

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new Error('JOB_CANCELLED');

    const seg = segments[i];
    const segAudioFile = path.join(
      segmentAudioDir,
      `seg_${String(i + 1).padStart(3, '0')}_${speedSuffix}.mp3`
    );

    const cleanText = seg.text.trim();
    if (!cleanText) continue;

    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, skipEdgeForBatch ? 250 : 700));
    }

    const { duration: segmentDuration, providerUsed, isFallback } = await synthesizeBurmeseTts({
      text: cleanText,
      outputPath: segAudioFile,
      voiceId,
      provider,
      rate,
      segmentIndex: i + 1,
      skipEdgeTts: skipEdgeForBatch,
    });

    lastProviderUsed = providerUsed;
    if (isFallback && providerUsed !== 'edge') {
      skipEdgeForBatch = true;
    }

    generatedAudioFiles.push(segAudioFile);

    const startTime = currentTime;
    const endTime = currentTime + segmentDuration;

    const brokenText = breakBurmeseLines(cleanText, 45);
    subtitleCues.push({
      id: subtitleCues.length + 1,
      startTime,
      endTime,
      text: brokenText,
    });

    const pauseDuration = Math.max(0.12, Math.min(0.35, 0.35 / speedMultiplier));
    currentTime = endTime + pauseDuration;
  }

  if (generatedAudioFiles.length === 0) {
    throw new Error('ဇာတ်ညွှန်း စာသား အပိုင်းများ မရှိပါ');
  }

  const finalAudioPath = path.join(outputDir, 'narration.mp3');
  const concatListPath = path.join(segmentAudioDir, 'concat_list.txt');

  const fileEntries = generatedAudioFiles
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, fileEntries, 'utf8');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-acodec',
    'libmp3lame',
    '-b:a',
    '192k',
    finalAudioPath,
  ]);

  const srtContent = generateSrtContent(subtitleCues);
  const srtPath = path.join(outputDir, 'subtitles.srt');
  fs.writeFileSync(srtPath, srtContent, 'utf8');

  const assContent = generateAssContent(subtitleCues, videoWidth, videoHeight, subtitleStyle);
  const assPath = path.join(outputDir, 'subtitles.ass');
  fs.writeFileSync(assPath, assContent, 'utf8');

  return {
    audioPath: finalAudioPath,
    srtPath,
    assPath,
    totalDuration: currentTime,
    cues: subtitleCues,
    providerUsed: lastProviderUsed,
  };
}

export interface DubbingTimelineTtsItem {
  id: number;
  kind: 'speaking' | 'silence';
  start: number;
  end: number;
  audioPath?: string;
  ttsDuration?: number;
  burmeseText: string;
}

/**
 * Generate Gemini TTS audio ONLY for speaking segments (skipping silence segments completely).
 * Returns chronological speaking + silence timeline items for silence-preserving video assembly.
 */
export async function generateBurmeseDubbingSegmentClips(params: {
  segments: DialogueTranslationSegment[];
  voiceId: string;
  rate?: string;
  outputDir: string;
  signal?: AbortSignal;
}): Promise<{
  timelineItems: DubbingTimelineTtsItem[];
  providerUsed: TtsProviderType;
  voiceUsed: DubbingVoiceOption['id'];
}> {
  const { segments, voiceId, rate = '1.00x', outputDir, signal } = params;

  const globalCfg = getProviderConfig();
  const globalVoiceId = validateDubbingVoiceId(voiceId, globalCfg.dubbingDefaultVoice);
  const voiceSlug = globalVoiceId.replace(/[^a-zA-Z0-9]/g, '');
  const speedMultiplier = parseSpeedMultiplier(rate);
  const speedSuffix = Math.round(speedMultiplier * 100);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const dubbingAudioDir = path.join(outputDir, 'dubbing_segments');
  if (!fs.existsSync(dubbingAudioDir)) {
    fs.mkdirSync(dubbingAudioDir, { recursive: true });
  }

  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const timelineItems: DubbingTimelineTtsItem[] = [];
  let lastProviderUsed: TtsProviderType = 'gemini';
  let speakingCounter = 0;

  for (let i = 0; i < ordered.length; i++) {
    if (signal?.aborted) throw new Error('JOB_CANCELLED');

    const seg = ordered[i];
    const cleanText = (seg.burmeseText || '').trim();
    const isSilence = seg.kind === 'silence' || !cleanText;

    if (isSilence) {
      // Strictly keep silence empty — NO AI voice generated in silence!
      timelineItems.push({
        id: seg.id || i + 1,
        kind: 'silence',
        start: seg.start,
        end: seg.end,
        burmeseText: '',
      });
      continue;
    }

    speakingCounter++;
    const textHash = crypto.createHash('sha1').update(cleanText).digest('hex').slice(0, 8);
    const segAudioFile = path.join(
      dubbingAudioDir,
      `dub_${String(speakingCounter).padStart(3, '0')}_${voiceSlug}_${speedSuffix}_${textHash}.mp3`
    );

    const { duration: segDuration, providerUsed } = await synthesizeBurmeseTts({
      text: cleanText,
      outputPath: segAudioFile,
      voiceId: globalVoiceId,
      provider: 'gemini',
      rate,
      segmentIndex: speakingCounter,
      skipEdgeTts: false,
      lockVoice: true,
      styleHint: seg.emotion ? `${seg.emotion} Burmese movie dialogue` : undefined,
    });

    lastProviderUsed = providerUsed;
    timelineItems.push({
      id: seg.id || i + 1,
      kind: 'speaking',
      start: seg.start,
      end: seg.end,
      audioPath: segAudioFile,
      ttsDuration: Math.round(segDuration * 1000) / 1000,
      burmeseText: cleanText,
    });

    if (i < ordered.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return {
    timelineItems,
    providerUsed: lastProviderUsed,
    voiceUsed: globalVoiceId,
  };
}

/**
 * Generate sentence-by-sentence Burmese Dubbing Audio using ONE global selected
 * Gemini TTS voice across every speaking segment (legacy audio-concat helper).
 */
export async function generateBurmeseDubbingAudio(params: {
  segments: DialogueTranslationSegment[];
  voiceId: string;
  provider?: TtsProviderType;
  rate?: string;
  videoDuration: number;
  outputDir: string;
  videoWidth?: number;
  videoHeight?: number;
  subtitleStyle?: Partial<SubtitleStyleConfig>;
  signal?: AbortSignal;
}): Promise<{
  audioPath: string;
  srtPath: string;
  assPath: string;
  totalDuration: number;
  cues: SubtitleCue[];
  providerUsed: TtsProviderType;
  voiceUsed: DubbingVoiceOption['id'];
}> {
  const {
    segments,
    voiceId,
    rate = '1.00x',
    videoDuration,
    outputDir,
    videoWidth = 1280,
    videoHeight = 720,
    subtitleStyle,
    signal,
  } = params;

  const globalCfg = getProviderConfig();
  const globalVoiceId = validateDubbingVoiceId(
    voiceId,
    globalCfg.dubbingDefaultVoice
  );
  const voiceSlug = globalVoiceId.replace(/[^a-zA-Z0-9]/g, '');
  const speedMultiplier = parseSpeedMultiplier(rate);
  const speedSuffix = Math.round(speedMultiplier * 100);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const dubbingAudioDir = path.join(outputDir, 'dubbing_segments');
  if (!fs.existsSync(dubbingAudioDir)) {
    fs.mkdirSync(dubbingAudioDir, { recursive: true });
  }

  const sortedSegments = [...segments].sort((a, b) => a.start - b.start);

  const audioPartsList: string[] = [];
  const subtitleCues: SubtitleCue[] = [];
  let cursorTime = 0.0;
  let lastProviderUsed: TtsProviderType = 'gemini';

  for (let i = 0; i < sortedSegments.length; i++) {
    if (signal?.aborted) throw new Error('JOB_CANCELLED');

    const seg = sortedSegments[i];
    const cleanText = (seg.burmeseText || '').trim();
    if (seg.kind === 'silence' || !cleanText) continue;

    // Single global voice enforced for every character and every speaking segment
    const textHash = crypto.createHash('sha1').update(cleanText).digest('hex').slice(0, 8);
    const segAudioFile = path.join(
      dubbingAudioDir,
      `dub_${String(i + 1).padStart(3, '0')}_${voiceSlug}_${speedSuffix}_${textHash}.mp3`
    );

    const { duration: segDuration, providerUsed } = await synthesizeBurmeseTts({
      text: cleanText,
      outputPath: segAudioFile,
      voiceId: globalVoiceId,
      provider: 'gemini',
      rate,
      segmentIndex: i + 1,
      skipEdgeTts: false,
      lockVoice: true,
      styleHint: seg.emotion ? `${seg.emotion} Burmese movie dialogue` : undefined,
    });

    lastProviderUsed = providerUsed;

    const targetStart = Math.max(cursorTime, seg.start);

    if (targetStart > cursorTime + 0.05) {
      const silenceDuration = Math.round((targetStart - cursorTime) * 100) / 100;
      const silenceFile = path.join(dubbingAudioDir, `sil_${String(i + 1).padStart(3, '0')}.mp3`);
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=24000:cl=mono',
        '-t',
        String(silenceDuration),
        '-acodec',
        'libmp3lame',
        '-b:a',
        '128k',
        silenceFile,
      ]);
      audioPartsList.push(silenceFile);
      cursorTime += silenceDuration;
    }

    audioPartsList.push(segAudioFile);
    const speechStartTime = cursorTime;
    const speechEndTime = cursorTime + segDuration;
    cursorTime = speechEndTime;

    const brokenText = breakBurmeseLines(cleanText, 45);
    subtitleCues.push({
      id: subtitleCues.length + 1,
      startTime: speechStartTime,
      endTime: speechEndTime,
      text: brokenText,
    });

    if (i < sortedSegments.length - 1) {
      await new Promise((r) => setTimeout(r, 450));
    }
  }

  if (videoDuration > cursorTime + 0.1) {
    const trailingSilenceDuration = Math.round((videoDuration - cursorTime) * 100) / 100;
    const trailingSilenceFile = path.join(dubbingAudioDir, 'sil_trailing.mp3');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=24000:cl=mono',
      '-t',
      String(trailingSilenceDuration),
      '-acodec',
      'libmp3lame',
      '-b:a',
      '128k',
      trailingSilenceFile,
    ]);
    audioPartsList.push(trailingSilenceFile);
    cursorTime += trailingSilenceDuration;
  }

  const finalAudioPath = path.join(outputDir, 'dubbing.mp3');
  const concatListPath = path.join(dubbingAudioDir, 'concat_list.txt');

  const fileEntries = audioPartsList
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, fileEntries, 'utf8');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-acodec',
    'libmp3lame',
    '-b:a',
    '192k',
    finalAudioPath,
  ]);

  const srtContent = generateSrtContent(subtitleCues);
  const srtPath = path.join(outputDir, 'subtitles.srt');
  fs.writeFileSync(srtPath, srtContent, 'utf8');

  const assContent = generateAssContent(subtitleCues, videoWidth, videoHeight, subtitleStyle);
  const assPath = path.join(outputDir, 'subtitles.ass');
  fs.writeFileSync(assPath, assContent, 'utf8');

  return {
    audioPath: finalAudioPath,
    srtPath,
    assPath,
    totalDuration: cursorTime,
    cues: subtitleCues,
    providerUsed: lastProviderUsed,
    voiceUsed: globalVoiceId,
  };
}
