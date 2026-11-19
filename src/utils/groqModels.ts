export const PREFERRED_GROQ_VISION_MODELS = [
  'qwen/qwen3.8-27b',
  'meta-models/muse-spark-open',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
] as const;

export const DEFAULT_GROQ_VISION_FALLBACKS = [
  'qwen/qwen3.8-27b',
  'meta-models/muse-spark-open',
] as const;

/**
 * Returns true if a Groq model ID is likely multimodal / vision-capable.
 */
export function isLikelyGroqVisionModel(modelId: string): boolean {
  const id = (modelId || '').trim().toLowerCase();
  if (!id) return false;

  // Exclude audio, TTS, guardrails, embeddings, and pure text models
  if (
    id.includes('whisper') ||
    id.includes('tts') ||
    id.includes('orpheus') ||
    id.includes('prompt-guard') ||
    id.includes('safeguard') ||
    id.includes('embed')
  ) {
    return false;
  }

  return (
    id === 'qwen/qwen3.8-27b' ||
    id === 'meta-models/muse-spark-open' ||
    id.includes('llama-4-') ||
    id.includes('vision') ||
    id.includes('qwen3.8') ||
    id.includes('-vl')
  );
}

/**
 * Given the list of model IDs returned by `groq.models.list()`,
 * select valid vision-capable candidates in priority order.
 * If `availableModelIds` is unavailable (null/undefined), returns active default vision models.
 */
export function selectGroqVisionCandidates(
  availableModelIds?: string[] | null
): string[] {
  if (!availableModelIds) {
    return [...DEFAULT_GROQ_VISION_FALLBACKS];
  }

  const normalizedSet = new Set(
    availableModelIds.map((id) => String(id || '').trim()).filter(Boolean)
  );
  if (normalizedSet.size === 0) {
    return [];
  }

  const selected: string[] = [];
  for (const preferred of PREFERRED_GROQ_VISION_MODELS) {
    if (normalizedSet.has(preferred) && !selected.includes(preferred)) {
      selected.push(preferred);
    }
  }

  for (const id of normalizedSet) {
    if (isLikelyGroqVisionModel(id) && !selected.includes(id)) {
      selected.push(id);
    }
  }

  return selected;
}

/**
 * Groq active vision models such as qwen/qwen3.8-27b allow up to 3 images per request.
 */
export function getGroqVisionMaxImages(modelId?: string): number {
  const id = (modelId || '').toLowerCase();
  if (id.includes('muse-spark')) return 5;
  return 3;
}
