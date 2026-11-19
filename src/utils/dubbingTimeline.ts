import { DialogueTranslationSegment, SpeechSegment } from '../../server/types';

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface RawWhisperSegment extends SpeechSegment {
  no_speech_prob?: number;
}

export interface TimelinePartitionSegment {
  id: number;
  kind: 'speaking' | 'silence';
  start: number;
  end: number;
  sourceDuration: number;
  text: string;
}

export interface DubbingSpeedPlanItem {
  id: number;
  kind: 'speaking' | 'silence';
  start: number;
  end: number;
  sourceDuration: number;
  targetDuration: number;
  ptsScale: number;
  videoSpeedFactor: number;
  outputStart: number;
  outputEnd: number;
}

const MIN_SEGMENT_SEC = 0.08;

function roundSec(val: number): number {
  return Math.round(val * 1000) / 1000;
}

/**
 * Use Groq Whisper word-level timestamps (when available) to refine segment boundaries
 * and split segments that contain significant internal silent pauses (>= minPauseSec).
 */
export function splitSpeechSegmentsByWordPauses(
  segments: RawWhisperSegment[],
  words?: WordTimestamp[],
  minPauseSec = 0.45
): SpeechSegment[] {
  const cleanedSegments = (segments || [])
    .filter((s) => {
      const text = (s.text || '').trim();
      if (!text) return false;
      if (typeof s.no_speech_prob === 'number' && s.no_speech_prob >= 0.9 && text.length <= 2) {
        return false;
      }
      return s.end > s.start + 0.05;
    })
    .map((s) => ({
      id: s.id,
      start: Math.max(0, s.start),
      end: Math.max(s.start + 0.05, s.end),
      text: s.text.trim(),
    }))
    .sort((a, b) => a.start - b.start);

  if (!words || words.length === 0 || cleanedSegments.length === 0) {
    return cleanedSegments.map((s, idx) => ({ ...s, id: idx + 1 }));
  }

  const sortedWords = words
    .filter((w) => (w.word || '').trim().length > 0 && w.end >= w.start)
    .sort((a, b) => a.start - b.start);

  if (sortedWords.length === 0) {
    return cleanedSegments.map((s, idx) => ({ ...s, id: idx + 1 }));
  }

  const result: SpeechSegment[] = [];

  for (const seg of cleanedSegments) {
    const segWords = sortedWords.filter(
      (w) => w.end > seg.start - 0.15 && w.start < seg.end + 0.15
    );

    if (segWords.length < 2) {
      if (segWords.length === 1) {
        const w = segWords[0];
        const tightStart =
          w.start - seg.start > 0.35 ? Math.max(seg.start, w.start - 0.08) : seg.start;
        const tightEnd =
          seg.end - w.end > 0.35 ? Math.min(seg.end, w.end + 0.08) : seg.end;
        result.push({
          id: result.length + 1,
          start: roundSec(tightStart),
          end: roundSec(Math.max(tightStart + 0.1, tightEnd)),
          text: seg.text,
        });
      } else {
        result.push({
          id: result.length + 1,
          start: roundSec(seg.start),
          end: roundSec(seg.end),
          text: seg.text,
        });
      }
      continue;
    }

    // Group words into sub-runs separated by silent gaps >= minPauseSec
    const groups: WordTimestamp[][] = [[segWords[0]]];
    for (let i = 1; i < segWords.length; i++) {
      const prev = segWords[i - 1];
      const curr = segWords[i];
      if (curr.start - prev.end >= minPauseSec) {
        groups.push([curr]);
      } else {
        groups[groups.length - 1].push(curr);
      }
    }

    if (groups.length === 1) {
      const first = groups[0][0];
      const last = groups[0][groups[0].length - 1];
      const tightStart =
        first.start - seg.start > 0.35 ? Math.max(seg.start, first.start - 0.08) : seg.start;
      const tightEnd =
        seg.end - last.end > 0.35 ? Math.min(seg.end, last.end + 0.08) : seg.end;
      result.push({
        id: result.length + 1,
        start: roundSec(tightStart),
        end: roundSec(Math.max(tightStart + 0.1, tightEnd)),
        text: seg.text,
      });
    } else {
      for (const grp of groups) {
        const grpStart = Math.max(seg.start, grp[0].start - 0.05);
        const grpEnd = Math.min(seg.end, grp[grp.length - 1].end + 0.05);
        const grpText = grp.map((w) => w.word.trim()).join('').trim() || seg.text;
        if (grpEnd > grpStart + 0.08 && grpText) {
          result.push({
            id: result.length + 1,
            start: roundSec(grpStart),
            end: roundSec(grpEnd),
            text: grpText,
          });
        }
      }
    }
  }

  return result.map((s, idx) => ({ ...s, id: idx + 1 }));
}

