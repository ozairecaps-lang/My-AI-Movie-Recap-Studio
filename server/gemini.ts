import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import {
  ProjectRecapScript,
  OcrDetection,
  SpeechSegment,
  DialogueTranslationSegment,
  RecapNarrationStyle,
  AutoBlurRegion,
} from './types';
import {
  normalizeAutoBlurRegions,
  RawAutoBlurDetectionInput,
} from '../src/utils/autoBlur';

const execFileAsync = util.promisify(execFile);

// Shared Gemini instance with required aistudio-build User-Agent
export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY ဆာဗာတွင် မရှိသေးပါ (Server environment missing GEMINI_API_KEY)');
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Transcribe Chinese audio using Gemini 3.5 Transcribe when Groq is unavailable or unconfigured.
 */
export async function transcribeChineseAudioWithGemini(
  audioPath: string,
  durationSeconds = 30
): Promise<{ segments: SpeechSegment[]; text: string; provider: 'gemini' }> {
  const ai = getGeminiClient();
  if (!fs.existsSync(audioPath)) {
    throw new Error(`အသံဖိုင် ရှာမတွေ့ပါ: ${audioPath}`);
  }

  const audioBuffer = fs.readFileSync(audioPath);
  const base64Audio = audioBuffer.toString('base64');
  const ext = path.extname(audioPath).toLowerCase();
  const mimeType =
    ext === '.wav'
      ? 'audio/wav'
      : ext === '.webm'
      ? 'audio/webm'
      : ext === '.m4a'
      ? 'audio/mp4'
      : 'audio/mp3';

  // Step 1: Try gemini-3.5-transcribe for raw transcription
  try {
    const transcribeResp = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio,
            },
          },
          {
            text: 'Transcribe all Mandarin Chinese speech accurately in Simplified Chinese characters. Do not invent dialogue if silent.',
          },
        ],
      },
    });

    const rawTranscript = (transcribeResp.text || '').trim();
    if (rawTranscript) {
      // Align or split into chronological segments using gemini-4-hydrogen
      try {
        const segResp = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: { mimeType, data: base64Audio },
              },
              {
                text: `Total audio duration is ${Math.max(1, durationSeconds).toFixed(2)}s.
Reference transcript:
${rawTranscript}

Return a chronological JSON array of spoken sentence segments with accurate start/end times in seconds:
[{ "id": number, "start": number, "end": number, "text": string }]`,
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.INTEGER },
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                },
                required: ['id', 'start', 'end', 'text'],
              },
            },
          },
        });

        const parsed = JSON.parse(segResp.text ?? '[]');
        if (Array.isArray(parsed) && parsed.length > 0) {
          return {
            segments: parsed.map((s: any, idx: number) => ({
              id: idx + 1,
              start: Math.max(0, Number(s.start) || 0),
              end: Math.max(Number(s.start || 0) + 0.5, Number(s.end) || durationSeconds),
              text: String(s.text || '').trim(),
            })),
            text: rawTranscript,
            provider: 'gemini',
          };
        }
      } catch {
        // Return single segment from raw transcript if alignment failed
      }

      const lines = rawTranscript
        .split(/(?<=[。！？\n])/)
        .map((l) => l.trim())
        .filter(Boolean);
      const step = Math.max(1.5, durationSeconds / Math.max(1, lines.length));
      return {
        segments: lines.map((line, i) => ({
          id: i + 1,
          start: Math.round(i * step * 100) / 100,
          end: Math.round(Math.min(durationSeconds, (i + 1) * step) * 100) / 100,
          text: line,
        })),
        text: rawTranscript,
        provider: 'gemini',
      };
    }
  } catch (err: any) {
    // Fallback to multimodal gemini-4-hydrogen directly
    const resp = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          {
            text: `Listen to this audio (duration ${durationSeconds.toFixed(1)}s) and extract any Mandarin Chinese speech with timestamps in seconds.
If there is no speech, return [].
Return JSON array: [{ "id": number, "start": number, "end": number, "text": string }]`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.INTEGER },
              start: { type: Type.NUMBER },
              end: { type: Type.NUMBER },
              text: { type: Type.STRING },
            },
            required: ['id', 'start', 'end', 'text'],
          },
        },
      },
    });

    const parsed = JSON.parse(resp.text ?? '[]');
    if (Array.isArray(parsed)) {
      const clean = parsed
        .filter((s: any) => String(s.text || '').trim().length > 0)
        .map((s: any, idx: number) => ({
          id: idx + 1,
          start: Math.max(0, Number(s.start) || 0),
          end: Math.max(Number(s.start || 0) + 0.5, Number(s.end) || durationSeconds),
          text: String(s.text).trim(),
        }));
      return {
        segments: clean,
        text: clean.map((s) => s.text).join(' '),
        provider: 'gemini',
      };
    }
    throw new Error(`Gemini ဖြင့် အသံမှတ်သားခြင်း မအောင်မြင်ပါ: ${err.message}`);
  }

  return { segments: [], text: '', provider: 'gemini' };
}

