import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';
import {
  SpeechSegment,
  ProjectRecapScript,
  OcrDetection,
  DialogueTranslationSegment,
  RecapNarrationStyle,
  AutoBlurRegion,
} from './types';
import {
  normalizeAutoBlurRegions,
  RawAutoBlurDetectionInput,
} from '../src/utils/autoBlur';
import { deduplicateTranscriptSegments } from '../src/utils/transcript';
import { splitSpeechSegmentsByWordPauses, WordTimestamp, RawWhisperSegment } from '../src/utils/dubbingTimeline';
import { selectGroqVisionCandidates, getGroqVisionMaxImages } from '../src/utils/groqModels';
import { splitAudioFile } from './ffmpeg';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CONFIG_FILE = path.resolve(process.cwd(), 'data', 'groq_config.json');
const SAMPLE_AUDIO_PATH = path.resolve(process.cwd(), 'uploads', 'chinese_test_sample.mp3');

const groqVisionModelsCache = new Map<string, { models: string[]; expiresAt: number }>();

async function resolveGroqVisionModels(groq: Groq, apiKey: string): Promise<string[]> {
  const cacheKey = apiKey.slice(-10);
  const cached = groqVisionModelsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  try {
    const listResp: any = await Promise.race([
      groq.models.list(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Groq models.list timeout')), 5000)
      ),
    ]);
    const ids = Array.isArray(listResp?.data)
      ? listResp.data.map((m: any) => String(m?.id || '')).filter(Boolean)
      : [];
    const selected = selectGroqVisionCandidates(ids);
    groqVisionModelsCache.set(cacheKey, {
      models: selected,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return selected;
  } catch {
    return selectGroqVisionCandidates(null);
  }
}

function isGroqModelNotFoundError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  return err?.status === 404 || msg.includes('model_not_found') || msg.includes('does not exist');
}

/**
 * Retrieve the active Groq API Key from server environment or secure server storage
 */
export function getGroqApiKey(): string | null {
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) {
    return process.env.GROQ_API_KEY.trim();
  }

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data.groqApiKey && typeof data.groqApiKey === 'string' && data.groqApiKey.trim()) {
        return data.groqApiKey.trim();
      }
    } catch {
      // ignore parse error
    }
  }

  return null;
}

/**
 * Securely store Groq API Key on server
 */
export function saveGroqApiKey(key: string): void {
  const trimmed = key.trim();
  process.env.GROQ_API_KEY = trimmed;

  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ groqApiKey: trimmed, updatedAt: new Date().toISOString() }, null, 2)
  );
}

/**
 * Mask API key for secure UI display (never expose raw key)
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '••••••••';
  const prefix = key.slice(0, 4);
  const suffix = key.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

/**
 * Ensure an authentic Chinese test audio sample exists on disk
 */
