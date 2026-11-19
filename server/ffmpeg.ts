import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import {
  SubtitleStyleConfig,
  SubtitleCue,
  parseSrtContent,
  generateSrtContent,
  generateAssContent,
  breakBurmeseLines,
} from '../src/utils/subtitle';
import { buildAtempoFilter } from '../src/utils/speed';
import {
  AutoBlurConfig,
  AutoBlurRegion,
  buildAutoBlurFilterGraph,
  remapAutoBlurRegionsForDubbing,
} from '../src/utils/autoBlur';

const execFileAsync = util.promisify(execFile);

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  format: string;
  hasAudio: boolean;
}

function parseFrameRate(raw?: string): number {
  if (!raw) return 30;
  if (raw.includes('/')) {
    const [numStr, denStr] = raw.split('/');
    const num = parseFloat(numStr);
    const den = parseFloat(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const fps = num / den;
      if (fps >= 12 && fps <= 120) return Math.round(fps * 100) / 100;
    }
  } else {
    const fps = parseFloat(raw);
    if (Number.isFinite(fps) && fps >= 12 && fps <= 120) {
      return Math.round(fps * 100) / 100;
    }
  }
  return 30;
}

/**
 * Probe video metadata using ffprobe
 */
export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=width,height,duration,codec_type,r_frame_rate:format=duration,format_name',
      '-of',
      'json',
      videoPath,
    ]);

    const data = JSON.parse(stdout);
    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video') || {};
    const hasAudio = Boolean(data.streams?.some((s: any) => s.codec_type === 'audio'));
    const format = data.format || {};

    const duration = parseFloat(videoStream.duration || format.duration || '0');
    const width = parseInt(videoStream.width || '1280', 10);
    const height = parseInt(videoStream.height || '720', 10);
    const fps = parseFrameRate(videoStream.r_frame_rate);

    return {
      duration: isNaN(duration) ? 0 : duration,
      width,
      height,
      fps,
      format: format.format_name || 'mp4',
      hasAudio,
    };
  } catch (err: any) {
    console.warn('ffprobe error:', err.message);
    return {
      duration: 30,
      width: 1280,
      height: 720,
      fps: 30,
      format: 'mp4',
      hasAudio: false,
    };
  }
}

/**
 * Extract audio from video file to 16kHz mono MP3 for speech recognition
 */
export async function extractAudio(
  videoPath: string,
  audioOutputPath: string,
  signal?: AbortSignal
): Promise<void> {
  const dir = path.dirname(audioOutputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-b:a',
      '64k',
      audioOutputPath,
    ],
    { signal }
  );
}

/**
 * Extract representative keyframes from video for OCR and scene analysis
 */
export async function extractFrames(
  videoPath: string,
  outputDir: string,
  intervalSeconds: number = 5,
  maxFrames: number = 24,
  signal?: AbortSignal
): Promise<string[]> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const existing = fs.readdirSync(outputDir);
  for (const f of existing) {
    fs.unlinkSync(path.join(outputDir, f));
  }

  const fpsValue = `fps=1/${Math.max(1, intervalSeconds)}`;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      `${fpsValue},scale=640:-1`,
      '-frames:v',
      String(maxFrames),
      path.join(outputDir, 'frame_%04d.jpg'),
    ],
    { signal }
  );

  return fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outputDir, f));
}

/**
 * Split large audio files into smaller overlapping chunks for API limits
 */
export async function splitAudioFile(
  audioPath: string,
  outputDir: string,
  chunkDurationSec: number = 600,
  overlapSec: number = 2
): Promise<Array<{ filePath: string; startTime: number; duration: number }>> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const { duration } = await getVideoMetadata(audioPath);
  const totalDuration = duration > 0 ? duration : 1800;
  const chunks: Array<{ filePath: string; startTime: number; duration: number }> = [];

  let currentStart = 0;
  let chunkIndex = 0;

  while (currentStart < totalDuration) {
    chunkIndex++;
    const actualDuration = Math.min(chunkDurationSec, totalDuration - currentStart);
    const chunkPath = path.join(outputDir, `chunk_${String(chunkIndex).padStart(3, '0')}.mp3`);

    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(currentStart),
      '-i',
      audioPath,
      '-t',
      String(actualDuration),
      '-acodec',
      'copy',
      chunkPath,
    ]);

    chunks.push({
      filePath: chunkPath,
      startTime: currentStart,
      duration: actualDuration,
    });

    currentStart += chunkDurationSec - overlapSec;
  }

  return chunks;
}