/**
 * Partition [0, videoDuration] strictly into contiguous, non-overlapping
 * 'speaking' and 'silence' segments using Groq Whisper timestamps.
 */
export function buildSpeakingAndSilenceTimeline(
  speechSegments: SpeechSegment[],
  videoDuration: number
): TimelinePartitionSegment[] {
  const safeDuration = Math.max(0.2, Number.isFinite(videoDuration) ? videoDuration : 10);

  const normalizedSpeech = (speechSegments || [])
    .filter((s) => (s.text || '').trim().length > 0)
    .map((s) => ({
      start: Math.max(0, Math.min(safeDuration, Number(s.start) || 0)),
      end: Math.max(0, Math.min(safeDuration, Number(s.end) || 0)),
      text: s.text.trim(),
    }))
    .filter((s) => s.end - s.start >= MIN_SEGMENT_SEC)
    .sort((a, b) => a.start - b.start);

  // Resolve any overlaps between consecutive speech segments
  const nonOverlapping: Array<{ start: number; end: number; text: string }> = [];
  for (const seg of normalizedSpeech) {
    if (nonOverlapping.length === 0) {
      nonOverlapping.push({ ...seg });
      continue;
    }
    const prev = nonOverlapping[nonOverlapping.length - 1];
    if (seg.start < prev.end) {
      const clampedStart = prev.end;
      if (seg.end - clampedStart >= MIN_SEGMENT_SEC) {
        nonOverlapping.push({ start: clampedStart, end: seg.end, text: seg.text });
      } else {
        // Tiny overlap tail -> append text cleanly to previous speaking segment
        prev.end = Math.max(prev.end, seg.end);
        prev.text = `${prev.text} ${seg.text}`.trim();
      }
    } else {
      nonOverlapping.push({ ...seg });
    }
  }

  const timeline: TimelinePartitionSegment[] = [];
  let cursor = 0;

  for (const speech of nonOverlapping) {
    const gap = roundSec(speech.start - cursor);
    if (gap >= MIN_SEGMENT_SEC) {
      timeline.push({
        id: timeline.length + 1,
        kind: 'silence',
        start: roundSec(cursor),
        end: roundSec(speech.start),
        sourceDuration: gap,
        text: '',
      });
      cursor = speech.start;
    } else if (gap > 0 && timeline.length > 0) {
      // Absorb tiny sub-frame gap into previous segment so FFmpeg concat stays frame-valid
      const last = timeline[timeline.length - 1];
      last.end = roundSec(speech.start);
      last.sourceDuration = roundSec(last.end - last.start);
      cursor = speech.start;
    } else if (gap > 0) {
      // Tiny < 0.08s leading gap -> pull start back to 0 cleanly
      speech.start = 0;
      cursor = 0;
    }

    const dur = roundSec(speech.end - cursor);
    if (dur >= MIN_SEGMENT_SEC) {
      timeline.push({
        id: timeline.length + 1,
        kind: 'speaking',
        start: roundSec(cursor),
        end: roundSec(speech.end),
        sourceDuration: dur,
        text: speech.text,
      });
      cursor = speech.end;
    }
  }

  const trailingGap = roundSec(safeDuration - cursor);
  if (trailingGap >= MIN_SEGMENT_SEC || timeline.length === 0) {
    const startVal = timeline.length === 0 ? 0 : roundSec(cursor);
    const endVal = roundSec(safeDuration);
    if (endVal > startVal) {
      timeline.push({
        id: timeline.length + 1,
        kind: 'silence',
        start: startVal,
        end: endVal,
        sourceDuration: roundSec(endVal - startVal),
        text: '',
      });
    }
  } else if (trailingGap > 0 && timeline.length > 0) {
    const last = timeline[timeline.length - 1];
    last.end = roundSec(safeDuration);
    last.sourceDuration = roundSec(last.end - last.start);
  }

  return timeline;
}