export async function ensureTestAudio(): Promise<string> {
  if (fs.existsSync(SAMPLE_AUDIO_PATH)) {
    const stats = fs.statSync(SAMPLE_AUDIO_PATH);
    if (stats.size > 1000) {
      return SAMPLE_AUDIO_PATH;
    }
  }

  const uploadsDir = path.dirname(SAMPLE_AUDIO_PATH);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  try {
    const { EdgeTTS } = require('node-edge-tts');
    const tts = new EdgeTTS({ voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN' });
    await tts.ttsPromise('三年过去了，你终于回来了。为了守护这座城市，我们必须联手。', SAMPLE_AUDIO_PATH);
  } catch (err) {
    console.warn('Could not generate sample audio with EdgeTTS:', err);
  }

  return SAMPLE_AUDIO_PATH;
}

/**
 * Test Groq Whisper connection using a real short Chinese audio file
 */
export async function testGroqConnection(providedKey?: string): Promise<{
  success: boolean;
  model: string;
  language: string;
  text: string;
  duration: number;
  segments: SpeechSegment[];
  error?: string;
  status?: number;
}> {
  const apiKey = (providedKey && providedKey.trim()) || getGroqApiKey();

  if (!apiKey) {
    return {
      success: false,
      model: 'whisper-large-v3',
      language: 'zh',
      text: '',
      duration: 0,
      segments: [],
      error: 'GROQ_API_KEY ဆာဗာတွင် မရှိသေးပါ။ ကျေးဇူးပြု၍ Groq API Key (gsk_...) ကို ထည့်သွင်းပေးပါ။',
      status: 401,
    };
  }

  const samplePath = await ensureTestAudio();
  if (!fs.existsSync(samplePath)) {
    return {
      success: false,
      model: 'whisper-large-v3',
      language: 'zh',
      text: '',
      duration: 0,
      segments: [],
      error: 'စမ်းသပ်မည့် တရုတ်အသံဖိုင် (sample audio) ရှာမတွေ့ပါ',
      status: 404,
    };
  }

  try {
    const groq = new Groq({ apiKey });

    const response: any = await groq.audio.transcriptions.create({
      file: fs.createReadStream(samplePath),
      model: 'whisper-large-v3',
      language: 'zh',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    const segments: SpeechSegment[] = [];
    if (response.segments && Array.isArray(response.segments)) {
      for (let i = 0; i < response.segments.length; i++) {
        const seg = response.segments[i];
        segments.push({
          id: i + 1,
          start: Math.round(seg.start * 100) / 100,
          end: Math.round(seg.end * 100) / 100,
          text: (seg.text || '').trim(),
        });
      }
    } else if (response.text) {
      segments.push({
        id: 1,
        start: 0,
        end: response.duration || 6.2,
        text: response.text.trim(),
      });
    }

    return {
      success: true,
      model: 'whisper-large-v3',
      language: 'zh',
      text: response.text || '',
      duration: response.duration || 6.24,
      segments,
    };
  } catch (err: any) {
    console.error('Groq connection test error:', err);
    return {
      success: false,
      model: 'whisper-large-v3',
      language: 'zh',
      text: '',
      duration: 0,
      segments: [],
      error: err.message || 'Groq Whisper API သို့ ချိတ်ဆက်ရာတွင် အမှားဖြစ်ပေါ်ခဲ့သည်',
      status: err.status || 500,
    };
  }
}

/**
 * Transcribe Chinese audio using Groq Whisper Large V3 with chunking support
 */
export async function transcribeChineseAudio(
  audioPath: string,
  customGroqKey?: string
): Promise<{
  segments: SpeechSegment[];
  text: string;
  duration: number;
  provider: 'groq';
  model: 'whisper-large-v3';
}> {
  const apiKey = (customGroqKey && customGroqKey.trim()) || getGroqApiKey();

  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY ဆာဗာတွင် မရှိသေးပါ။ ကျေးဇူးပြု၍ AI Provider Settings တွင် Groq API Key ထည့်သွင်းပေးပါ။'
    );
  }

  const groq = new Groq({ apiKey });

  if (!fs.existsSync(audioPath)) {
    throw new Error(`အသံဖိုင် ရှာမတွေ့ပါ: ${audioPath}`);
  }

  const stats = fs.statSync(audioPath);
  const fileSizeMb = stats.size / (1024 * 1024);

  if (fileSizeMb > 24) {
    const chunkDir = path.join(path.dirname(audioPath), 'audio_chunks');
    const chunks = await splitAudioFile(audioPath, chunkDir, 600, 2);

    const allSegments: RawWhisperSegment[] = [];
    const allWords: WordTimestamp[] = [];
    const textPieces: string[] = [];
    let totalDuration = 0;

    for (const chunk of chunks) {
      const response: any = await groq.audio.transcriptions.create({
        file: fs.createReadStream(chunk.filePath),
        model: 'whisper-large-v3',
        language: 'zh',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment', 'word'],
      });

      if (response && response.text) {
        textPieces.push(response.text.trim());
      }
      if (response && response.duration) {
        totalDuration += response.duration;
      }

      if (response && Array.isArray(response.words)) {
        for (const w of response.words) {
          if (typeof w?.start === 'number' && typeof w?.end === 'number') {
            allWords.push({
              word: String(w.word || ''),
              start: Math.round((w.start + chunk.startTime) * 100) / 100,
              end: Math.round((w.end + chunk.startTime) * 100) / 100,
            });
          }
        }
      }

      if (response && response.segments) {
        for (const seg of response.segments) {
          allSegments.push({
            id: allSegments.length + 1,
            start: Math.round((seg.start + chunk.startTime) * 100) / 100,
            end: Math.round((seg.end + chunk.startTime) * 100) / 100,
            text: (seg.text || '').trim(),
            no_speech_prob: typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : undefined,
          });
        }
      }
    }

    const pauseRefined = splitSpeechSegmentsByWordPauses(allSegments, allWords);
    const deduped = deduplicateTranscriptSegments(pauseRefined);
    return {
      segments: deduped,
      text: textPieces.join(' '),
      duration: totalDuration,
      provider: 'groq',
      model: 'whisper-large-v3',
    };
  } else {
    const response: any = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-large-v3',
      language: 'zh',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word'],
    });

    const words: WordTimestamp[] = Array.isArray(response?.words)
      ? response.words
          .filter((w: any) => typeof w?.start === 'number' && typeof w?.end === 'number')
          .map((w: any) => ({
            word: String(w.word || ''),
            start: Math.round(w.start * 100) / 100,
            end: Math.round(w.end * 100) / 100,
          }))
      : [];

    const segments: RawWhisperSegment[] = [];
    if (response && response.segments && response.segments.length > 0) {
      for (let i = 0; i < response.segments.length; i++) {
        const seg = response.segments[i];
        segments.push({
          id: i + 1,
          start: Math.round(seg.start * 100) / 100,
          end: Math.round(seg.end * 100) / 100,
          text: (seg.text || '').trim(),
          no_speech_prob: typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : undefined,
        });
      }
    } else if (response && response.text) {
      segments.push({
        id: 1,
        start: 0,
        end: response.duration || 10,
        text: response.text.trim(),
      });
    }

    const pauseRefined = splitSpeechSegmentsByWordPauses(segments, words);
    const deduped = deduplicateTranscriptSegments(pauseRefined);
    return {
      segments: deduped,
      text: response.text || '',
      duration: response.duration || 0,
      provider: 'groq',
      model: 'whisper-large-v3',
    };
  }
}