function isQuotaOrAuthError(err: any): boolean {
  const msg = String(err?.message || '');
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('API_KEY_INVALID')
  );
}

/**
 * Recognize Chinese subtitles and visible on-screen text from extracted video frames
 */
export async function extractOcrFromFrames(
  framesDir: string,
  intervalSeconds: number
): Promise<OcrDetection[]> {
  const ai = getGeminiClient();
  const detections: OcrDetection[] = [];

  if (!fs.existsSync(framesDir)) {
    return detections;
  }

  const files = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort();

  if (files.length === 0) {
    return detections;
  }

  const batchSize = 4;
  const ocrModels = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
  let quotaError: any = null;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const parts: any[] = [];
    const frameTimestamps: number[] = [];

    for (const file of batch) {
      const match = file.match(/frame_(\d+)/);
      const frameIndex = match ? parseInt(match[1], 10) : i + 1;
      const timestamp = Math.max(0, (frameIndex - 1) * intervalSeconds);
      frameTimestamps.push(timestamp);

      const filePath = path.join(framesDir, file);
      const data = fs.readFileSync(filePath).toString('base64');
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data,
        },
      });
    }

    parts.push({
      text: `You are an expert at reading Chinese video subtitles and on-screen scene text.
For each attached frame in order (Frames: ${frameTimestamps.map((t) => t + 's').join(', ')}):
1. Detect any hardcoded Chinese subtitles (dialogue or narration).
2. Detect visible on-screen Chinese text (scene location, character names, dates, signs).
3. If no Chinese text appears in a frame, omit it or leave chineseText empty. Do NOT invent text.

Return a JSON array:
[{ "frameIndex": number, "chineseText": string }]`,
    });

    let batchSucceeded = false;
    for (const modelName of ocrModels) {
      try {
        const generatePromise = ai.models.generateContent({
          model: modelName,
          contents: parts,
          config: {
            responseMimeType: 'application/json',
          },
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OCR Timeout after 15s')), 15000)
        );

        const response: any = await Promise.race([generatePromise, timeoutPromise]);
        const rawText = (response?.text ?? '[]').trim();
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJson);

        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const text = (item.chineseText || item.text || '').trim();
            if (text) {
              const frameIdx = Math.max(1, Math.min(batch.length, item.frameIndex || 1));
              const ts = frameTimestamps[frameIdx - 1] ?? 0;
              detections.push({
                timestamp: ts,
                chineseText: text,
              });
            }
          }
        }
        batchSucceeded = true;
        break;
      } catch (err: any) {
        if (isQuotaOrAuthError(err)) {
          quotaError = err;
        }
      }
    }

    if (!batchSucceeded && quotaError && detections.length === 0) {
      throw quotaError;
    }
  }

  return detections;
}

