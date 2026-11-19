import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSpeechSegmentsByWordPauses,
  buildSpeakingAndSilenceTimeline,
  mergeTranslatedSpeakingSegments,
  normalizeDubbingSegmentsWithSilence,
  computeDubbingSegmentSpeedPlan,
} from './dubbingTimeline';

test('splitSpeechSegmentsByWordPauses splits Whisper segments at internal silent pauses', () => {
  const segs = [{ id: 1, start: 0.5, end: 8.5, text: '你好我们走吧' }];
  const words = [
    { word: '你好', start: 1.0, end: 1.6 },
    // 2.4s internal silence pause here!
    { word: '我们', start: 4.0, end: 4.5 },
    { word: '走吧', start: 4.6, end: 5.2 },
  ];

  const refined = splitSpeechSegmentsByWordPauses(segs, words, 0.45);
  assert.equal(refined.length, 2);
  assert.equal(refined[0].text, '你好');
  assert.ok(refined[0].start >= 0.9 && refined[0].end <= 1.7);
  assert.equal(refined[1].text, '我们走吧');
  assert.ok(refined[1].start >= 3.9 && refined[1].end <= 5.3);
});

test('buildSpeakingAndSilenceTimeline partitions [0, duration] into contiguous speaking and silence blocks', () => {
  const speech = [
    { id: 1, start: 2.0, end: 4.5, text: '你好' },
    { id: 2, start: 8.0, end: 11.0, text: '我们必须联手' },
  ];

  const timeline = buildSpeakingAndSilenceTimeline(speech, 15.0);
  assert.equal(timeline.length, 5);

  assert.deepEqual(
    timeline.map((t) => ({ kind: t.kind, start: t.start, end: t.end, text: t.text })),
    [
      { kind: 'silence', start: 0, end: 2.0, text: '' },
      { kind: 'speaking', start: 2.0, end: 4.5, text: '你好' },
      { kind: 'silence', start: 4.5, end: 8.0, text: '' },
      { kind: 'speaking', start: 8.0, end: 11.0, text: '我们必须联手' },
      { kind: 'silence', start: 11.0, end: 15.0, text: '' },
    ]
  );

  // Strict continuity check
  assert.equal(timeline[0].start, 0);
  assert.equal(timeline[timeline.length - 1].end, 15.0);
  for (let i = 1; i < timeline.length; i++) {
    assert.equal(timeline[i].start, timeline[i - 1].end);
  }
});

test('mergeTranslatedSpeakingSegments keeps silence segments completely empty and assigns TTS only to speaking', () => {
  const partition = buildSpeakingAndSilenceTimeline(
    [
      { id: 1, start: 1.5, end: 3.5, text: '你好' },
      { id: 2, start: 6.0, end: 8.0, text: '再见' },
    ],
    10.0
  );

  const translatedSpeaking = [
    {
      id: 1,
      start: 1.5,
      end: 3.5,
      chineseText: '你好',
      burmeseText: 'မင်္ဂလာပါ',
      speaker: 'ဇာတ်ကောင် ၁',
      emotion: 'တည်ငြိမ်',
    },
    {
      id: 2,
      start: 6.0,
      end: 8.0,
      chineseText: '再见',
      burmeseText: 'နှုတ်ဆက်ပါတယ်',
      speaker: 'ဇာတ်ကောင် ၂',
      emotion: 'ပုံမှန်',
    },
  ];

  const merged = mergeTranslatedSpeakingSegments(partition, translatedSpeaking, 'gemini-Kore');
  assert.equal(merged.length, 5);
  assert.equal(merged[0].kind, 'silence');
  assert.equal(merged[0].burmeseText, '');
  assert.equal(merged[0].voiceId, undefined);

  assert.equal(merged[1].kind, 'speaking');
  assert.equal(merged[1].burmeseText, 'မင်္ဂလာပါ');
  assert.equal(merged[1].voiceId, 'gemini-Kore');

  assert.equal(merged[2].kind, 'silence');
  assert.equal(merged[2].burmeseText, '');

  assert.equal(merged[3].kind, 'speaking');
  assert.equal(merged[3].burmeseText, 'နှုတ်ဆက်ပါတယ်');
  assert.equal(merged[3].voiceId, 'gemini-Kore');

  assert.equal(merged[4].kind, 'silence');
  assert.equal(merged[4].burmeseText, '');
});