/**
 * Fallback Vision OCR for Chinese on-screen text / hardcoded subtitles via active Groq Vision models
 */
export async function extractOcrWithGroqVision(
  framesDir: string,
  intervalSeconds: number,
  customGroqKey?: string
): Promise<OcrDetection[]> {
  const apiKey = (customGroqKey && customGroqKey.trim()) || getGroqApiKey();
  if (!apiKey || !fs.existsSync(framesDir)) {
    return [];
  }

  const files = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort()
    .slice(0, 6);

  if (files.length === 0) return [];

  const groq = new Groq({ apiKey });
  const visionModels = await resolveGroqVisionModels(groq, apiKey);
  if (visionModels.length === 0) {
    return [];
  }

  const detections: OcrDetection[] = [];

  for (let i = 0; i < files.length; i += 3) {
    const batch = files.slice(i, i + 3);
    const frameTimestamps: number[] = [];
    const contentParts: any[] = [];

    for (const file of batch) {
      const match = file.match(/frame_(\d+)/);
      const frameIndex = match ? parseInt(match[1], 10) : i + 1;
      const ts = Math.max(0, (frameIndex - 1) * intervalSeconds);
      frameTimestamps.push(ts);

      const b64 = fs.readFileSync(path.join(framesDir, file)).toString('base64');
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      });
    }

    contentParts.push({
      type: 'text',
      text: `Read any Chinese subtitles or visible Chinese on-screen text in these ${batch.length} video frames (timestamps: ${frameTimestamps
        .map((t) => `${t}s`)
        .join(', ')}). Return pure JSON object: {"detections": [{"frameIndex": 1, "chineseText": "..."}]}. Leave empty array if no Chinese text is visible.`,
    });

    for (const modelName of visionModels) {
      try {
        const completion = await groq.chat.completions.create({
          model: modelName,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: contentParts }],
          max_tokens: 800,
        });

        const raw = completion.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed.detections) ? parsed.detections : [];
        for (const item of arr) {
          const text = String(item?.chineseText || item?.text || '').trim();
          if (text) {
            const idx = Math.max(1, Math.min(batch.length, Number(item.frameIndex) || 1));
            detections.push({
              timestamp: frameTimestamps[idx - 1] ?? 0,
              chineseText: text,
            });
          }
        }
        break;
      } catch (err: any) {
        if (!isGroqModelNotFoundError(err)) {
          console.warn(`Groq Vision OCR batch error (${modelName}):`, err?.message || err);
        }
      }
    }
  }

  return detections;
}