/**
 * Automatically detect existing text, logos, watermarks, and fixed graphic overlays
 * from representative video frames using Gemini multimodal vision with normalized [0..1] bounding boxes.
 */
export async function detectOverlayRegionsFromFrames(
  framesDir: string,
  intervalSeconds: number,
  videoDuration: number
): Promise<AutoBlurRegion[]> {
  if (!fs.existsSync(framesDir)) return [];

  const allFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort();

  if (allFiles.length === 0) return [];

  const ai = getGeminiClient();
  // Pick up to 4 evenly spaced frames across the video for fast vision detection
  const maxSamples = 4;
  const step = Math.max(1, Math.floor(allFiles.length / maxSamples));
  const sampled: Array<{ file: string; timestamp: number }> = [];
  for (let i = 0; i < allFiles.length && sampled.length < maxSamples; i += step) {
    const file = allFiles[i];
    const match = file.match(/frame_(\d+)/);
    const frameIndex = match ? parseInt(match[1], 10) : i + 1;
    const timestamp = Math.max(0, (frameIndex - 1) * intervalSeconds);
    sampled.push({ file, timestamp });
  }

  const parts: any[] = [];
  for (const item of sampled) {
    const data = fs.readFileSync(path.join(framesDir, item.file)).toString('base64');
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data,
      },
    });
  }

  parts.push({
    text: `You are a video post-production vision detector.
Inspect these ${sampled.length} frames in chronological order (timestamps: ${sampled
      .map((s) => `${s.timestamp.toFixed(1)}s`)
      .join(', ')}).
Detect ALL existing burned-in overlays inside the video frame:
1. "text": hardcoded subtitles, caption bars, title cards, floating Chinese/English text
2. "logo": TV station / network / app logos or corner channel badges
3. "watermark": platform watermarks (Douyin, TikTok, Kuaishou, Bilibili, @handles, IDs)
4. "graphic": fixed graphic frames, sticker overlays, top/bottom decorative banners

Return precise normalized bounding boxes where x, y, width, height are decimals in [0.0, 1.0] (top-left origin, relative to image width and height):
- x: left edge (0.0 to 1.0)
- y: top edge (0.0 to 1.0)
- width: box width (0.0 to 1.0)
- height: box height (0.0 to 1.0)
- isStatic: true if the element stays fixed across frames (logos, watermarks, persistent banners/captions), false if temporary
- frameIndex: 1-based index of the attached frame where it appears (1 to ${sampled.length})

If there are no overlays/text/logos/watermarks in any frame, return an empty array []. Do NOT invent boxes over clean faces or scenery.`,
  });

  const models = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen'];
  let lastError: any = null;

  for (const modelName of models) {
    try {
      const generatePromise = ai.models.generateContent({
        model: modelName,
        contents: parts,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING },
                frameIndex: { type: Type.INTEGER },
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                width: { type: Type.NUMBER },
                height: { type: Type.NUMBER },
                isStatic: { type: Type.BOOLEAN },
                label: { type: Type.STRING },
                confidence: { type: Type.NUMBER },
              },
              required: ['kind', 'x', 'y', 'width', 'height', 'isStatic'],
            },
          },
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AutoBlur detection timeout on ${modelName} after 15s`)), 15000)
      );

      const resp: any = await Promise.race([generatePromise, timeoutPromise]);
      const parsed = JSON.parse(resp.text ?? '[]');
      if (!Array.isArray(parsed)) return [];

      const safeInterval = Math.max(1.5, intervalSeconds);
      const rawInputs: RawAutoBlurDetectionInput[] = parsed.map((item: any) => {
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
          confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
        };
      });

      return normalizeAutoBlurRegions(rawInputs, videoDuration);
    } catch (err: any) {
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

/**
 * Generate a comprehensive Burmese Movie Recap script analyzing scenes, characters, and story chronologically
 */
export async function generateBurmeseRecapScript(params: {
  chineseTimelineContext: string;
  recapLength: 'short' | 'medium' | 'long';
  narrationStyle?: RecapNarrationStyle;
  videoDuration: number;
  framesDir?: string;
}): Promise<ProjectRecapScript> {
  const ai = getGeminiClient();

  const lengthInstructions = {
    short: 'Short recap (တိုတိုတုတ်တုတ်): 4 to 6 narration segments focusing on core premise and quick resolution.',
    medium: 'Medium recap (အလယ်အလတ်): 7 to 11 narration segments with clear plot progression, character actions, and climax.',
    long: 'Long recap (အသေးစိတ် ပြည့်စုံသော): 12 to 18 narration segments detailing character motivations, twists, tension, and resolution.',
  }[params.recapLength];

  const styleInstructions: Record<RecapNarrationStyle, string> = {
    dramatic: 'Dramatic Cinematic Storyteller (ဒရမ်မာဆန်ဆန် စိတ်လှုပ်ရှားဖွယ်) — engaging hooks, emotional pacing, vivid verbs.',
    informative: 'Clear Documentary & Plot Analyst (ရှင်းလင်းပြတ်သားသော ဇာတ်ကြောင်းသုံးသပ်ချက်) — clear cause-and-effect, logical timeline.',
    suspense: 'Suspense & Thriller Narrator (သည်းထိတ်ရင်ဖို ဆွဲဆောင်မှု) — build mystery, highlight clues and sudden turns.',
    casual: 'Friendly Conversational Creator (ပေါ့ပေါ့ပါးပါး မိတ်ဆွေစကားပြော) — warm, natural spoken Burmese for social viewers.',
  };

  const selectedStyle = params.narrationStyle || 'dramatic';

  const systemInstruction = `You are a master Chinese movie recap creator and storyteller for Burmese audiences.
