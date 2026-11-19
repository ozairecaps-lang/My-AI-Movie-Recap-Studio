import React, { useEffect, useRef } from 'react';
import {
  AutoBlurConfig,
  AutoBlurRegion,
  DEFAULT_AUTO_BLUR_CONFIG,
  sanitizeAutoBlurConfig,
} from '../utils/autoBlur';
import { SubtitleStyleConfig } from '../utils/subtitle';

interface BlurredVideoPreviewProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  videoWidth: number;
  videoHeight: number;
  autoBlurRegions: AutoBlurRegion[];
  autoBlurConfig: AutoBlurConfig;
  applyLiveCanvasBlur: boolean;
  activePreviewSubtitle: string | null;
  showSubtitleOverlay: boolean;
  subtitleStyle: SubtitleStyleConfig;
  onLoadedMetadata?: (width: number, height: number, duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
}

/**
 * Aspect-ratio preserving video player with background Auto Blur preview compositor.
 * Never stretches video, never renders mask boxes, outlines, resize handles, or drag UI.
 */
export const BlurredVideoPreview: React.FC<BlurredVideoPreviewProps> = ({
  videoRef,
  src,
  videoWidth,
  videoHeight,
  autoBlurRegions,
  autoBlurConfig,
  applyLiveCanvasBlur,
  activePreviewSubtitle,
  showSubtitleOverlay,
  subtitleStyle,
  onLoadedMetadata,
  onTimeUpdate,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const safeCfg = sanitizeAutoBlurConfig(autoBlurConfig || DEFAULT_AUTO_BLUR_CONFIG);

  const aspectW = Math.max(1, videoWidth || 1280);
  const aspectH = Math.max(1, videoHeight || 720);
  const isPortrait = aspectH > aspectW;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let rafId: number | null = null;
    let disposed = false;

    const renderBlurFrame = () => {
      if (disposed) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const vW = video.videoWidth || aspectW;
      const vH = video.videoHeight || aspectH;
      if (canvas.width !== vW || canvas.height !== vH) {
        canvas.width = vW;
        canvas.height = vH;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (
        !applyLiveCanvasBlur ||
        !safeCfg.enabled ||
        autoBlurRegions.length === 0 ||
        video.readyState < 2
      ) {
        return;
      }

      const t = video.currentTime || 0;
      const activeRegions = autoBlurRegions.filter((r) => {
        const s = typeof r.startTime === 'number' ? r.startTime : 0;
        const e = typeof r.endTime === 'number' ? r.endTime : Number.POSITIVE_INFINITY;
        return t >= s - 0.05 && t <= e + 0.05;
      });

      if (activeRegions.length === 0) return;

      for (const region of activeRegions) {
        const rx = Math.max(0, Math.min(vW - 8, Math.floor(region.x * vW)));
        const ry = Math.max(0, Math.min(vH - 8, Math.floor(region.y * vH)));
        const rw = Math.max(8, Math.min(vW - rx, Math.ceil(region.width * vW)));
        const rh = Math.max(8, Math.min(vH - ry, Math.ceil(region.height * vH)));

        if (safeCfg.style === 'solid') {
          ctx.save();
          ctx.fillStyle = safeCfg.solidColor || '#090D16';
          ctx.fillRect(rx, ry, rw, rh);
          ctx.restore();
        } else if (safeCfg.style === 'pixelate') {
          if (!offscreenCanvasRef.current) {
            offscreenCanvasRef.current = document.createElement('canvas');
          }
          const off = offscreenCanvasRef.current;
          const blockSize = Math.max(4, Math.round(4 + (safeCfg.strength / 25) * 28));
          const smallW = Math.max(2, Math.floor(rw / blockSize));
          const smallH = Math.max(2, Math.floor(rh / blockSize));
          if (off.width !== smallW || off.height !== smallH) {
            off.width = smallW;
            off.height = smallH;
          }
          const octx = off.getContext('2d');
          if (octx) {
            octx.imageSmoothingEnabled = true;
            octx.clearRect(0, 0, smallW, smallH);
            octx.drawImage(video, rx, ry, rw, rh, 0, 0, smallW, smallH);
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(off, 0, 0, smallW, smallH, rx, ry, rw, rh);
            ctx.restore();
          }
        } else {
          // Smooth 'blur' clipped strictly to detected region inside original video frame
          const blurPx = Math.max(2, Math.round(safeCfg.strength * 1.15));
          const pad = Math.min(24, blurPx * 2);
          const sx = Math.max(0, rx - pad);
          const sy = Math.max(0, ry - pad);
          const sw = Math.min(vW - sx, rw + pad * 2);
          const sh = Math.min(vH - sy, rh + pad * 2);

          ctx.save();
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          ctx.clip();
          ctx.filter = `blur(${blurPx}px)`;
          ctx.drawImage(video, sx, sy, sw, sh, sx, sy, sw, sh);
          ctx.restore();
        }
      }
    };

    const tick = () => {
      if (disposed) return;
      renderBlurFrame();
      if (!video.paused && !video.ended) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    };

    const onRedraw = () => {
      renderBlurFrame();
    };

    let initRetryTimer: number | null = null;
    const ensureInitialFrame = () => {
      if (disposed) return;
      renderBlurFrame();
      if (applyLiveCanvasBlur && safeCfg.enabled && autoBlurRegions.length > 0 && video.readyState < 2) {
        initRetryTimer = window.setTimeout(ensureInitialFrame, 120);
      }
    };

    ensureInitialFrame();
    video.addEventListener('play', onPlay);
    video.addEventListener('seeked', onRedraw);
    video.addEventListener('loadedmetadata', onRedraw);
    video.addEventListener('loadeddata', onRedraw);
    video.addEventListener('canplay', onRedraw);
    video.addEventListener('timeupdate', onRedraw);

    if (!video.paused && !video.ended) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (initRetryTimer !== null) window.clearTimeout(initRetryTimer);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('seeked', onRedraw);
      video.removeEventListener('loadedmetadata', onRedraw);
      video.removeEventListener('loadeddata', onRedraw);
      video.removeEventListener('canplay', onRedraw);
      video.removeEventListener('timeupdate', onRedraw);
    };
  }, [
    src,
    aspectW,
    aspectH,
    applyLiveCanvasBlur,
    safeCfg.enabled,
    safeCfg.style,
    safeCfg.strength,
    safeCfg.solidColor,
    autoBlurRegions,
    videoRef,
  ]);

  return (
    <div className="rounded-2xl bg-black border border-white/10 overflow-hidden flex items-center justify-center p-0">
      {/* Inner wrapper strictly locked to original video aspect ratio so overlays stay inside video pixels without stretching */}
      <div
        className="relative max-w-full max-h-[70vh] mx-auto bg-black overflow-hidden"
        style={{
          aspectRatio: `${aspectW} / ${aspectH}`,
          width: isPortrait ? 'auto' : '100%',
          height: isPortrait ? 'min(70vh, 560px)' : 'auto',
        }}
      >
        <video
          ref={videoRef}
          src={src}
          preload="auto"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            onLoadedMetadata?.(v.videoWidth, v.videoHeight, v.duration);
          }}
          onTimeUpdate={(e) => {
            onTimeUpdate?.(e.currentTarget.currentTime);
          }}
          controls
          playsInline
          className="w-full h-full object-contain block"
        />

        {/* Non-interactive blurred pixels layer strictly inside the original video frame */}
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {/* Crisp Burmese translated subtitle preview on top of blurred source */}
        {showSubtitleOverlay && activePreviewSubtitle && (
          <div
            className="absolute pointer-events-none px-3"
            style={{
              left: `${subtitleStyle.posX}%`,
              top: `${subtitleStyle.posY}%`,
              transform: 'translate(-50%, -50%)',
              maxWidth: isPortrait ? '88%' : '76%',
            }}
          >
            <div
              className="px-3.5 py-1.5 rounded-lg text-center border border-white/10"
              style={{
                backgroundColor: `rgba(0, 0, 0, ${subtitleStyle.bgMaskOpacity ?? 0.65})`,
              }}
            >
              <p
                className="font-bold text-white leading-snug line-clamp-2"
                style={{
                  fontSize: `${Math.round(14 * (subtitleStyle.fontSizeScale || 1))}px`,
                }}
              >
                {activePreviewSubtitle}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
