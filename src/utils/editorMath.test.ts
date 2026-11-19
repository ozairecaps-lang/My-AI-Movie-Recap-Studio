import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_UPLOAD_BYTES,
  validateUploadVideoFile,
  formatBytes,
  formatTimecode,
  clampAudioGain,
  DUBBING_VOICE_OPTIONS,
  DEFAULT_DUBBING_VOICE_ID,
  isValidDubbingVoiceId,
  resolveSingleDubbingVoice,
  applySingleDubbingVoiceToSegments,
} from './editorMath';

test('validateUploadVideoFile enforces 100 MB limit and supported extensions', () => {
  assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);

  const ok = validateUploadVideoFile({ name: 'movie.mp4', size: 15 * 1024 * 1024, type: 'video/mp4' });
  assert.equal(ok.valid, true);

  const tooBig = validateUploadVideoFile({ name: 'huge.mkv', size: 120 * 1024 * 1024, type: 'video/x-matroska' });
  assert.equal(tooBig.valid, false);
  assert.ok(tooBig.error?.includes('100 MB'));

  const badExt = validateUploadVideoFile({ name: 'doc.pdf', size: 1024, type: 'application/pdf' });
  assert.equal(badExt.valid, false);
});

test('formatBytes and formatTimecode format numbers deterministically', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(150 * 1024 * 1024), '150 MB');
  assert.equal(formatTimecode(0), '00:00.0');
  assert.equal(formatTimecode(65.4), '01:05.4');
});

test('clampAudioGain clamps between 0 and 1.5', () => {
  assert.equal(clampAudioGain(-0.4), 0);
  assert.equal(clampAudioGain(0.155), 0.16);
  assert.equal(clampAudioGain(2.4), 1.5);
});

test('Dubbing single-voice helpers use Gemini TTS voices and keep silence segments voiceless', () => {
  assert.deepEqual(
    DUBBING_VOICE_OPTIONS.map((v) => v.id),
    ['gemini-Kore', 'gemini-Charon', 'gemini-Zephyr', 'gemini-Fenrir', 'gemini-Puck']
  );
  assert.equal(isValidDubbingVoiceId('gemini-Kore'), true);
  assert.equal(isValidDubbingVoiceId('gemini-Charon'), true);
  assert.equal(isValidDubbingVoiceId('gemini-Puck'), true);
  assert.equal(isValidDubbingVoiceId('unknown-voice'), false);

  assert.equal(resolveSingleDubbingVoice(undefined), DEFAULT_DUBBING_VOICE_ID);
  assert.equal(resolveSingleDubbingVoice('gemini-Charon'), 'gemini-Charon');
  assert.equal(resolveSingleDubbingVoice('my-MM-NilarNeural'), 'gemini-Kore');
  assert.equal(resolveSingleDubbingVoice('my-MM-ThihaNeural'), 'gemini-Charon');
  assert.equal(resolveSingleDubbingVoice('bad-voice', 'gemini-Charon'), 'gemini-Charon');

  const multiSpeakerAndSilence = [
    { id: 1, kind: 'silence' as const, chineseText: '', burmeseText: '', voiceId: 'gemini-Kore' },
    { id: 2, kind: 'speaking' as const, speaker: 'Character 1', voiceId: 'gemini-Kore', burmeseText: 'မင်္ဂလာပါ' },
    { id: 3, kind: 'speaking' as const, speaker: 'Character 2', voiceId: 'gemini-Fenrir', burmeseText: 'နေကောင်းလား' },
  ];
  const normalized = applySingleDubbingVoiceToSegments(multiSpeakerAndSilence, 'gemini-Charon');
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].kind, 'silence');
  assert.equal(normalized[0].voiceId, undefined);
  assert.equal(normalized[1].voiceId, 'gemini-Charon');
  assert.equal(normalized[2].voiceId, 'gemini-Charon');
});