Your job is to analyze Chinese movie dialogue, subtitles, visual scenes, and story events chronologically, then write a natural and captivating movie recap narration script in standard Myanmar Unicode (မြန်မာယူနီကုဒ်).

IMPORTANT RULES:
1. Write 100% natural, fluent Myanmar Unicode (သဘာဝကျကျ ဆွဲဆောင်မှုရှိသော မြန်မာစကားပြော ဇာတ်ကြောင်းပြန်ပြချက်).
2. Faithfully reflect what occurs in the source material without inventing unrelated plots.
3. Keep character names transliterated phonetically into Myanmar script (e.g. လီရှောင်၊ ကျန်းဝေ၊ ချန်းယွမ်).
4. Narration style: ${styleInstructions[selectedStyle]}
5. Target recap format: ${lengthInstructions}`;

  // Attach up to 4 keyframes if available for genuine multimodal scene analysis
  const parts: any[] = [];
  if (params.framesDir && fs.existsSync(params.framesDir)) {
    const frameFiles = fs
      .readdirSync(params.framesDir)
      .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
      .sort();
    const step = Math.max(1, Math.floor(frameFiles.length / 4));
    for (let idx = 0; idx < frameFiles.length && parts.length < 4; idx += step) {
      const data = fs.readFileSync(path.join(params.framesDir, frameFiles[idx])).toString('base64');
      parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
    }
  }

  parts.push({
    text: `Chronological Chinese speech transcript & on-screen text (Total video duration: ${Math.round(
      params.videoDuration
    )}s):

${params.chineseTimelineContext || '(No spoken lines detected; analyze the attached scene keyframes visually in chronological order)'}