/**
 * Normalize uploaded non-MP4 videos (.mov, .mkv, .webm) to browser-playable H.264/AAC MP4
 */
export async function normalizeVideoToMp4(inputPath: string, outputPath: string): Promise<void> {
  const meta = await getVideoMetadata(inputPath);
  const args = [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];
  if (meta.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }
  args.push(outputPath);
  await execFileAsync('ffmpeg', args);
}

/**
 * Combine video, Burmese narration/dubbing audio, optional background music,
 * and Burmese ASS subtitles with arbitrary positioning, background blur, and masking.
 */
export async function renderFinalRecap(params: {
  videoPath: string;
  narrationAudioPath: string;
  bgmAudioPath?: string;
  srtPath?: string;
  outputPath: string;
  originalAudioVolume?: number; // 0 to 1.5
  narrationVolume?: number;     // 0 to 1.5
  bgmVolume?: number;           // 0 to 1.0
  burnSubtitles?: boolean;
  subtitleStyle?: Partial<SubtitleStyleConfig>;
  autoBlur?: {
    regions: AutoBlurRegion[];
    config?: Partial<AutoBlurConfig>;
  };
  signal?: AbortSignal;
}): Promise<{ assPath?: string }> {
  const {
    videoPath,
    narrationAudioPath,
    bgmAudioPath,
    srtPath,
    outputPath,
    originalAudioVolume = 0.15,
    narrationVolume = 1.0,
    bgmVolume = 0.2,
    burnSubtitles = true,
    subtitleStyle,
    autoBlur,
    signal,
  } = params;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const hasSubtitles = Boolean(burnSubtitles && srtPath && fs.existsSync(srtPath));
  const hasNarration = Boolean(narrationAudioPath && fs.existsSync(narrationAudioPath));
  const hasBgm = Boolean(bgmAudioPath && fs.existsSync(bgmAudioPath) && bgmVolume > 0.01);

  const meta = await getVideoMetadata(videoPath);
  const videoDuration = meta.duration > 0 ? meta.duration : 10;
  let narrationDuration = 0;
  if (hasNarration) {
    const narrMeta = await getVideoMetadata(narrationAudioPath);
    narrationDuration = narrMeta.duration > 0 ? narrMeta.duration : 0;
  }

  const targetDuration = hasNarration
    ? Math.max(videoDuration, narrationDuration)
    : videoDuration;
  const padSec = targetDuration > videoDuration + 0.25 ? targetDuration - videoDuration : 0;

  const ffmpegArgs: string[] = ['-y', '-i', videoPath];
  let nextInputIdx = 1;
  let narrationInputIdx = -1;
  let bgmInputIdx = -1;

  if (hasNarration) {
    narrationInputIdx = nextInputIdx++;
    ffmpegArgs.push('-i', narrationAudioPath);
  }
  if (hasBgm && bgmAudioPath) {
    bgmInputIdx = nextInputIdx++;
    ffmpegArgs.push('-stream_loop', '-1', '-i', bgmAudioPath);
  }

  let filterComplex = '';
  let currentVideoLabel = '0:v';
  let mapVideo = '0:v';
  let mapAudio = '0:a';
  let assPathResult: string | undefined;

  const videoWidth = meta.width > 0 ? meta.width : 1080;
  const videoHeight = meta.height > 0 ? meta.height : 1920;

  if (padSec > 0) {
    filterComplex += `[0:v]tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}[vpad];`;
    currentVideoLabel = '[vpad]';
    mapVideo = '[vpad]';
  } else {
    currentVideoLabel = '[0:v]';
  }

  if (autoBlur && autoBlur.regions && autoBlur.regions.length > 0) {
    const ab = buildAutoBlurFilterGraph({
      regions: autoBlur.regions,
      videoWidth,
      videoHeight,
      config: autoBlur.config,
      inputLabel: currentVideoLabel,
      outputLabel: '[vautoblur]',
      videoDuration: targetDuration,
    });
    if (ab.filter) {
      filterComplex += ab.filter;
      currentVideoLabel = ab.outputLabel;
      mapVideo = ab.outputLabel;
    }
  }

  if (hasSubtitles && srtPath) {
    const srtContent = fs.readFileSync(srtPath, 'utf8');
    const cues = parseSrtContent(srtContent);
    const assContent = generateAssContent(cues, videoWidth, videoHeight, subtitleStyle);
    const assPath = path.join(outDir, 'subtitles.ass');
    fs.writeFileSync(assPath, assContent, 'utf8');
    assPathResult = assPath;

    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filterComplex += `${currentVideoLabel}ass='${escapedAss}'[vout];`;
    mapVideo = '[vout]';
  }

  // Audio mixing graph across up to 3 streams: Original + Narration/Dubbing + BGM
  const audioLabels: string[] = [];
  if (meta.hasAudio && originalAudioVolume > 0.01) {
    const padFilter = padSec > 0 ? `,apad=whole_dur=${targetDuration.toFixed(3)}` : '';
    filterComplex += `[0:a]volume=${originalAudioVolume.toFixed(2)}${padFilter}[aorig];`;
    audioLabels.push('[aorig]');
  }
  if (hasNarration && narrationInputIdx !== -1) {
    filterComplex += `[${narrationInputIdx}:a]volume=${narrationVolume.toFixed(2)}[anarr];`;
    audioLabels.push('[anarr]');
  }
  if (hasBgm && bgmInputIdx !== -1) {
    filterComplex += `[${bgmInputIdx}:a]atrim=0:${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${bgmVolume.toFixed(2)}[abgm];`;
    audioLabels.push('[abgm]');
  }

  if (audioLabels.length === 1) {
    mapAudio = audioLabels[0];
  } else if (audioLabels.length > 1) {
    filterComplex += `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=2:normalize=0[aout];`;
    mapAudio = '[aout]';
  } else {
    // Handles both silent source video and intentionally muted original audio (e.g. 0% in Subtitle Mode)
    const nullIdx = nextInputIdx++;
    ffmpegArgs.push('-f', 'lavfi', '-t', targetDuration.toFixed(3), '-i', 'anullsrc=r=44100:cl=mono');
    mapAudio = `${nullIdx}:a`;
  }

  if (filterComplex) {
    ffmpegArgs.push('-filter_complex', filterComplex.replace(/;$/, ''));
  }

  ffmpegArgs.push(
    '-map',
    mapVideo,
    '-map',
    mapAudio,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-t',
    targetDuration.toFixed(3),
    outputPath
  );

  await execFileAsync('ffmpeg', ffmpegArgs, { signal });
  return { assPath: assPathResult };
}

