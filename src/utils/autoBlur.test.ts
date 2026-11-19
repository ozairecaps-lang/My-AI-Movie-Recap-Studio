import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAutoBlurRegions,
  toPixelBlurRects,
  buildAutoBlurFilterGraph,
  remapAutoBlurRegionsForDubbing,
  computeAspectPreservedBounds,
  sanitizeAutoBlurConfig,
  getAutoBlurRenderSignature,
} from './autoBlur';

test('normalizeAutoBlurRegions handles 0..1000 scale, clamps inside [0,1], and merges overlapping static boxes', () => {
  const normalized = normalizeAutoBlurRegions(
    [
      // 0..1000 scale corner logo reported twice across frames
      { kind: 'logo', x: 840, y: 30, width: 140, height: 80, isStatic: true, label: 'Channel Logo' },
      { kind: 'logo', x: 845, y: 32, width: 138, height: 78, isStatic: true, label: 'Channel Logo' },
      // 0..1 scale bottom Chinese subtitle overflowing slightly past 1.0
      { kind: 'text', x: 0.1, y: 0.85, width: 0.95, height: 0.2, startTime: 1, endTime: 4 },
      // Degenerate tiny speck ignored
      { kind: 'text', x: 0.5, y: 0.5, width: 0.004, height: 0.004 },
    ],
    20
  );

  assert.equal(normalized.length, 2);
  for (const r of normalized) {
    assert.ok(r.x >= 0 && r.x <= 1, 'x must be within [0,1]');
    assert.ok(r.y >= 0 && r.y <= 1, 'y must be within [0,1]');
    assert.ok(r.x + r.width <= 1.0001, 'right edge clamped inside video frame');
    assert.ok(r.y + r.height <= 1.0001, 'bottom edge clamped inside video frame');
  }

  const logo = normalized.find((r) => r.kind === 'logo');
  assert.ok(logo);
  assert.equal(logo.startTime, 0);
  assert.equal(logo.endTime, 20);
});

test('toPixelBlurRects produces even dimensions strictly inside video bounds for portrait and landscape', () => {
  const regions = normalizeAutoBlurRegions(
    [
      { kind: 'watermark', x: 0.88, y: 0.9, width: 0.14, height: 0.12, isStatic: true },
      { kind: 'text', x: 0.15, y: 0.72, width: 0.7, height: 0.08, isStatic: true },
    ],
    15
  );

  for (const [w, h] of [
    [1080, 1920],
    [1280, 720],
    [720, 1280],
  ]) {
    const rects = toPixelBlurRects(regions, w, h);
    assert.equal(rects.length, 2);
    for (const r of rects) {
      assert.equal(r.w % 2, 0, 'width must be even for YUV420p');
      assert.equal(r.h % 2, 0, 'height must be even for YUV420p');
      assert.ok(r.x >= 0 && r.x + r.w <= w, `rect X fits inside ${w}`);
      assert.ok(r.y >= 0 && r.y + r.h <= h, `rect Y fits inside ${h}`);
    }
  }
});

test('buildAutoBlurFilterGraph builds blur, pixelate, and solid filters and respects disabled toggle', () => {
  const regions = normalizeAutoBlurRegions(
    [
      { kind: 'watermark', x: 0.75, y: 0.05, width: 0.2, height: 0.08, isStatic: true },
      { kind: 'text', x: 0.15, y: 0.8, width: 0.7, height: 0.1, startTime: 2.0, endTime: 5.5 },
    ],
    10
  );

  // Disabled returns pass-through
  const off = buildAutoBlurFilterGraph({
    regions,
    videoWidth: 1280,
    videoHeight: 720,
    config: { enabled: false, strength: 15, style: 'blur' },
    inputLabel: '[0:v]',
    videoDuration: 10,
  });
  assert.equal(off.filter, '');
  assert.equal(off.outputLabel, '[0:v]');
  assert.equal(off.appliedCount, 0);

  // Blur style uses clamped boxblur + overlay + timed enable on second region
  const blurRes = buildAutoBlurFilterGraph({
    regions,
    videoWidth: 1280,
    videoHeight: 720,
    config: { enabled: true, strength: 20, style: 'blur' },
    inputLabel: '[0:v]',
    outputLabel: '[vblurred]',
    videoDuration: 10,
  });
  assert.equal(blurRes.appliedCount, 2);
  assert.equal(blurRes.outputLabel, '[vblurred]');
  assert.ok(blurRes.filter.includes('boxblur='));
  assert.ok(blurRes.filter.includes('overlay='));
  assert.ok(blurRes.filter.includes("enable='between(t,2.00,5.50)'"));

  // Pixelate style uses neighbor scaling
  const pixRes = buildAutoBlurFilterGraph({
    regions,
    videoWidth: 1280,
    videoHeight: 720,
    config: { enabled: true, strength: 14, style: 'pixelate' },
    inputLabel: '[0:v]',
    outputLabel: '[vpix]',
    videoDuration: 10,
  });
  assert.ok(pixRes.filter.includes('flags=neighbor'));
  assert.ok(pixRes.filter.includes('[vpix]'));

  // Solid color style uses drawbox without split
  const solidRes = buildAutoBlurFilterGraph({
    regions,
    videoWidth: 1280,
    videoHeight: 720,
    config: { enabled: true, strength: 12, style: 'solid', solidColor: '#101827' },
    inputLabel: '[0:v]',
    outputLabel: '[vsolid]',
    videoDuration: 10,
  });
  assert.ok(solidRes.filter.includes('drawbox='));
  assert.ok(solidRes.filter.includes('0x101827@1.0:t=fill'));
  assert.ok(!solidRes.filter.includes('split'));
});

test('remapAutoBlurRegionsForDubbing keeps static logos full-length and remaps timed text across speed-adjusted segments', () => {
  const regions = normalizeAutoBlurRegions(
    [
      { kind: 'logo', x: 0.8, y: 0.05, width: 0.15, height: 0.08, isStatic: true },
      { kind: 'text', x: 0.2, y: 0.82, width: 0.6, height: 0.08, startTime: 2.0, endTime: 5.0 },
    ],
    10
  );

  const remapped = remapAutoBlurRegionsForDubbing(
    regions,
    [
      { sourceStart: 0, sourceEnd: 2, outputStart: 0, outputEnd: 2 },
      { sourceStart: 2, sourceEnd: 5, outputStart: 2, outputEnd: 6.5 }, // slowed down speaking
      { sourceStart: 5, sourceEnd: 10, outputStart: 6.5, outputEnd: 11.5 }, // 1.0x silence
    ],
    10,
    11.5
  );

  assert.equal(remapped[0].startTime, 0);
  assert.equal(remapped[0].endTime, 11.5);
  assert.equal(remapped[1].startTime, 2);
  assert.equal(remapped[1].endTime, 6.5);
});

test('computeAspectPreservedBounds preserves original video aspect ratio without stretching', () => {
  // 9:16 portrait video inside 16:9 container
  const portraitInLandscape = computeAspectPreservedBounds(1600, 900, 1080, 1920);
  assert.ok(Math.abs(portraitInLandscape.width / portraitInLandscape.height - 9 / 16) < 0.001);
  assert.equal(portraitInLandscape.height, 900);
  assert.ok(portraitInLandscape.left > 0);
  assert.equal(portraitInLandscape.top, 0);

  // Sanitization & render signature determinism
  const cfg = sanitizeAutoBlurConfig({ enabled: true, strength: 99, style: 'pixelate' });
  assert.equal(cfg.strength, 25);
  assert.equal(getAutoBlurRenderSignature(cfg, 3), 'on:pixelate:25:#090D16:3');
});
