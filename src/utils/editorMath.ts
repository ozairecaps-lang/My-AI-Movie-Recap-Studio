/**
 * Pure formatting, validation, and mixing helpers for Video Editor, Upload, and Storage tracking.
 */

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB limit

export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm'];

/**
 * Validate uploaded video file size (100 MB limit) and supported container format.
 */
export function validateUploadVideoFile(
  file: { name: string; size: number; type?: string },
  maxBytes = MAX_UPLOAD_BYTES
): { valid: boolean; error?: string } {
  const lower = (file.name || '').toLowerCase();
  const hasSupportedExt = ACCEPTED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const hasVideoMime = Boolean(file.type && file.type.startsWith('video/'));

  if (!hasSupportedExt && !hasVideoMime) {
    return {
      valid: false,
      error: 'ထောက်ပံ့မထားသော ဗီဒီယိုဖိုင်အမျိုးအစား ဖြစ်ပါသည် (MP4, MOV, MKV, WebM သာ လက်ခံပါသည်)',
    };
  }

  if (file.size <= 0) {
    return {
      valid: false,
      error: 'ဗီဒီယိုဖိုင် အရွယ်အစား မမှန်ကန်ပါ (0 bytes)',
    };
  }

  if (file.size > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    const fileMb = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `ဖိုင်အရွယ်အစား (${fileMb} MB) သည် အများဆုံး ကန့်သတ်ချက် ${maxMb} MB ထက် ကျော်လွန်နေပါသည်`,
    };
  }

  return { valid: true };
}

/**
 * Format byte count into crisp human-readable storage string.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, exp);
  return `${val >= 100 || exp === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[exp]}`;
}

/**
 * Format playback timestamp MM:SS.d for video editor timeline.
 */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/**
 * Clamp audio volume gain into safe FFmpeg filter bounds [0.00 .. 1.50].
 */
export function clampAudioGain(value: number, min = 0, max = 1.5): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value * 100) / 100));
}

/**
 * Character voice preset options used for Dubbing character voice assignment.
 */
export interface CharacterVoiceOption {
  id: string;
  label: string;
  gender: 'female' | 'male';
  tone: string;
}

export const CHARACTER_VOICE_OPTIONS: CharacterVoiceOption[] = [
  {
    id: 'my-MM-NilarNeural',
    label: 'နီလာ (မိန်းကလေး - Neural)',
    gender: 'female',
    tone: 'နူးညံ့သိမ်မွေ့သော',
  },
  {
    id: 'my-MM-ThihaNeural',
    label: 'သီဟ (ယောက်ျားလေး - Neural)',
    gender: 'male',
    tone: 'တည်ငြိမ်ပြတ်သားသော',
  },
  {
    id: 'gemini-Kore',
    label: 'Kore (မိန်းကလေး - Gemini Studio)',
    gender: 'female',
    tone: 'ကြည်လင်ပြတ်သားသော',
  },
  {
    id: 'gemini-Charon',
    label: 'Charon (ယောက်ျားလေး - Gemini Studio)',
    gender: 'male',
    tone: 'နက်ရှိုင်းခံ့ညားသော',
  },
  {
    id: 'gemini-Zephyr',
    label: 'Zephyr (လူငယ်အသံ - Gemini Studio)',
    gender: 'female',
    tone: 'သွက်လက်တက်ကြွသော',
  },
  {
    id: 'gemini-Fenrir',
    label: 'Fenrir (စိတ်ခံစားမှုပြင်းထန် - Gemini Studio)',
    gender: 'male',
    tone: 'အားမာန်ပါသော',
  },
];

/**
 * Global Single-Voice Gemini TTS options for Dubbing Mode (all speaking segments use the one selected voice).
 */
export interface DubbingVoiceOption {
  id: 'gemini-Kore' | 'gemini-Charon' | 'gemini-Zephyr' | 'gemini-Fenrir' | 'gemini-Puck';
  label: string;
  englishLabel: string;
  gender: 'female' | 'male';
  description: string;
}

export const DEFAULT_DUBBING_VOICE_ID: DubbingVoiceOption['id'] = 'gemini-Kore';

export const DUBBING_VOICE_OPTIONS: DubbingVoiceOption[] = [
  {
    id: 'gemini-Kore',
    label: 'Gemini Kore (မိန်းကလေးအသံ · Gemini 3.8 TTS)',
    englishLabel: 'Gemini Kore (Female)',
    gender: 'female',
    description: 'ကြည်လင်ပြတ်သားသော Gemini 3.8 TTS မိန်းကလေးအသံ (Default)',
  },
  {
    id: 'gemini-Charon',
    label: 'Gemini Charon (ယောက်ျားလေးအသံ · Gemini 3.8 TTS)',
    englishLabel: 'Gemini Charon (Male)',
    gender: 'male',
    description: 'နက်ရှိုင်းတည်ငြိမ်သော Gemini 3.8 TTS ယောက်ျားလေးအသံ',
  },
  {
    id: 'gemini-Zephyr',
    label: 'Gemini Zephyr (လူငယ်အသံ · Gemini 3.8 TTS)',
    englishLabel: 'Gemini Zephyr (Female)',
    gender: 'female',
    description: 'သွက်လက်တက်ကြွသော Gemini 3.8 TTS အမျိုးသမီးအသံ',
  },
  {
    id: 'gemini-Fenrir',
    label: 'Gemini Fenrir (စိတ်လှုပ်ရှားအသံ · Gemini 3.8 TTS)',
    englishLabel: 'Gemini Fenrir (Male)',
    gender: 'male',
    description: 'အားမာန်ပါသော Gemini 3.8 TTS အမျိုးသားအသံ',
  },
  {
    id: 'gemini-Puck',
    label: 'Gemini Puck (နွေးထွေးအသံ · Gemini 3.8 TTS)',
    englishLabel: 'Gemini Puck (Male)',
    gender: 'male',
    description: 'သဘာဝကျကျ နွေးထွေးသော Gemini 3.8 TTS အသံ',
  },
];

export function isValidDubbingVoiceId(voiceId?: string | null): voiceId is DubbingVoiceOption['id'] {
  return DUBBING_VOICE_OPTIONS.some((v) => v.id === voiceId);
}

export function resolveSingleDubbingVoice(
  voiceId?: string | null,
  fallback: DubbingVoiceOption['id'] = DEFAULT_DUBBING_VOICE_ID
): DubbingVoiceOption['id'] {
  if (isValidDubbingVoiceId(voiceId)) {
    return voiceId;
  }
  if (voiceId === 'my-MM-NilarNeural') return 'gemini-Kore';
  if (voiceId === 'my-MM-ThihaNeural') return 'gemini-Charon';
  return isValidDubbingVoiceId(fallback) ? fallback : DEFAULT_DUBBING_VOICE_ID;
}

export function applySingleDubbingVoiceToSegments<
  T extends { kind?: 'speaking' | 'silence'; voiceId?: string; chineseText?: string; burmeseText?: string }
>(segments: T[], voiceId: string): T[] {
  const unified = resolveSingleDubbingVoice(voiceId);
  return segments.map((seg) => {
    if (seg.kind === 'silence') {
      const { voiceId: _omit, ...rest } = seg as any;
      return {
        ...rest,
        kind: 'silence' as const,
        chineseText: '',
        burmeseText: '',
      };
    }
    return {
      ...seg,
      voiceId: unified,
    };
  });
}


