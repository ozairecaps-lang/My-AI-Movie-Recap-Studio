/**
 * Pure domain utilities for Auto Blur Mask detection normalization, aspect-ratio preserving
 * video containment math, pixel bounding, and FFmpeg filter graph construction.
 * Supports 3 styles: 'blur', 'pixelate', and 'solid' — strictly inside original video area.
 */

export type AutoBlurStyle = 'blur' | 'pixelate' | 'solid';

export type AutoBlurRegionKind = 'text' | 'logo' | 'watermark' | 'graphic';

export interface AutoBlurRegion {
  id: string;
  kind: AutoBlurRegionKind;
  x: number; // Normalized 0..1 relative to video width
  y: number; // Normalized 0..1 relative to video height
  width: number; // Normalized >0..1 relative to video width
  height: number; // Normalized >0..1 relative to video height
  startTime?: number; // Seconds; undefined or full duration = persistent overlay
  endTime?: number;
  label?: string;
  confidence?: number;
}

export interface AutoBlurConfig {
  enabled: boolean;
  strength: number; // 1..25 intensity
  style: AutoBlurStyle;
  solidColor?: string; // e.g. '#090D16'
}

export const DEFAULT_AUTO_BLUR_CONFIG: AutoBlurConfig = {
  enabled: true,
  strength: 12,
  style: 'blur',
  solidColor: '#090D16',
};

export interface PixelBlurRect {
  id: string;
  kind: AutoBlurRegionKind;
  x: number;
  y: number;
  w: number;
  h: number;
  startTime?: number;
  endTime?: number;
}

export interface RawAutoBlurDetectionInput {
  kind?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  startTime?: number;
  endTime?: number;
  isStatic?: boolean;
  label?: string;
  confidence?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function makeEvenFloor(n: number): number {
  const rounded = Math.floor(n);
  return rounded % 2 === 0 ? rounded : Math.max(0, rounded - 1);
}

function makeEvenCeil(n: number): number {
  const rounded = Math.ceil(n);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function normalizeRegionKind(raw?: string): AutoBlurRegionKind {
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'logo' || v === 'brand') return 'logo';
  if (v === 'watermark' || v === 'handle') return 'watermark';
  if (v === 'graphic' || v === 'banner' || v === 'sticker' || v === 'overlay') return 'graphic';
  return 'text';
}

export function sanitizeAutoBlurConfig(raw?: Partial<AutoBlurConfig> | null): AutoBlurConfig {
  const style: AutoBlurStyle =
    raw?.style === 'pixelate' || raw?.style === 'solid' || raw?.style === 'blur'
      ? raw.style
      : DEFAULT_AUTO_BLUR_CONFIG.style;
  const rawStrength = typeof raw?.strength === 'number' && Number.isFinite(raw.strength)
    ? raw.strength
    : DEFAULT_AUTO_BLUR_CONFIG.strength;
  const strength = Math.round(clamp(rawStrength, 1, 25));
  const enabled = typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_AUTO_BLUR_CONFIG.enabled;
  const rawColor = typeof raw?.solidColor === 'string' ? raw.solidColor.trim() : '';
  const solidColor = /^#[0-9a-fA-F]{6}$/.test(rawColor)
    ? rawColor
    : DEFAULT_AUTO_BLUR_CONFIG.solidColor!;

  return { enabled, strength, style, solidColor };
}

export function getAutoBlurRenderSignature(
  config: Partial<AutoBlurConfig> | undefined,
  regionsCount: number
): string {
  const cfg = sanitizeAutoBlurConfig(config);
  return `${cfg.enabled ? 'on' : 'off'}:${cfg.style}:${cfg.strength}:${cfg.solidColor}:${regionsCount}`;
}

function computeIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): { iou: number; maxOverlapRatio: number } {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  if (ix2 <= ix1 || iy2 <= iy1) {
    return { iou: 0, maxOverlapRatio: 0 };
  }

  const interArea = (ix2 - ix1) * (iy2 - iy1);
  const areaA = Math.max(1e-6, a.width * a.height);
  const areaB = Math.max(1e-6, b.width * b.height);
  const unionArea = areaA + areaB - interArea;

  return {
    iou: interArea / unionArea,
    maxOverlapRatio: Math.max(interArea / areaA, interArea / areaB),
  };
}

/**
 * Normalize raw model bounding boxes (supporting [0..1] or [0..1000] scale),
 * strictly clamp inside [0, 1] original video area, add subtle coverage padding,
 * and deduplicate/merge overlapping static or time-adjacent regions.
 */