/**
 * Fallback Vision overlay detector (text, logo, watermark, fixed graphics) via active Groq Vision models
 */
export async function detectOverlayRegionsWithGroqVision(
  framesDir: string,
  intervalSeconds: number,
  videoDuration: number,
  customGroqKey?: string
): Promise<AutoBlurRegion[]> {
  const apiKey = (customGroqKey && customGroqKey.trim()) || getGroqApiKey();
  if (!apiKey || !fs.existsSync(framesDir)) {
    return [];
  }

  const allFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort();

  if (allFiles.length === 0) return [];

  const groq = new Groq({ apiKey });
  const visionModels = await resolveGroqVisionModels(groq, apiKey);
  if (visionModels.length === 0) {
    return [];
  }

  const maxImages = Math.min(3, getGroqVisionMaxImages(visionModels[0]));
  const step = Math.max(1, Math.floor(allFiles.length / maxImages));
  const sampled: Array<{ file: string; timestamp: number }> = [];
  for (let i = 0; i < allFiles.length && sampled.length < maxImages; i += step) {
    const file = allFiles[i];
    const match = file.match(/frame_(\d+)/);
    const frameIndex = match ? parseInt(match[1], 10) : i + 1;
    sampled.push({
      file,
      timestamp: Math.max(0, (frameIndex - 1) * intervalSeconds),
    });
  }

  const contentParts: any[] = sampled.map((item) => ({
    type: 'image_url',
    image_url: {
      url: `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, item.file)).toString('base64')}`,
    },
  }));

  contentParts.push({
    type: 'text',
    text: `Detect existing hardcoded text/subtitles, logos, watermarks, and fixed graphics across these ${sampled.length} frames (timestamps: ${sampled
      .map((s) => `${s.timestamp.toFixed(1)}s`)
      .join(', ')}).
Return pure JSON object:
{"regions":[{"kind":"text"|"logo"|"watermark"|"graphic","frameIndex":1,"x":0.1,"y":0.8,"width":0.8,"height":0.1,"isStatic":true,"label":"..."}]}
All coordinates must be normalized floats in [0.0, 1.0]. Return {"regions":[]} if none exist.`,
  });

  let lastNon404Error: any = null;

  for (const modelName of visionModels) {
    try {
      const completion = await groq.chat.completions.create({
        model: modelName,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: contentParts }],
        max_tokens: 900,
      });

      const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
      const arr = Array.isArray(parsed.regions) ? parsed.regions : [];
      const safeInterval = Math.max(1.5, intervalSeconds);

      const rawInputs: RawAutoBlurDetectionInput[] = arr.map((item: any) => {
        const idx = Math.max(1, Math.min(sampled.length, Number(item.frameIndex) || 1));
        const ts = sampled[idx - 1]?.timestamp ?? 0;
        const isStatic = Boolean(item.isStatic);
        return {
          kind: item.kind,
          x: Number(item.x),
          y: Number(item.y),
          width: Number(item.width),
          height: Number(item.height),
          isStatic,
          startTime: isStatic ? 0 : Math.max(0, ts - safeInterval * 0.6),
          endTime: isStatic ? videoDuration : Math.min(videoDuration, ts + safeInterval * 1.15),
          label: item.label,
        };
      });

      return normalizeAutoBlurRegions(rawInputs, videoDuration);
    } catch (err: any) {
      if (!isGroqModelNotFoundError(err)) {
        lastNon404Error = err;
      }
    }
  }

  if (lastNon404Error) {
    console.warn('Groq Vision overlay detection error:', lastNon404Error?.message || lastNon404Error);
  }
  return [];
}