/**
 * Merge translated Burmese speaking segments back into the full Speaking + Silence timeline.
 * Silence segments ALWAYS remain empty (no Chinese text, no Myanmar dubbing text, no voiceId).
 */
export function mergeTranslatedSpeakingSegments(
  partition: TimelinePartitionSegment[],
  translatedSpeakingSegments: DialogueTranslationSegment[],
  globalVoiceId: string
): DialogueTranslationSegment[] {
  let speakingIdx = 0;

  return partition.map((slot, idx) => {
    if (slot.kind === 'silence') {
      return {
        id: idx + 1,
        kind: 'silence',
        start: slot.start,
        end: slot.end,
        chineseText: '',
        burmeseText: '',
      };
    }

    const translated = translatedSpeakingSegments[speakingIdx++];
    return {
      id: idx + 1,
      kind: 'speaking',
      start: slot.start,
      end: slot.end,
      chineseText: translated?.chineseText || slot.text,
      burmeseText: (translated?.burmeseText || '').trim() || slot.text,
      speaker: translated?.speaker || 'ဇာတ်ကောင် ၁',
      emotion: translated?.emotion || 'ပုံမှန်',
      voiceId: globalVoiceId,
    };
  });
}

/**
 * Ensure silence segments stay strictly empty and carry kind='silence' across saves/approvals.
 */
export function normalizeDubbingSegmentsWithSilence(
  segments: DialogueTranslationSegment[],
  globalVoiceId: string
): DialogueTranslationSegment[] {
  return segments.map((seg, idx) => {
    const isSilence =
      seg.kind === 'silence' ||
      (!seg.chineseText?.trim() && !seg.burmeseText?.trim());
    if (isSilence) {
      return {
        id: idx + 1,
        kind: 'silence',
        start: seg.start,
        end: seg.end,
        chineseText: '',
        burmeseText: '',
      };
    }
    return {
      ...seg,
      id: idx + 1,
      kind: 'speaking',
      voiceId: globalVoiceId,
    };
  });
}

/**
 * Compute playback speed adjustments ONLY for speaking video segments to match
 * each segment's AI voice duration. Silence video segments strictly stay at 1.0x speed.
 */
export function computeDubbingSegmentSpeedPlan(
  segments: Array<{
    id: number;
    kind?: 'speaking' | 'silence';
    start: number;
    end: number;
    burmeseText?: string;
    ttsDuration?: number;
  }>
): DubbingSpeedPlanItem[] {
  let outputCursor = 0;
  const plan: DubbingSpeedPlanItem[] = [];

  for (const seg of segments) {
    const sourceDuration = Math.max(MIN_SEGMENT_SEC, roundSec(seg.end - seg.start));
    const isSilence =
      seg.kind === 'silence' || !(seg.burmeseText && seg.burmeseText.trim().length > 0);

    if (isSilence) {
      const targetDuration = sourceDuration;
      const item: DubbingSpeedPlanItem = {
        id: seg.id,
        kind: 'silence',
        start: seg.start,
        end: seg.end,
        sourceDuration,
        targetDuration,
        ptsScale: 1.0,
        videoSpeedFactor: 1.0,
        outputStart: roundSec(outputCursor),
        outputEnd: roundSec(outputCursor + targetDuration),
      };
      outputCursor += targetDuration;
      plan.push(item);
    } else {
      const rawTts =
        typeof seg.ttsDuration === 'number' && seg.ttsDuration > 0.1
          ? seg.ttsDuration
          : sourceDuration;
      const targetDuration = roundSec(Math.max(0.15, rawTts));
      const ptsScale = Math.round((targetDuration / sourceDuration) * 10000) / 10000;
      const videoSpeedFactor = Math.round((sourceDuration / targetDuration) * 1000) / 1000;

      const item: DubbingSpeedPlanItem = {
        id: seg.id,
        kind: 'speaking',
        start: seg.start,
        end: seg.end,
        sourceDuration,
        targetDuration,
        ptsScale,
        videoSpeedFactor,
        outputStart: roundSec(outputCursor),
        outputEnd: roundSec(outputCursor + targetDuration),
      };
      outputCursor += targetDuration;
      plan.push(item);
    }
  }

  return plan;
}