export function normalizeAutoBlurRegions(
  rawRegions: RawAutoBlurDetectionInput[],
  videoDuration: number = 30
): AutoBlurRegion[] {
  if (!Array.isArray(rawRegions) || rawRegions.length === 0) return [];
  const safeDuration = videoDuration > 0 && Number.isFinite(videoDuration) ? videoDuration : 30;

  const candidates: AutoBlurRegion[] = [];

  for (let i = 0; i < rawRegions.length; i++) {
    const r = rawRegions[i];
    if (!r) continue;
    let x = Number(r.x);
    let y = Number(r.y);
    let width = Number(r.width);
    let height = Number(r.height);
    if (![x, y, width, height].every((n) => Number.isFinite(n))) continue;

    // Support 0..1000 normalized boxes if returned by vision models
    if (x > 1.05 || y > 1.05 || width > 1.05 || height > 1.05) {
      x /= 1000;
      y /= 1000;
      width /= 1000;
      height /= 1000;
    }

    if (width < 0.015 || height < 0.012) continue;

    // Add gentle 0.6%–0.8% edge margin to cover text shadows/anti-aliased pixels cleanly
    const padX = 0.008;
    const padY = 0.006;
    const x1 = clamp(x - padX, 0, 0.98);
    const y1 = clamp(y - padY, 0, 0.98);
    const x2 = clamp(x + width + padX, x1 + 0.015, 1.0);
    const y2 = clamp(y + height + padY, y1 + 0.012, 1.0);

    const normW = Math.round((x2 - x1) * 10000) / 10000;
    const normH = Math.round((y2 - y1) * 10000) / 10000;

    // Skip absurdly huge boxes covering >65% of the entire frame (likely a scene false-positive)
    if (normW * normH > 0.65) continue;

    const kind = normalizeRegionKind(r.kind);
    const forceFullDuration =
      r.isStatic === true || kind === 'logo' || kind === 'watermark' || kind === 'graphic';

    let startTime =
      !forceFullDuration && typeof r.startTime === 'number' && Number.isFinite(r.startTime)
        ? clamp(r.startTime, 0, safeDuration)
        : 0;
    let endTime =
      !forceFullDuration && typeof r.endTime === 'number' && Number.isFinite(r.endTime)
        ? clamp(r.endTime, startTime + 0.25, safeDuration)
        : safeDuration;

    if (startTime <= 0.15 && endTime >= safeDuration - 0.15) {
      startTime = 0;
      endTime = safeDuration;
    }

    candidates.push({
      id: `blur_${i + 1}`,
      kind,
      x: Math.round(x1 * 10000) / 10000,
      y: Math.round(y1 * 10000) / 10000,
      width: normW,
      height: normH,
      startTime: Math.round(startTime * 100) / 100,
      endTime: Math.round(endTime * 100) / 100,
      ...(r.label ? { label: String(r.label).trim().slice(0, 60) } : {}),
      ...(typeof r.confidence === 'number'
        ? { confidence: Math.round(clamp(r.confidence, 0, 1) * 100) / 100 }
        : {}),
    });
  }

  // Merge overlapping spatial regions with compatible/contiguous time ranges
  const merged: AutoBlurRegion[] = [];
  for (const item of candidates) {
    let absorbed = false;
    for (let j = 0; j < merged.length; j++) {
      const existing = merged[j];
      const { iou, maxOverlapRatio } = computeIoU(existing, item);
      const spatialMatch = iou >= 0.35 || maxOverlapRatio >= 0.72;
      if (!spatialMatch) continue;

      const sA = existing.startTime ?? 0;
      const eA = existing.endTime ?? safeDuration;
      const sB = item.startTime ?? 0;
      const eB = item.endTime ?? safeDuration;
      const timeGap = Math.max(sA, sB) - Math.min(eA, eB);

      // Merge if time windows overlap or are within 4s (e.g. consecutive subtitle/graphic samples)
      if (timeGap <= 4.0) {
        const nx1 = Math.min(existing.x, item.x);
        const ny1 = Math.min(existing.y, item.y);
        const nx2 = Math.min(1.0, Math.max(existing.x + existing.width, item.x + item.width));
        const ny2 = Math.min(1.0, Math.max(existing.y + existing.height, item.y + item.height));
        merged[j] = {
          ...existing,
          x: Math.round(nx1 * 10000) / 10000,
          y: Math.round(ny1 * 10000) / 10000,
          width: Math.round((nx2 - nx1) * 10000) / 10000,
          height: Math.round((ny2 - ny1) * 10000) / 10000,
          startTime: Math.min(sA, sB),
          endTime: Math.max(eA, eB),
        };
        absorbed = true;
        break;
      }
    }
    if (!absorbed) {
      merged.push(item);
    }
  }

  return merged
    .slice(0, 12)
    .map((m, idx) => ({ ...m, id: `blur_${idx + 1}` }));
}

