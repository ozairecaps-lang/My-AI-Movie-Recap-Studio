import type { SubtitleStyleConfig } from '../src/utils/subtitle';
import type { AutoBlurConfig, AutoBlurRegion, AutoBlurStyle } from '../src/utils/autoBlur';
export type { AutoBlurConfig, AutoBlurRegion, AutoBlurStyle };

export interface SpeechSegment {
  id: number | string;
  start: number;
  end: number;
  text: string;
}

export interface OcrDetection {
  timestamp: number;
  chineseText: string;
  confidence?: number;
}

export interface CharacterItem {
  name: string;
  role: string;
  description: string;
}

export interface SceneItem {
  timeRange: string;
  description: string;
}

export interface NarrationSegment {
  id: number;
  text: string;
  estimatedDuration?: number;
}

export type RecapNarrationStyle = 'dramatic' | 'informative' | 'suspense' | 'casual';
export type TtsProviderType = 'edge' | 'google' | 'gemini';
export type TextProviderType = 'gemini' | 'groq';

export interface ProviderConfig {
  ttsProvider: TtsProviderType;
  textProvider: TextProviderType;
  defaultVoice: string;
  dubbingDefaultVoice: string;
  geminiTtsVoice: 'Kore' | 'Charon' | 'Puck' | 'Fenrir' | 'Zephyr';
  updatedAt: string;
}

export interface DubbingCharacterVoice {
  speaker: string;
  voiceId: string;
  provider?: TtsProviderType;
}

export interface ProjectRecapScript {
  title: string;
  genre: string;
  narrationStyle?: RecapNarrationStyle;
  charactersSummary: CharacterItem[];
  scenesSummary?: SceneItem[];
  synopsis: string;
  narrationSegments: NarrationSegment[];
  approved?: boolean;
}

export type ProcessingMode = 'subtitle' | 'recap' | 'dubbing';

export interface DialogueTranslationSegment {
  id: number;
  kind?: 'speaking' | 'silence';
  start: number;
  end: number;
  chineseText: string;
  burmeseText: string;
  speaker?: string;
  emotion?: string;
  voiceId?: string;
  ttsDuration?: number;
  videoSpeedFactor?: number;
  outputStart?: number;
  outputEnd?: number;
}

export interface ProjectDialogueScript {
  segments: DialogueTranslationSegment[];
  characterVoices?: DubbingCharacterVoice[];
  approved?: boolean;
}

export interface ProjectSettings {
  mode: ProcessingMode;
  recapLength: 'short' | 'medium' | 'long';
  narrationStyle?: RecapNarrationStyle;
  ttsProvider?: TtsProviderType;
  ttsVoice: string;
  dubbingVoice?: string;
  speakingRate: string; // e.g. '1.00x', '1.25x', up to '3.00x'
  originalAudioVolume: number; // 0 = Mute, 0.15 = Background, 1.0 = Original
  narrationVolume?: number; // 0 to 1.5
  bgmVolume?: number; // 0 to 1.0
  bgmFilename?: string;
  burnSubtitles: boolean;
  fontSize: number;
  subtitleStyle?: SubtitleStyleConfig;
  autoBlur?: Partial<AutoBlurConfig>;
  characterVoices?: DubbingCharacterVoice[];
}

export interface LogEntry {
  timestamp: string;
  step: number;
  message: string;
  type: 'info' | 'warn' | 'error' | 'success';
}

export interface Project {
  id: string;
  title: string;
  originalFilename: string;
  fileSize: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  createdAt: string;
  updatedAt: string;
  status: 'uploaded' | 'processing' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  currentStep: number; // 1 to 13
  progress: number;    // 0 to 100
  currentStepTitle: string;
  error?: string | null;
  tempCleaned?: boolean;
  settings: ProjectSettings;
  transcription?: {
    segments: SpeechSegment[];
    language: string;
    provider: 'groq' | 'gemini' | 'sample' | 'none';
  };
  ocr?: {
    detections: OcrDetection[];
    frameCount: number;
  };
  mode?: ProcessingMode;
  recapScript?: ProjectRecapScript;
  dialogueScript?: ProjectDialogueScript;
  narration?: {
    audioPath?: string;
    durationSeconds?: number;
    voiceUsed?: string;
    providerUsed?: TtsProviderType;
  };
  subtitles?: {
    srtPath?: string;
    assPath?: string;
    cuesCount?: number;
  };
  export?: {
    videoPath?: string;
    srtPath?: string;
    assPath?: string;
    scriptPath?: string;
    renderedAt?: string;
  };
  autoBlur?: {
    regions: AutoBlurRegion[];
    config: AutoBlurConfig;
    detectedAt?: string;
    renderedSignature?: string;
  };
  logs: LogEntry[];
}
