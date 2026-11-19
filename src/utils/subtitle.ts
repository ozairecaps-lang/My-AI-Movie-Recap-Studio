/**
 * Subtitle utility functions for Burmese (Myanmar Unicode) SRT & ASS generation,
 * parsing, timing calculations, cue splitting/merging, positioning, and line breaking.
 */

export interface SubtitleCue {
  id: number;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  text: string;
}

export interface SubtitleStyleConfig {
  posX: number;         // 0 - 100 (% from left, 50 = horizontally centered)
  posY: number;         // 0 - 100 (% from top, e.g. 77 = lower center portrait, 90 = bottom landscape)
  fontSizeScale: number; // 0.75 - 1.75 multiplier (1.0 = default auto)
  bgMaskEnabled: boolean; // Enables background blur/mask band behind subtitle (to cover hardcoded subs)
  bgMaskOpacity: number;  // 0 - 1.0 alpha for subtitle background box / mask
  bgBlur: number;         // 0 - 20 boxblur strength behind subtitle area
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = {
  posX: 50,
  posY: 85,
  fontSizeScale: 1.0,
  bgMaskEnabled: false,
  bgMaskOpacity: 0.65,
  bgBlur: 0,
};

/**
 * Format seconds into SRT timestamp string: HH:MM:SS,mmm
 */
export function formatSrtTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const totalMillis = Math.round(seconds * 1000);
  const hours = Math.floor(totalMillis / 3600000);
  const remainderAfterHours = totalMillis % 3600000;
  const minutes = Math.floor(remainderAfterHours / 60000);
  const remainderAfterMinutes = remainderAfterHours % 60000;
  const secs = Math.floor(remainderAfterMinutes / 1000);
  const millis = remainderAfterMinutes % 1000;

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/**
 * Parse SRT timestamp HH:MM:SS,mmm or HH:MM:SS.mmm into seconds
 */
export function parseSrtTimestamp(timestamp: string): number {
  const normalized = timestamp.trim().replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return 0;
}

/**
 * Generate standard SRT file format string from subtitle cues
 */
export function generateSrtContent(cues: SubtitleCue[]): string {
  return cues
    .map((cue, index) => {
      const cueIndex = index + 1;
      const startStr = formatSrtTimestamp(cue.startTime);
      const endStr = formatSrtTimestamp(cue.endTime);
      const cleanText = cue.text.trim();
      return `${cueIndex}\n${startStr} --> ${endStr}\n${cleanText}\n`;
    })
    .join('\n');
}

/**
 * Parse an SRT string into an array of SubtitleCues
 */
export function parseSrtContent(srtText: string): SubtitleCue[] {
  if (!srtText) return [];
  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.trim().split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length >= 2) {
      let timeLineIdx = 1;
      if (lines[0].includes('-->')) {
        timeLineIdx = 0;
      }
      const timeMatch = lines[timeLineIdx].match(
        /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
      );
      if (timeMatch) {
        const startTime = parseSrtTimestamp(timeMatch[1]);
        const endTime = parseSrtTimestamp(timeMatch[2]);
        const text = lines.slice(timeLineIdx + 1).join('\n').trim();
        cues.push({
          id: cues.length + 1,
          startTime,
          endTime,
          text,
        });
      }
    }
  }

  return cues;
}

/**
 * Split a single subtitle cue into two sequential cues cleanly at `splitTime` (or midpoint).
 */
export function splitSubtitleCue(
  cues: SubtitleCue[],
  cueId: number,
  splitTime?: number
): SubtitleCue[] {
  const idx = cues.findIndex((c) => c.id === cueId);
  if (idx === -1) return cues;

  const target = cues[idx];
  const duration = Math.max(0.2, target.endTime - target.startTime);
  const midTime =
    typeof splitTime === 'number' &&
    splitTime > target.startTime + 0.1 &&
    splitTime < target.endTime - 0.1
      ? Math.round(splitTime * 100) / 100
      : Math.round((target.startTime + duration / 2) * 100) / 100;

  const rawText = target.text.replace(/\s+/g, ' ').trim();
  let firstText = rawText;
  let secondText = rawText;

  if (rawText.length > 4) {
    const broken = breakBurmeseLines(rawText, Math.max(8, Math.floor(rawText.length / 2)));
    if (broken.includes('\n')) {
      const parts = broken.split('\n');
      firstText = parts[0].trim();
      secondText = parts.slice(1).join(' ').trim();
    } else {
      const half = Math.floor(rawText.length / 2);
      firstText = rawText.slice(0, half).trim();
      secondText = rawText.slice(half).trim();
    }
  }

  const firstCue: SubtitleCue = {
    id: 0,
    startTime: target.startTime,
    endTime: midTime,
    text: firstText || rawText,
  };

  const secondCue: SubtitleCue = {
    id: 0,
    startTime: midTime,
    endTime: target.endTime,
    text: secondText || rawText,
  };

  const next = [...cues.slice(0, idx), firstCue, secondCue, ...cues.slice(idx + 1)];
  return next.map((c, i) => ({ ...c, id: i + 1 }));
}