/**
 * Convert normalized [0..1] regions into strictly frame-bounded pixel rects
 * with even width & height (required for YUV420p FFmpeg crop/boxblur/overlay).
 */
export function toPixelBlurRects(
  regions: AutoBlurRegion[],
  videoWidth: number,
  videoHeight: number
): PixelBlurRect[] {
  if (!Array.isArray(regions) || regions.length === 0) return [];
  const safeW = makeEvenFloor(Math.max(64, Math.round(videoWidth || 1280)));
  const safeH = makeEvenFloor(Math.max(64, Math.round(videoHeight || 720)));
  const minRectDim = 16;

  const rects: PixelBlurRect[] = [];
  for (const r of regions) {
    const rawX = clamp(r.x, 0, 1) * safeW;
    const rawY = clamp(r.y, 0, 1) * safeH;
    const rawW = clamp(r.width, 0, 1) * safeW;
    const rawH = clamp(r.height, 0, 1) * safeH;

    const w = Math.min(safeW, Math.max(minRectDim, makeEvenCeil(rawW)));
    const h = Math.min(safeH, Math.max(minRectDim, makeEvenCeil(rawH)));
    const x = clamp(makeEvenFloor(rawX), 0, safeW - w);
    const y = clamp(makeEvenFloor(rawY), 0, safeH - h);

    rects.push({
      id: r.id,
      kind: r.kind,
      x,
      y,
      w,
      h,
      startTime: r.startTime,
      endTime: r.endTime,
    });
  }

  return rects;
}

function formatFfmpegHexColor(hex?: string): string {
  const clean = (hex || '#090D16').replace('#', '').trim();
  const valid = /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : '090D16';
  return `0x${valid}@1.0`;
}

/**
 * Build FFmpeg filter_complex chain for Auto Blur regions (blur, pixelate, or solid)
 * strictly inside video bounds before subtitles are rendered.
 */
export function buildAutoBlurFilterGraph(params: {
  regions: AutoBlurRegion[];
  videoWidth: number;
  videoHeight: number;
  config?: Partial<AutoBlurConfig> | null;
  inputLabel: string;
  outputLabel?: string;
  videoDuration?: number;
}): { filter: string; outputLabel: string; appliedCount: number } {
  const cfg = sanitizeAutoBlurConfig(params.config);
  const finalOutLabel = params.outputLabel || '[vautoblur]';

  if (!cfg.enabled || !Array.isArray(params.regions) || params.regions.length === 0) {
    return { filter: '', outputLabel: params.inputLabel, appliedCount: 0 };
  }

  const rects = toPixelBlurRects(params.regions, params.videoWidth, params.videoHeight);
  if (rects.length === 0) {
    return { filter: '', outputLabel: params.inputLabel, appliedCount: 0 };
  }

  const dur = params.videoDuration && params.videoDuration > 0 ? params.videoDuration : 0;
  const parts: string[] = [];
  let currentLabel = params.inputLabel;

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const isLast = i === rects.length - 1;
    const nextLabel = isLast ? finalOutLabel : `[vab_${i + 1}]`;

    const hasSubTime =
      typeof rect.startTime === 'number' &&
      typeof rect.endTime === 'number' &&
      rect.endTime > rect.startTime + 0.05 &&
      (rect.startTime > 0.25 || (dur > 0 && rect.endTime < dur - 0.25));

    const enableClause = hasSubTime
      ? `:enable='between(t,${rect.startTime!.toFixed(2)},${rect.endTime!.toFixed(2)})'`
      : '';

    if (cfg.style === 'solid') {
      const color = formatFfmpegHexColor(cfg.solidColor);
      parts.push(
        `${currentLabel}drawbox=x=${rect.x}:y=${rect.y}:w=${rect.w}:h=${rect.h}:color=${color}:t=fill${enableClause}${nextLabel}`
      );
    } else if (cfg.style === 'pixelate') {
      const blockSize = Math.max(4, Math.round(4 + (cfg.strength / 25) * 28));
      const smallW = Math.max(2, Math.floor(rect.w / blockSize));
      const smallH = Math.max(2, Math.floor(rect.h / blockSize));
      const baseLbl = `[vab_b_${i}]`;
      const srcLbl = `[vab_s_${i}]`;
      const fxLbl = `[vab_fx_${i}]`;
      parts.push(
        `${currentLabel}split${baseLbl}${srcLbl};${srcLbl}crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},scale=${smallW}:${smallH}:flags=neighbor,scale=${rect.w}:${rect.h}:flags=neighbor${fxLbl};${baseLbl}${fxLbl}overlay=${rect.x}:${rect.y}${enableClause}${nextLabel}`
      );
    } else {
      // 'blur' via clamped boxblur radius
      const rawRadius = Math.max(2, Math.round(cfg.strength * 1.1));
      const maxRadius = Math.max(1, Math.floor(Math.min(rect.w, rect.h) / 2) - 1);
      const safeRadius = Math.min(rawRadius, maxRadius);
      const baseLbl = `[vab_b_${i}]`;
      const srcLbl = `[vab_s_${i}]`;
      const fxLbl = `[vab_fx_${i}]`;
      parts.push(
        `${currentLabel}split${baseLbl}${srcLbl};${srcLbl}crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},boxblur=${safeRadius}:2${fxLbl};${baseLbl}${fxLbl}overlay=${rect.x}:${rect.y}${enableClause}${nextLabel}`
      );
    }

    currentLabel = nextLabel;
  }

  return {
    filter: parts.join(';') + ';',
    outputLabel: currentLabel,
    appliedCount: rects.length,
  };
}

