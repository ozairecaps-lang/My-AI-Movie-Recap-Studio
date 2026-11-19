import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSrtTimestamp,
  parseSrtTimestamp,
  generateSrtContent,
  parseSrtContent,
  breakBurmeseLines,
  formatAssTimestamp,
  generateAssContent,
  splitSubtitleCue,
  mergeSubtitleCues,
  updateSubtitleCue,
  computeSubtitleMaskBox,
} from './subtitle';

test('formatSrtTimestamp formats seconds to SRT standard format', () => {
  assert.equal(formatSrtTimestamp(0), '00:00:00,000');
  assert.equal(formatSrtTimestamp(65.5), '00:01:05,500');
  assert.equal(formatSrtTimestamp(3661.123), '01:01:01,123');
});

test('parseSrtTimestamp parses HH:MM:SS,mmm string to seconds', () => {
  assert.equal(parseSrtTimestamp('00:00:00,000'), 0);
  assert.equal(parseSrtTimestamp('00:01:05,500'), 65.5);
  assert.equal(parseSrtTimestamp('01:01:01.123'), 3661.123);
});

test('generateSrtContent and parseSrtContent roundtrip properly', () => {
  const cues = [
    { id: 1, startTime: 1.0, endTime: 4.5, text: 'မင်္ဂလာပါ ဇာတ်ကားပြန်ပြောပြခြင်းဖြစ်ပါတယ်။' },
    { id: 2, startTime: 5.0, endTime: 8.2, text: 'အဓိကဇာတ်ကောင်သည် မြို့တော်သို့ ရောက်ရှိလာခဲ့သည်။' },
  ];

  const srt = generateSrtContent(cues);
  assert.ok(srt.includes('00:00:01,000 --> 00:00:04,500'));
  assert.ok(srt.includes('မင်္ဂလာပါ'));

  const parsed = parseSrtContent(srt);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'မင်္ဂလာပါ ဇာတ်ကားပြန်ပြောပြခြင်းဖြစ်ပါတယ်။');
  assert.equal(parsed[0].startTime, 1.0);
  assert.equal(parsed[0].endTime, 4.5);
  assert.equal(parsed[1].startTime, 5.0);
  assert.equal(parsed[1].endTime, 8.2);
});

test('breakBurmeseLines splits long Burmese text cleanly at punctuation or spaces', () => {
  const shortText = 'မင်္ဂလာပါခင်ဗျာ။';
  assert.equal(breakBurmeseLines(shortText, 30), shortText);

  const longText =
    'ရှေးခေတ်ကာလတစ်ခုတွင် ဧကရာဇ်မင်းသည် တိုင်းပြည်ကို အုပ်ချုပ်နေစဉ်၊ ရန်သူများက နယ်စပ်ကို ကျူးကျော်လာခဲ့ကြသည်။';
  const broken = breakBurmeseLines(longText, 40);
  assert.ok(broken.includes('\n'), 'Should contain line break');
  assert.ok(broken.length >= longText.length, 'Should preserve full text content');
  const lines = broken.split('\n');
  assert.ok(lines.length <= 2, 'Should not exceed 2 lines');
});

test('formatAssTimestamp formats seconds to ASS standard H:MM:SS.cc', () => {
  assert.equal(formatAssTimestamp(0), '0:00:00.00');
  assert.equal(formatAssTimestamp(1.5), '0:00:01.50');
  assert.equal(formatAssTimestamp(65.52), '0:01:05.52');
  assert.equal(formatAssTimestamp(3661.12), '1:01:01.12');
});

test('generateAssContent generates valid ASS format with portrait lower-center and custom X/Y position', () => {
  const cues = [
    {
      id: 1,
      startTime: 0.5,
      endTime: 3.5,
      text: 'ဒီနေ့ဇာတ်လမ်းလေးမှာတော့ စီးပွားရေးလုပ်ငန်းတွေ ကျဆင်းလာတာကို တင်ဆက်ပေးမှာ ဖြစ်ပါတယ်။',
    },
  ];

  // Default Portrait (1080x1920)
  const portraitAss = generateAssContent(cues, 1080, 1920);
  assert.ok(portraitAss.includes('PlayResX: 1080'));
  assert.ok(portraitAss.includes('PlayResY: 1920'));
  assert.ok(portraitAss.includes('Noto Sans Myanmar'));
  assert.ok(portraitAss.includes(',442,1'));
  assert.ok(portraitAss.includes('Dialogue: 0,0:00:00.50,0:00:03.50,Default,,0,0,0,,'));

  // Default Landscape (1280x720)
  const landscapeAss = generateAssContent(cues, 1280, 720);
  assert.ok(landscapeAss.includes(',72,1'));

  // Custom arbitrary positioning
  const customPosAss = generateAssContent(cues, 1280, 720, { posX: 50, posY: 20, bgMaskOpacity: 0.8 });
  assert.ok(customPosAss.includes('{\\an5\\pos(640,144)}'));
  assert.ok(customPosAss.includes('&H33000000'));
});

test('splitSubtitleCue and mergeSubtitleCues edit segments accurately', () => {
  const cues = [
    { id: 1, startTime: 0.0, endTime: 4.0, text: 'သုံးနှစ်ကြာပြီးနောက် မင်းနောက်ဆုံးတော့ ပြန်ရောက်လာခဲ့ပြီ။' },
    { id: 2, startTime: 4.5, endTime: 8.0, text: 'ဒီမြို့တော်ကို ကာကွယ်ရမယ်။' },
  ];

  const split = splitSubtitleCue(cues, 1);
  assert.equal(split.length, 3);
  assert.equal(split[0].id, 1);
  assert.equal(split[0].startTime, 0.0);
  assert.equal(split[0].endTime, 2.0);
  assert.equal(split[1].id, 2);
  assert.equal(split[1].startTime, 2.0);
  assert.equal(split[1].endTime, 4.0);
  assert.equal(split[2].id, 3);

  const merged = mergeSubtitleCues(split, 1, 2);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].startTime, 0.0);
  assert.equal(merged[0].endTime, 4.0);
  assert.ok(merged[0].text.includes('သုံးနှစ်ကြာပြီးနောက်'));

  const updated = updateSubtitleCue(merged, 2, { startTime: 4.2, endTime: 8.5, text: 'ပြင်ဆင်ပြီး' });
  assert.equal(updated[1].startTime, 4.2);
  assert.equal(updated[1].endTime, 8.5);
  assert.equal(updated[1].text, 'ပြင်ဆင်ပြီး');
});

test('computeSubtitleMaskBox keeps blur/mask region bounded inside video frame', () => {
  const box = computeSubtitleMaskBox(1280, 720, { posX: 99, posY: 99, bgBlur: 12, bgMaskOpacity: 0.7 });
  assert.ok(box.x >= 0 && box.x + box.w <= 1280);
  assert.ok(box.y >= 0 && box.y + box.h <= 720);
  assert.equal(box.w % 2, 0);
  assert.equal(box.h % 2, 0);
  assert.equal(box.blurSigma, 12);
});
