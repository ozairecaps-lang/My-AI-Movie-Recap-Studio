import fs from 'fs';
import path from 'path';
import { ProviderConfig } from './types';
import { resolveSingleDubbingVoice } from '../src/utils/editorMath';

const PROVIDER_CONFIG_FILE = path.resolve(process.cwd(), 'data', 'provider_config.json');

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  ttsProvider: 'edge',
  textProvider: 'gemini',
  defaultVoice: 'my-MM-NilarNeural',
  dubbingDefaultVoice: 'gemini-Kore',
  geminiTtsVoice: 'Kore',
  updatedAt: new Date().toISOString(),
};

export function getProviderConfig(): ProviderConfig {
  try {
    if (fs.existsSync(PROVIDER_CONFIG_FILE)) {
      const raw = fs.readFileSync(PROVIDER_CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_PROVIDER_CONFIG,
        ...parsed,
        dubbingDefaultVoice: resolveSingleDubbingVoice(
          parsed?.dubbingDefaultVoice,
          'gemini-Kore'
        ),
      };
    }
  } catch {
    // ignore corrupt config
  }
  return { ...DEFAULT_PROVIDER_CONFIG };
}

export function saveProviderConfig(updates: Partial<ProviderConfig>): ProviderConfig {
  const dir = path.dirname(PROVIDER_CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const current = getProviderConfig();
  const next: ProviderConfig = {
    ...current,
    ...updates,
    dubbingDefaultVoice: resolveSingleDubbingVoice(
      updates.dubbingDefaultVoice ?? current.dubbingDefaultVoice,
      'gemini-Kore'
    ),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(PROVIDER_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