/**
 * Remap source-timeline AutoBlurRegions onto Dubbing output timeline where speaking segments
 * were speed-adjusted and silence segments stayed at 1.0x speed.
 */
export function remapAutoBlurRegionsForDubbing(
  regions: AutoBlurRegion[],
  segmentTimings: Array<{
    sourceStart: number;
    sourceEnd: number;
    outputStart: number;
    outputEnd: number;
  }>,
  sourceDuration: number,
  outputDuration: number
): AutoBlurRegion[] {
  if (!Array.isArray(regions) || regions.length === 0) return [];
  const safeSrcDur = sourceDuration > 0 ? sourceDuration : 30;
  const safeOutDur = outputDuration > 0 ? outputDuration : safeSrcDur;

  return regions.map((r) => {
    const s = typeof r.startTime === 'number' ? r.startTime : 0;
    const e = typeof r.endTime === 'number' ? r.endTime : safeSrcDur;
    const isFullClip = s <= 0.25 && e >= safeSrcDur - 0.25;
    if (isFullClip || !Array.isArray(segmentTimings) || segmentTimings.length === 0) {
      return {
        ...r,
        startTime: 0,
        endTime: Math.round(safeOutDur * 100) / 100,
      };
    }

    const overlapping = segmentTimings.filter((t) => t.sourceEnd > s && t.sourceStart < e);
    if (overlapping.length === 0) {
      return {
        ...r,
        startTime: 0,
        endTime: Math.round(safeOutDur * 100) / 100,
      };
    }

    const first = overlapping[0];
    const last = overlapping[overlapping.length - 1];
    const outStart = mapTimestampThroughSegment(s, first);
    const outEnd = Math.max(outStart + 0.2, mapTimestampThroughSegment(e, last));

    return {
      ...r,
      startTime: Math.round(clamp(outStart, 0, safeOutDur) * 100) / 100,
      endTime: Math.round(clamp(outEnd, 0, safeOutDur) * 100) / 100,
    };
  });
}

function mapTimestampThroughSegment(
  sourceTime: number,
  seg: { sourceStart: number; sourceEnd: number; outputStart: number; outputEnd: number }
): number {
  const srcSpan = Math.max(0.01, seg.sourceEnd - seg.sourceStart);
  const ratio = clamp((sourceTime - seg.sourceStart) / srcSpan, 0, 1);
  return seg.outputStart + ratio * (seg.outputEnd - seg.outputStart);
}

/**
 * Pure aspect-ratio preserving containment calculation so preview video & blur overlays
 * stay strictly inside original video area with zero stretching.
 */
export function computeAspectPreservedBounds(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number
): { left: number; top: number; width: number; height: number; aspectRatio: number } {
  const cW = Math.max(1, containerWidth);
  const cH = Math.max(1, containerHeight);
  const vW = Math.max(1, videoWidth || 1280);
  const vH = Math.max(1, videoHeight || 720);
  const aspectRatio = vW / vH;
  const containerRatio = cW / cH;

  let width = cW;
  let height = cH;
  if (containerRatio > aspectRatio) {
    height = cH;
    width = cH * aspectRatio;
  } else {
    width = cW;
    height = cW / aspectRatio;
  }

  return {
    left: (cW - width) / 2,
    top: (cH - height) / 2,
    width,
    height,
    aspectRatio,
  };
}