/**
 * Merge two subtitle cues (typically adjacent) into a single cue spanning their full range.
 */
export function mergeSubtitleCues(
  cues: SubtitleCue[],
  firstCueId: number,
  secondCueId: number
): SubtitleCue[] {
  if (firstCueId === secondCueId) return cues;
  const first = cues.find((c) => c.id === firstCueId);
  const second = cues.find((c) => c.id === secondCueId);
  if (!first || !second) return cues;

  const [earlier, later] =
    first.startTime <= second.startTime ? [first, second] : [second, first];

  const merged: SubtitleCue = {
    id: 0,
    startTime: Math.min(earlier.startTime, later.startTime),
    endTime: Math.max(earlier.endTime, later.endTime),
    text: `${earlier.text.trim()} ${later.text.trim()}`.trim(),
  };

  const filtered = cues
    .filter((c) => c.id !== firstCueId && c.id !== secondCueId)
    .concat(merged)
    .sort((a, b) => a.startTime - b.startTime);

  return filtered.map((c, i) => ({ ...c, id: i + 1 }));
}

/**
 * Update a cue's text or timings cleanly and re-sort chronologically.
 */
export function updateSubtitleCue(
  cues: SubtitleCue[],
  cueId: number,
  patch: Partial<Pick<SubtitleCue, 'startTime' | 'endTime' | 'text'>>
): SubtitleCue[] {
  const updated = cues.map((c) => {
    if (c.id !== cueId) return c;
    const nextStart = patch.startTime !== undefined ? Math.max(0, patch.startTime) : c.startTime;
    const nextEnd =
      patch.endTime !== undefined ? Math.max(nextStart + 0.1, patch.endTime) : Math.max(nextStart + 0.1, c.endTime);
    return {
      ...c,
      startTime: Math.round(nextStart * 100) / 100,
      endTime: Math.round(nextEnd * 100) / 100,
      text: patch.text !== undefined ? patch.text : c.text,
    };
  });
  return updated
    .sort((a, b) => a.startTime - b.startTime)
    .map((c, i) => ({ ...c, id: i + 1 }));
}

/**
 * Format seconds into ASS timestamp string: H:MM:SS.cc (e.g. 0:01:05.50)
 */
export function formatAssTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const totalMillis = Math.round(seconds * 1000);
  const hours = Math.floor(totalMillis / 3600000);
  const remainderAfterHours = totalMillis % 3600000;
  const minutes = Math.floor(remainderAfterHours / 60000);
  const remainderAfterMinutes = remainderAfterHours % 60000;
  const secs = Math.floor(remainderAfterMinutes / 1000);
  const centis = Math.floor((remainderAfterMinutes % 1000) / 10);

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis, 2)}`;
}

/**
 * Compute pixel-bounded rectangle for FFmpeg background blur and mask overlay behind subtitles.
 */
export function computeSubtitleMaskBox(
  videoWidth: number,
  videoHeight: number,
  style: Partial<SubtitleStyleConfig> = {}
): { x: number; y: number; w: number; h: number; blurSigma: number; maskAlpha: number } {
  const safeW = Math.max(160, Math.round(videoWidth));
  const safeH = Math.max(160, Math.round(videoHeight));
  const isPortrait = safeH > safeW;

  const posX = Math.max(10, Math.min(90, style.posX ?? 50));
  const posY = Math.max(8, Math.min(94, style.posY ?? (isPortrait ? 77 : 90)));
  const fontScale = Math.max(0.7, Math.min(2.0, style.fontSizeScale ?? 1.0));

  const boxWidth = Math.min(safeW, Math.round(safeW * (isPortrait ? 0.88 : 0.72)));
  const boxHeight = Math.min(safeH, Math.round(safeH * (isPortrait ? 0.11 : 0.14) * fontScale));

  const centerX = Math.round((posX / 100) * safeW);
  const centerY = Math.round((posY / 100) * safeH);

  // Ensure even dimensions for YUV/boxblur compatibility and keep strictly inside frame bounds
  const evenW = Math.max(32, boxWidth - (boxWidth % 2));
  const evenH = Math.max(24, boxHeight - (boxHeight % 2));
  const x = Math.max(0, Math.min(safeW - evenW, centerX - Math.round(evenW / 2)));
  const y = Math.max(0, Math.min(safeH - evenH, centerY - Math.round(evenH / 2)));

  return {
    x,
    y,
    w: evenW,
    h: evenH,
    blurSigma: Math.max(0, Math.min(25, Math.round(style.bgBlur ?? 0))),
    maskAlpha: Math.max(0, Math.min(0.95, style.bgMaskOpacity ?? 0.65)),
  };
}

/**
 * Convert opacity [0..1] to ASS alpha hex byte (00 = opaque, FF = transparent)
 */
function opacityToAssAlpha(opacity: number): string {
  const clamped = Math.max(0, Math.min(1, opacity));
  const alphaByte = Math.round((1 - clamped) * 255);
  return alphaByte.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Generate standard Advanced SubStation Alpha (ASS) file format with arbitrary positioning,
 * Myanmar Unicode font (Noto Sans Myanmar), responsive sizing, and configurable background mask opacity.
 */
export function generateAssContent(
  cues: SubtitleCue[],
  videoWidth = 1080,
  videoHeight = 1920,
  styleConfig?: Partial<SubtitleStyleConfig>
): string {
  const isPortrait = videoHeight > videoWidth;
  const fontScale = Math.max(0.7, Math.min(2.0, styleConfig?.fontSizeScale ?? 1.0));

  // Font size responsive to video height: ~2.4% for portrait, ~3.8% for landscape
  const baseFontSize = isPortrait
    ? Math.max(28, Math.round(videoHeight * 0.024))
    : Math.max(20, Math.round(videoHeight * 0.038));
  const fontSize = Math.round(baseFontSize * fontScale);

  // MarginV from bottom when using standard bottom-center default positioning
  const defaultPosY = isPortrait ? 77 : 90;
  const hasCustomPos =
    styleConfig !== undefined &&
    (styleConfig.posX !== undefined || styleConfig.posY !== undefined);

  const posX = Math.max(5, Math.min(95, styleConfig?.posX ?? 50));
  const posY = Math.max(5, Math.min(95, styleConfig?.posY ?? defaultPosY));

  const marginV = isPortrait
    ? Math.round(videoHeight * 0.23)
    : Math.round(videoHeight * 0.10);

  // BorderStyle 3 = semi-transparent compact background box; Outline = box padding
  const boxPadding = isPortrait ? 10 : 6;
  const marginLR = isPortrait ? 40 : 60;

  const bgOpacity = styleConfig?.bgMaskOpacity ?? 0.627; // default ~&HA0
  const assAlpha = styleConfig?.bgMaskOpacity !== undefined ? opacityToAssAlpha(bgOpacity) : 'A0';
  const backColour = `&H${assAlpha}000000`;

  const posPxX = Math.round((posX / 100) * videoWidth);
  const posPxY = Math.round((posY / 100) * videoHeight);

  const header = `[Script Info]