/**
 * Generate Burmese Movie Recap script using Groq LLM (with Vision keyframe fallback for silent clips)
 */
export async function generateRecapWithGroq(params: {
  chineseTimelineContext: string;
  recapLength: 'short' | 'medium' | 'long';
  narrationStyle?: RecapNarrationStyle;
  videoDuration: number;
  framesDir?: string;
  customGroqKey?: string;
}): Promise<ProjectRecapScript> {
  const apiKey = (params.customGroqKey && params.customGroqKey.trim()) || getGroqApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY မရှိသေးပါ');
  }
  const groq = new Groq({ apiKey });
  const style = params.narrationStyle || 'dramatic';

  const lengthGuidance = {
    short: '4 to 6 narrationSegments focusing on core premise and outcome',
    medium: '7 to 11 narrationSegments with plot progression and climax',
    long: '12 to 18 detailed narrationSegments',
  }[params.recapLength];

  const hasTextContext = Boolean(params.chineseTimelineContext && params.chineseTimelineContext.trim().length > 0);

  const frameImages: string[] = [];
  if (!hasTextContext && params.framesDir && fs.existsSync(params.framesDir)) {
    const frameFiles = fs
      .readdirSync(params.framesDir)
      .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
      .sort();
    const step = Math.max(1, Math.floor(frameFiles.length / 3));
    for (let i = 0; i < frameFiles.length && frameImages.length < 3; i += step) {
      frameImages.push(fs.readFileSync(path.join(params.framesDir, frameFiles[i])).toString('base64'));
    }
  }

  const systemPrompt = `You are a master Chinese movie recap writer for Burmese audiences.
Output pure JSON matching exact schema:
{
  "title": string (Burmese movie recap title),
  "genre": string (Burmese genre),
  "charactersSummary": [{"name": string, "role": string, "description": string}],
  "scenesSummary": [{"timeRange": string, "description": string}],
  "synopsis": string (Burmese synopsis),
  "narrationSegments": [{"id": number, "text": string}]
}
Use 100% fluent, natural Myanmar Unicode (မြန်မာယူနီကုဒ်). Transliterate Chinese names phonetically in Burmese. Narration style: ${style}. Target length: ${lengthGuidance}.`;

  let raw = '{}';
  let generatedViaVision = false;

  if (frameImages.length > 0) {
    const visionModels = await resolveGroqVisionModels(groq, apiKey);
    for (const modelName of visionModels) {
      const cappedImages = frameImages.slice(0, getGroqVisionMaxImages(modelName));
      const userContent: any[] = cappedImages.map((b64) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      }));
      userContent.push({
        type: 'text',
        text: `Video duration: ${Math.round(params.videoDuration)}s. No spoken audio was detected. Analyze these chronological video frames visually and write the complete Burmese recap script JSON.`,
      });

      try {
        const completion = await groq.chat.completions.create({
          model: modelName,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        });
        raw = completion.choices?.[0]?.message?.content || '{}';
        generatedViaVision = true;
        break;
      } catch (err: any) {
        if (!isGroqModelNotFoundError(err)) {
          throw err;
        }
      }
    }
  }

  if (!generatedViaVision) {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Duration: ${Math.round(params.videoDuration)}s\n\nChronological source timeline:\n${
            params.chineseTimelineContext || '(Short dramatic movie clip)'
          }`,
        },
      ],
    });
    raw = completion.choices?.[0]?.message?.content || '{}';
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.narrationSegments) || parsed.narrationSegments.length === 0) {
    throw new Error('Groq LLM returned empty narrationSegments');
  }

  return {
    title: parsed.title || 'တရုတ်ရုပ်ရှင် ဇာတ်ကားရှင်းပြချက်',
    genre: parsed.genre || 'ဒရမ်မာ',
    narrationStyle: style,
    charactersSummary: Array.isArray(parsed.charactersSummary) ? parsed.charactersSummary : [],
    scenesSummary: Array.isArray(parsed.scenesSummary) ? parsed.scenesSummary : [],
    synopsis: parsed.synopsis || '',
    narrationSegments: parsed.narrationSegments.map((seg: any, idx: number) => ({
      id: idx + 1,
      text: String(seg?.text || '').trim(),
    })).filter((s: any) => s.text.length > 0),
    approved: false,
  };
}

/**
 * Translate Chinese dialogue segments into Burmese using Groq LLM
 */
export async function translateDialogueWithGroq(
  speechSegments: SpeechSegment[],
  ocrDetections: OcrDetection[],
  customGroqKey?: string
): Promise<DialogueTranslationSegment[]> {
  const apiKey = (customGroqKey && customGroqKey.trim()) || getGroqApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY မရှိသေးပါ');
  }
  const groq = new Groq({ apiKey });

  const rawList: Array<{ id: number; start: number; end: number; chineseText: string }> = [];
  speechSegments.forEach((seg, idx) => {
    if (seg.text?.trim()) {
      rawList.push({ id: idx + 1, start: seg.start, end: seg.end, chineseText: seg.text.trim() });
    }
  });
  if (rawList.length === 0) {
    ocrDetections.forEach((det, idx) => {
      if (det.chineseText?.trim()) {
        rawList.push({
          id: idx + 1,
          start: det.timestamp,
          end: det.timestamp + 3,
          chineseText: det.chineseText.trim(),
        });
      }
    });
  }
  if (rawList.length === 0) {
    throw new Error('ဘာသာပြန်ရန် တရုတ်စကားပြော ရှာမတွေ့ပါ');
  }

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are an expert Chinese-to-Burmese movie dialogue translator and dubbing director.
Translate EVERY input Chinese segment sentence-by-sentence into natural spoken Myanmar Unicode (မြန်မာယူနီကုဒ်).
Rules:
1. Keep exact 1-to-1 order, timestamps, and segment count. Do not summarize.
2. Identify recurring speakers consistently in Burmese (e.g. "ဇာတ်ကောင် ၁ (မ)", "ဇာတ်ကောင် ၂ (ကျား)").
3. Tag emotional tone briefly in Burmese (e.g. "တည်ငြိမ်", "စိတ်လှုပ်ရှား", "ဒေါသ", "ဝမ်းနည်း").
Return pure JSON object:
{ "segments": [{ "id": number, "start": number, "end": number, "chineseText": string, "burmeseText": string, "speaker": string, "emotion": string }] }`,
      },
      {
        role: 'user',
        content: JSON.stringify(rawList),
      },
    ],
  });

  const parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
  const arr = Array.isArray(parsed.segments) ? parsed.segments : [];
  if (arr.length === 0) {
    throw new Error('Groq translation returned empty segments');
  }

  return rawList.map((src, idx) => {
    const item = arr[idx] || {};
    return {
      id: idx + 1,
      start: typeof item.start === 'number' ? item.start : src.start,
      end: typeof item.end === 'number' ? item.end : src.end,
      chineseText: item.chineseText || src.chineseText,
      burmeseText: (item.burmeseText || '').trim() || src.chineseText,
      speaker: (item.speaker || 'ဇာတ်ကောင် ၁').trim(),
      emotion: (item.emotion || 'ပုံမှန်').trim(),
    };
  });
}