test('computeDubbingSegmentSpeedPlan scales ONLY speaking segments and preserves silence at 1.0x speed', () => {
  const segments = [
    { id: 1, kind: 'silence' as const, start: 0, end: 2.0, burmeseText: '' },
    { id: 2, kind: 'speaking' as const, start: 2.0, end: 4.0, burmeseText: 'မင်္ဂလာပါ', ttsDuration: 3.0 },
    { id: 3, kind: 'silence' as const, start: 4.0, end: 8.0, burmeseText: '' },
    { id: 4, kind: 'speaking' as const, start: 8.0, end: 12.0, burmeseText: 'သွားကြစို့', ttsDuration: 2.0 },
    { id: 5, kind: 'silence' as const, start: 12.0, end: 15.0, burmeseText: '' },
  ];

  const plan = computeDubbingSegmentSpeedPlan(segments);
  assert.equal(plan.length, 5);

  // Silence #1: untouched 1.0x speed (2.0s)
  assert.equal(plan[0].kind, 'silence');
  assert.equal(plan[0].ptsScale, 1.0);
  assert.equal(plan[0].videoSpeedFactor, 1.0);
  assert.equal(plan[0].targetDuration, 2.0);
  assert.equal(plan[0].outputStart, 0);
  assert.equal(plan[0].outputEnd, 2.0);

  // Speaking #2: source 2.0s stretched to match 3.0s TTS -> ptsScale = 1.5, videoSpeedFactor = 0.667
  assert.equal(plan[1].kind, 'speaking');
  assert.equal(plan[1].ptsScale, 1.5);
  assert.equal(plan[1].videoSpeedFactor, 0.667);
  assert.equal(plan[1].targetDuration, 3.0);
  assert.equal(plan[1].outputStart, 2.0);
  assert.equal(plan[1].outputEnd, 5.0);

  // Silence #3: untouched 1.0x speed (4.0s)
  assert.equal(plan[2].kind, 'silence');
  assert.equal(plan[2].ptsScale, 1.0);
  assert.equal(plan[2].videoSpeedFactor, 1.0);
  assert.equal(plan[2].targetDuration, 4.0);
  assert.equal(plan[2].outputStart, 5.0);
  assert.equal(plan[2].outputEnd, 9.0);

  // Speaking #4: source 4.0s sped up to match 2.0s TTS -> ptsScale = 0.5, videoSpeedFactor = 2.0
  assert.equal(plan[3].kind, 'speaking');
  assert.equal(plan[3].ptsScale, 0.5);
  assert.equal(plan[3].videoSpeedFactor, 2.0);
  assert.equal(plan[3].targetDuration, 2.0);
  assert.equal(plan[3].outputStart, 9.0);
  assert.equal(plan[3].outputEnd, 11.0);

  // Silence #5: untouched 1.0x speed (3.0s)
  assert.equal(plan[4].kind, 'silence');
  assert.equal(plan[4].ptsScale, 1.0);
  assert.equal(plan[4].videoSpeedFactor, 1.0);
  assert.equal(plan[4].targetDuration, 3.0);
  assert.equal(plan[4].outputStart, 11.0);
  assert.equal(plan[4].outputEnd, 14.0);
});

test('normalizeDubbingSegmentsWithSilence prevents accidental voiceId or text on silence rows', () => {
  const input = [
    { id: 1, kind: 'silence' as const, start: 0, end: 2, chineseText: 'ignored', burmeseText: 'should clear', voiceId: 'gemini-Kore' },
    { id: 2, kind: 'speaking' as const, start: 2, end: 5, chineseText: '你好', burmeseText: 'မင်္ဂလာပါ' },
  ];
  const normalized = normalizeDubbingSegmentsWithSilence(input, 'gemini-Charon');
  assert.equal(normalized[0].kind, 'silence');
  assert.equal(normalized[0].chineseText, '');
  assert.equal(normalized[0].burmeseText, '');
  assert.equal(normalized[0].voiceId, undefined);
  assert.equal(normalized[1].kind, 'speaking');
  assert.equal(normalized[1].voiceId, 'gemini-Charon');
});