export interface DubbingSegmentRenderInput {
  id: number;
  kind: 'speaking' | 'silence';
  start: number;
  end: number;
  audioPath?: string;
  ttsDuration?: number;
  burmeseText?: string;
}

export interface DubbingSegmentTimingResult {
  id: number;
  kind: 'speaking' | 'silence';
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  videoSpeedFactor: number;
  ttsDuration?: number;
}

/**
 * Assemble final Dubbing MP4 while strictly preserving silence segments at 1.0x speed:
 * - Speaking segments: adjust ONLY speaking video playback speed (setpts) to match AI voice duration.
 * - Silence segments: keep at exact 1.0x original speed with NO AI voice and NO subtitle.
 * - Combine all adjusted speaking segments and original silence segments cleanly into final MP4.
 */
export async function assembleDubbingVideoWithSilencePreserved(params: {
  videoPath: string;
  segments: DubbingSegmentRenderInput[];
  outputPath: string;
  combinedAudioOutputPath: string;
  srtOutputPath: string;
  assOutputPath: string;
  bgmAudioPath?: string;
  originalAudioVolume?: number;
  narrationVolume?: number;
  bgmVolume?: number;
  burnSubtitles?: boolean;
  subtitleStyle?: Partial<SubtitleStyleConfig>;
  autoBlur?: {
    regions: AutoBlurRegion[];
    config?: Partial<AutoBlurConfig>;
  };
  signal?: AbortSignal;
}): Promise<{
  assPath: string;
  srtPath: string;
  audioPath: string;
  cues: SubtitleCue[];
  totalDuration: number;
  segmentTimings: DubbingSegmentTimingResult[];
}> {
  const {
    videoPath,
    segments,
    outputPath,
    combinedAudioOutputPath,
    srtOutputPath,
    assOutputPath,
    bgmAudioPath,
    originalAudioVolume = 0.15,
    narrationVolume = 1.0,
    bgmVolume = 0.2,
    burnSubtitles = true,
    subtitleStyle,
    autoBlur,
    signal,
  } = params;

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const segRenderDir = path.join(outDir, 'dubbing_video_segments');
  if (fs.existsSync(segRenderDir)) {
    fs.rmSync(segRenderDir, { recursive: true, force: true });
  }
  fs.mkdirSync(segRenderDir, { recursive: true });

  const meta = await getVideoMetadata(videoPath);
  const rawW = meta.width > 0 ? meta.width : 1280;
  const rawH = meta.height > 0 ? meta.height : 720;
  const targetW = rawW % 2 === 0 ? rawW : rawW - 1;
  const targetH = rawH % 2 === 0 ? rawH : rawH - 1;
  const targetFps = Math.max(24, Math.min(60, Math.round(meta.fps || 30)));
  const hasBgm = Boolean(bgmAudioPath && fs.existsSync(bgmAudioPath) && bgmVolume > 0.01);

  const orderedSegments = [...segments].sort((a, b) => a.start - b.start);
  const clipFiles: string[] = [];
  const cues: SubtitleCue[] = [];
  const segmentTimings: DubbingSegmentTimingResult[] = [];

  let outputCursor = 0;

  for (let i = 0; i < orderedSegments.length; i++) {
    if (signal?.aborted) throw new Error('JOB_CANCELLED');

    const seg = orderedSegments[i];
    const sourceDur = Math.max(0.08, seg.end - seg.start);
    const clipPath = path.join(segRenderDir, `clip_${String(i + 1).padStart(4, '0')}.mkv`);

    // Fast seek optimization: seek to 2s prior using -copyts so trim=start:end remains 100% frame-accurate
    const fastSeekStart = seg.start > 3.5 ? Math.floor((seg.start - 2.0) * 100) / 100 : 0;
    const seekInputArgs =
      fastSeekStart > 0
        ? ['-ss', String(fastSeekStart), '-copyts', '-i', videoPath]
        : ['-i', videoPath];

    const hasSpeechAudio =
      seg.kind === 'speaking' && Boolean(seg.audioPath && fs.existsSync(seg.audioPath));

    if (!hasSpeechAudio) {
      // SILENCE SEGMENT: Strictly keep original 1.0x speed, NO AI voice, NO subtitle
      const targetDur = sourceDur;
      let filterGraph = `[0:v]trim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(
        4
      )},setpts=PTS-STARTPTS,fps=${targetFps},scale=${targetW}:${targetH},setsar=1,format=yuv420p[v];`;

      if (meta.hasAudio && originalAudioVolume > 0.01) {
        filterGraph += `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(
          4
        )},asetpts=PTS-STARTPTS,volume=${originalAudioVolume.toFixed(
          2
        )},aformat=sample_rates=44100:channel_layouts=stereo,apad=whole_dur=${targetDur.toFixed(
          4
        )},atrim=0:${targetDur.toFixed(4)}[a]`;
      } else {
        filterGraph += `anullsrc=r=44100:cl=stereo:d=${targetDur.toFixed(4)}[a]`;
      }

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          ...seekInputArgs,
          '-filter_complex',
          filterGraph,
          '-map',
          '[v]',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '16',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'pcm_s16le',
          '-t',
          targetDur.toFixed(4),
          clipPath,
        ],
        { signal }
      );

      const clipMeta = await getVideoMetadata(clipPath);
      const actualDur = clipMeta.duration > 0.04 ? clipMeta.duration : targetDur;

      clipFiles.push(clipPath);
      segmentTimings.push({
        id: seg.id,
        kind: 'silence',
        sourceStart: seg.start,
        sourceEnd: seg.end,
        outputStart: Math.round(outputCursor * 1000) / 1000,
        outputEnd: Math.round((outputCursor + actualDur) * 1000) / 1000,
        videoSpeedFactor: 1.0,
      });
      outputCursor += actualDur;
    } else {
      // SPEAKING SEGMENT: Adjust playback speed ONLY of this speaking segment to match AI voice duration
      const ttsMeta = await getVideoMetadata(seg.audioPath!);
      const voiceDur =
        ttsMeta.duration > 0.1
          ? ttsMeta.duration
          : typeof seg.ttsDuration === 'number' && seg.ttsDuration > 0.1
          ? seg.ttsDuration
          : sourceDur;

      const targetDur = Math.max(0.15, voiceDur);
      const ptsScale = targetDur / sourceDur;
      const videoSpeedFactor = Math.round((sourceDur / targetDur) * 1000) / 1000;

      let filterGraph = `[0:v]trim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(
        4
      )},setpts=(PTS-STARTPTS)*${ptsScale.toFixed(
        6
      )},fps=${targetFps},scale=${targetW}:${targetH},setsar=1,format=yuv420p[v];`;

      filterGraph += `[1:a]asetpts=PTS-STARTPTS,volume=${narrationVolume.toFixed(
        2
      )},aformat=sample_rates=44100:channel_layouts=stereo,apad=whole_dur=${targetDur.toFixed(
        4
      )},atrim=0:${targetDur.toFixed(4)}[atts];`;

      let audioMapLabel = '[atts]';
      if (meta.hasAudio && originalAudioVolume > 0.01) {
        const origAtempo =
          Math.abs(videoSpeedFactor - 1.0) >= 0.01 ? buildAtempoFilter(videoSpeedFactor) : '';
        filterGraph += `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(
          4
        )},asetpts=PTS-STARTPTS${origAtempo ? ',' + origAtempo : ''},volume=${originalAudioVolume.toFixed(
          2
        )},aformat=sample_rates=44100:channel_layouts=stereo,apad=whole_dur=${targetDur.toFixed(
          4
        )},atrim=0:${targetDur.toFixed(4)}[aorig];[aorig][atts]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
        audioMapLabel = '[a]';
      }

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          ...seekInputArgs,
          '-i',
          seg.audioPath!,
          '-filter_complex',
          filterGraph.replace(/;$/, ''),
          '-map',
          '[v]',
          '-map',
          audioMapLabel,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '16',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'pcm_s16le',
          '-t',
          targetDur.toFixed(4),
          clipPath,
        ],
        { signal }
      );

      const clipMeta = await getVideoMetadata(clipPath);
      const actualDur = clipMeta.duration > 0.05 ? clipMeta.duration : targetDur;
      const outStart = Math.round(outputCursor * 1000) / 1000;
      const outEnd = Math.round((outputCursor + actualDur) * 1000) / 1000;

      clipFiles.push(clipPath);
      segmentTimings.push({
        id: seg.id,
        kind: 'speaking',
        sourceStart: seg.start,
        sourceEnd: seg.end,
        outputStart: outStart,
        outputEnd: outEnd,
        videoSpeedFactor,
        ttsDuration: Math.round(voiceDur * 1000) / 1000,
      });

      const subText = (seg.burmeseText || '').trim();
      if (subText) {
        cues.push({
          id: cues.length + 1,
          startTime: outStart,
          endTime: outEnd,
          text: breakBurmeseLines(subText, 45),
        });
      }
      outputCursor += actualDur;
    }
  }

  if (clipFiles.length === 0) {
    throw new Error('No video segments generated for Dubbing assembly');
  }

  // Combine all speaking (speed-adjusted) + silence (1.0x original speed) segments losslessly
  const concatListPath = path.join(segRenderDir, 'concat_clips.txt');
  const concatContent = clipFiles
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf8');

  const combinedRawPath = path.join(segRenderDir, 'combined_raw.mkv');
  await execFileAsync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', combinedRawPath],
    { signal }
  );

  // Save combined dubbing audio track (speaking AI voice + preserved silent gaps)
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      combinedRawPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      combinedAudioOutputPath,
    ],
    { signal }
  );

  // Generate SRT & ASS aligned strictly with final combined output timestamps
  const srtContent = generateSrtContent(cues);
  fs.writeFileSync(srtOutputPath, srtContent, 'utf8');

  const assContent = generateAssContent(cues, targetW, targetH, subtitleStyle);
  fs.writeFileSync(assOutputPath, assContent, 'utf8');

  // Final pass: burn subtitles (if enabled) + optional BGM mix -> final_recap.mp4
  const finalArgs: string[] = ['-y', '-i', combinedRawPath];
  if (hasBgm && bgmAudioPath) {
    finalArgs.push('-stream_loop', '-1', '-i', bgmAudioPath);
  }

  let finalFilter = '';
  let currentVideoLabel = '[0:v]';
  let mapVideo = '0:v';
  let mapAudio = '0:a';

  if (autoBlur && autoBlur.regions && autoBlur.regions.length > 0) {
    const remappedRegions = remapAutoBlurRegionsForDubbing(
      autoBlur.regions,
      segmentTimings,
      meta.duration > 0 ? meta.duration : outputCursor,
      outputCursor
    );
    const ab = buildAutoBlurFilterGraph({
      regions: remappedRegions,
      videoWidth: targetW,
      videoHeight: targetH,
      config: autoBlur.config,
      inputLabel: currentVideoLabel,
      outputLabel: '[vautoblur]',
      videoDuration: outputCursor,
    });
    if (ab.filter) {
      finalFilter += ab.filter;
      currentVideoLabel = ab.outputLabel;
      mapVideo = ab.outputLabel;
    }
  }

  if (burnSubtitles && cues.length > 0) {
    const escapedAss = assOutputPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    finalFilter += `${currentVideoLabel}ass='${escapedAss}'[vout];`;
    mapVideo = '[vout]';
  }

  if (hasBgm && bgmAudioPath) {
    finalFilter += `[1:a]atrim=0:${outputCursor.toFixed(
      3
    )},asetpts=PTS-STARTPTS,volume=${bgmVolume.toFixed(
      2
    )}[abgm];[0:a][abgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout];`;
    mapAudio = '[aout]';
  }

  if (finalFilter) {
    finalArgs.push('-filter_complex', finalFilter.replace(/;$/, ''));
  }

  finalArgs.push(
    '-map',
    mapVideo,
    '-map',
    mapAudio,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-t',
    outputCursor.toFixed(3),
    outputPath
  );

  await execFileAsync('ffmpeg', finalArgs, { signal });

  try {
    fs.rmSync(segRenderDir, { recursive: true, force: true });
  } catch {}

  return {
    assPath: assOutputPath,
    srtPath: srtOutputPath,
    audioPath: combinedAudioOutputPath,
    cues,
    totalDuration: Math.round(outputCursor * 1000) / 1000,
    segmentTimings,
  };
}

/**
 * Generate a sample Mandarin Chinese video clip with real spoken audio for quick testing
 */
export async function generateDemoVideo(outputPath: string): Promise<void> {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const demoAudioPath = path.join(dir, 'demo_speech.mp3');
  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const { EdgeTTS } = require('node-edge-tts');
    const tts = new EdgeTTS({ voice: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN' });
    await tts.ttsPromise('三年过去了，你终于回来了。为了守护这座城市，我们必须联手。', demoAudioPath);
  } catch {
    // Fallback tone if EdgeTTS unreachable
  }

  const demoVisualFilter =
    "drawbox=x=940:y=36:w=290:h=56:color=0x1E293B@0.9:t=fill,drawtext=text='DRAMA-TV HD':x=965:y=52:fontsize=24:fontcolor=white,drawbox=x=260:y=585:w=760:h=72:color=0x090D16@0.85:t=fill,drawtext=text='Original Hardcoded Caption':x=(w-text_w)/2:y=608:fontsize=26:fontcolor=yellow";

  if (fs.existsSync(demoAudioPath) && fs.statSync(demoAudioPath).size > 800) {
    const meta = await getVideoMetadata(demoAudioPath);
    const dur = Math.max(6, Math.ceil(meta.duration || 6));
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=#0F172A:s=1280x720:d=${dur}`,
      '-i',
      demoAudioPath,
      '-vf',
      demoVisualFilter,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      outputPath,
    ]);
    try {
      fs.unlinkSync(demoAudioPath);
    } catch {}
  } else {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=8:size=1280x720:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=8',
      '-vf',
      demoVisualFilter,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      outputPath,
    ]);
  }
}