Generate a complete structured Burmese Movie Recap JSON:
- title: Burmese movie recap title
- genre: Genre in Burmese
- charactersSummary: Key characters [{ name, role, description }] in Burmese
- scenesSummary: Key chronological scenes [{ timeRange, description }] in Burmese
- synopsis: Comprehensive story synopsis in Burmese
- narrationSegments: Sequential voice-over paragraphs [{ id, text }] in Myanmar Unicode.`,
  });

  const modelsToTry = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: parts,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                genre: { type: Type.STRING },
                charactersSummary: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      role: { type: Type.STRING },
                      description: { type: Type.STRING },
                    },
                    required: ['name', 'role', 'description'],
                  },
                },
                scenesSummary: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      timeRange: { type: Type.STRING },
                      description: { type: Type.STRING },
                    },
                    required: ['timeRange', 'description'],
                  },
                },
                synopsis: { type: Type.STRING },
                narrationSegments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.INTEGER },
                      text: { type: Type.STRING },
                    },
                    required: ['id', 'text'],
                  },
                },
              },
              required: [
                'title',
                'genre',
                'charactersSummary',
                'scenesSummary',
                'synopsis',
                'narrationSegments',
              ],
            },
          },
        });

        const parsed = JSON.parse(response.text ?? '{}');
        if (!Array.isArray(parsed.narrationSegments) || parsed.narrationSegments.length === 0) {
          throw new Error('Gemini returned empty narration segments');
        }

        return {
          title: parsed.title || 'တရုတ်ရုပ်ရှင် ဇာတ်ကားရှင်းပြချက်',
          genre: parsed.genre || 'ဒရမ်မာ',
          narrationStyle: selectedStyle,
          charactersSummary: parsed.charactersSummary || [],
          scenesSummary: parsed.scenesSummary || [],
          synopsis: parsed.synopsis || '',
          narrationSegments: parsed.narrationSegments,
          approved: false,
        };
      } catch (err: any) {
        lastError = err;
        if (isQuotaOrAuthError(err)) {
          break;
        }
        const isTransient = err.message?.includes('503') || err.message?.includes('high demand');
        if (isTransient) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
        } else {
          break;
        }
      }
    }
  }

  throw new Error(
    `Gemini AI ဖြင့် ဇာတ်ညွှန်း ဖန်တီးခြင်း မအောင်မြင်ပါ: ${lastError?.message || 'Unknown Gemini error'}`
  );
}

/**
 * Translate original Chinese dialogue sentence-by-sentence into natural Burmese,
 * preserving chronological order, emotional context, and character speaker tags.
 */
export async function translateChineseDialogueSegments(
  speechSegments: SpeechSegment[],
  ocrDetections: OcrDetection[]
): Promise<DialogueTranslationSegment[]> {
  const ai = getGeminiClient();

  const rawList: Array<{ id: number; start: number; end: number; chineseText: string }> = [];

  if (speechSegments && speechSegments.length > 0) {
    speechSegments.forEach((seg, idx) => {
      const text = (seg.text || '').trim();
      if (text) {
        rawList.push({
          id: idx + 1,
          start: typeof seg.start === 'number' ? seg.start : 0,
          end: typeof seg.end === 'number' ? seg.end : (seg.start || 0) + 3,
          chineseText: text,
        });
      }
    });
  }

  if (rawList.length === 0 && ocrDetections && ocrDetections.length > 0) {
    ocrDetections.forEach((det, idx) => {
      const text = (det.chineseText || '').trim();
      if (text) {
        const start = det.timestamp;
        const end = start + 3.0;
        rawList.push({
          id: idx + 1,
          start,
          end,
          chineseText: text,
        });
      }
    });
  }

  if (rawList.length === 0) {
    throw new Error(
      'ဗီဒီယိုထဲတွင် တရုတ်စကားပြော သို့မဟုတ် တရုတ်စာတန်း ရှာမတွေ့ပါ (No Chinese speech or subtitle text detected to translate)'
    );
  }

  const prompt = `You are an expert Chinese-to-Burmese movie dialogue translator and dubbing director.
