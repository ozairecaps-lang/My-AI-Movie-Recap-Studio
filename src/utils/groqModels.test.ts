import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLikelyGroqVisionModel,
  selectGroqVisionCandidates,
  getGroqVisionMaxImages,
} from './groqModels';

test('selectGroqVisionCandidates prioritizes active qwen3.8-27b and filters retired/text models', () => {
  const available = [
    'llama-3.3-70b-versatile',
    'whisper-large-v3',
    'meta-llama/llama-prompt-guard-2-86m',
    'meta-models/muse-spark-open',
    'qwen/qwen3.8-27b',
  ];

  const candidates = selectGroqVisionCandidates(available);
  assert.deepEqual(candidates, ['qwen/qwen3.8-27b', 'meta-models/muse-spark-open']);
});

test('selectGroqVisionCandidates returns empty array when account has no vision models', () => {
  const available = ['llama-3.3-70b-versatile', 'whisper-large-v3', 'gpt-oss-120b'];
  const candidates = selectGroqVisionCandidates(available);
  assert.deepEqual(candidates, []);
});

test('selectGroqVisionCandidates excludes retired scout when unavailable and falls back cleanly on null list', () => {
  const fallback = selectGroqVisionCandidates(null);
  assert.equal(fallback.includes('meta-llama/llama-4-scout-17b-16e-instruct'), false);
  assert.equal(fallback[0], 'qwen/qwen3.8-27b');
});

test('isLikelyGroqVisionModel rejects non-vision guardrails and audio models', () => {
  assert.equal(isLikelyGroqVisionModel('qwen/qwen3.8-27b'), true);
  assert.equal(isLikelyGroqVisionModel('meta-models/muse-spark-open'), true);
  assert.equal(isLikelyGroqVisionModel('whisper-large-v3'), false);
  assert.equal(isLikelyGroqVisionModel('meta-llama/llama-prompt-guard-2-86m'), false);
  assert.equal(isLikelyGroqVisionModel('canopylabs/orpheus-v1-english'), false);
});

test('getGroqVisionMaxImages respects Groq 3-image limit for qwen3.8-27b', () => {
  assert.equal(getGroqVisionMaxImages('qwen/qwen3.8-27b'), 3);
  assert.equal(getGroqVisionMaxImages('meta-models/muse-spark-open'), 5);
});