Title: Burmese Movie Recap Subtitles
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans Myanmar,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,${backColour},1,0,0,0,100,100,0,0,3,${boxPadding},0,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues
    .map((cue) => {
      const startStr = formatAssTimestamp(cue.startTime);
      const endStr = formatAssTimestamp(cue.endTime);
      const formattedLines = breakBurmeseLines(cue.text, isPortrait ? 38 : 46);
      const textAss = formattedLines
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .slice(0, 2)
        .join('\\N');
      const posPrefix = hasCustomPos ? `{\\an5\\pos(${posPxX},${posPxY})}` : '';
      return `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${posPrefix}${textAss}`;
    })
    .join('\n');

  return header + events + '\n';
}

/**
 * Break long Burmese sentences into readable lines for on-screen subtitles.
 * Ensures maximum 1–2 lines at a time.
 * Uses Myanmar punctuation (။, ၊) and spaces for natural breaks without cutting words.
 */
export function breakBurmeseLines(text: string, maxCharsPerLine = 42): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxCharsPerLine) {
    return trimmed;
  }

  if (trimmed.includes('\n')) {
    const rawLines = trimmed.split('\n').filter((l) => l.trim().length > 0);
    if (rawLines.length <= 2) {
      return rawLines.join('\n');
    }
    return `${rawLines[0]}\n${rawLines.slice(1).join(' ')}`.slice(0, 160);
  }

  const mid = Math.floor(trimmed.length / 2);
  const separators = ['၊', '။', ' ', '...'];
  let bestBreakIndex = -1;
  let minDistance = Infinity;

  for (const sep of separators) {
    let idx = trimmed.indexOf(sep);
    while (idx !== -1) {
      const dist = Math.abs(idx - mid);
      if (dist < minDistance && idx > 8 && idx < trimmed.length - 8) {
        minDistance = dist;
        bestBreakIndex = idx + (sep === ' ' ? 0 : 1);
      }
      idx = trimmed.indexOf(sep, idx + 1);
    }
  }

  if (bestBreakIndex !== -1) {
    const part1 = trimmed.slice(0, bestBreakIndex).trim();
    const part2 = trimmed.slice(bestBreakIndex).trim();
    return `${part1}\n${part2}`;
  }

  const spaceIdx = trimmed.indexOf(' ', Math.floor(trimmed.length * 0.4));
  if (spaceIdx !== -1 && spaceIdx < Math.floor(trimmed.length * 0.7)) {
    return `${trimmed.slice(0, spaceIdx).trim()}\n${trimmed.slice(spaceIdx).trim()}`;
  }

  return trimmed;
}