Translate the following Chinese dialogue segments sentence-by-sentence into natural, spoken Myanmar Unicode (မြန်မာယူနီကုဒ်).
RULES:
1. Translate accurately sentence-by-sentence. Do NOT summarize or turn it into a recap.
2. Preserve exact chronological order and timestamps.
3. Identify distinct recurring speakers consistently in Burmese (e.g., "ဇာတ်ကောင် ၁ (မ)" for Speaker 1 Female, "ဇာတ်ကောင် ၂ (ကျား)" for Speaker 2 Male, or actual character name if clear).
4. Tag emotional tone briefly in Burmese (e.g., "တည်ငြိမ်", "စိတ်လှုပ်ရှား", "ဒေါသ", "ဝမ်းနည်း").

Input Chinese dialogue segments:
${JSON.stringify(rawList, null, 2)}

Return JSON array:
[{ "id": number, "start": number, "end": number, "chineseText": string, "burmeseText": string, "speaker": string, "emotion": string }]`;

  const modelsToTry = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.INTEGER },
                start: { type: Type.NUMBER },
                end: { type: Type.NUMBER },
                chineseText: { type: Type.STRING },
                burmeseText: { type: Type.STRING },
                speaker: { type: Type.STRING },
                emotion: { type: Type.STRING },
              },
              required: ['id', 'start', 'end', 'chineseText', 'burmeseText', 'speaker', 'emotion'],
            },
          },
        },
      });

      const parsed = JSON.parse(resp.text ?? '[]');
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item: any, idx: number) => ({
          id: idx + 1,
          start: typeof item.start === 'number' ? item.start : rawList[idx]?.start ?? idx * 3,
          end: typeof item.end === 'number' ? item.end : rawList[idx]?.end ?? (idx + 1) * 3,
          chineseText: item.chineseText || rawList[idx]?.chineseText || '',
          burmeseText: (item.burmeseText || '').trim(),
          speaker: (item.speaker || 'ဇာတ်ကောင် ၁').trim(),
          emotion: (item.emotion || 'ပုံမှန်').trim(),
        }));
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  throw new Error(
    `Gemini AI ဖြင့် စကားပြော ဘာသာပြန်ခြင်း မအောင်မြင်ပါ: ${lastError?.message || 'Translation failed'}`
  );
}

/**
 * Synthesize Burmese Speech via Gemini 3.8 TTS (returns WAV converted to MP3 path)
 */
export async function synthesizeWithGeminiTts(params: {
  text: string;
  outputMp3Path: string;
  voiceName?: string;
  styleHint?: string;
}): Promise<boolean> {
  const ai = getGeminiClient();
  const cleanText = params.text.trim();
  if (!cleanText) return false;

  const validVoices = ['Kore', 'Charon', 'Puck', 'Fenrir', 'Zephyr'];
  const normalizedVoice = params.voiceName?.replace(/^gemini-/, '') || 'Kore';
  const prebuiltVoice = validVoices.includes(normalizedVoice) ? normalizedVoice : 'Kore';

  const wavTmpPath = `${params.outputMp3Path}.gemini_${Date.now()}.wav`;

  let lastErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: cleanText,
                speechMetadata: {
                  style: params.styleHint || 'Natural, clear Burmese movie dialogue',
                },
              } as any,
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: prebuiltVoice },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('Gemini TTS returned no audio payload');
      }

      fs.writeFileSync(wavTmpPath, Buffer.from(base64Audio, 'base64'));
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        wavTmpPath,
        '-acodec',
        'libmp3lame',
        '-b:a',
        '192k',
        params.outputMp3Path,
      ]);

      return fs.existsSync(params.outputMp3Path) && fs.statSync(params.outputMp3Path).size > 500;
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || '');
      const retryable = msg.includes('429') || msg.includes('503') || msg.includes('high demand');
      if (retryable && attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      throw err;
    } finally {
      try {
        if (fs.existsSync(wavTmpPath)) fs.unlinkSync(wavTmpPath);
      } catch {}
    }
  }

  throw lastErr || new Error('Gemini TTS failed');
}

