import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  type VisualizerSettings,
  type ParticleVisualSettings,
  type PaletteName,
} from "@/types/visualizer";
import type { VisualTemplateId } from "@/visuals/types";
import {
  type TemplateRuntime,
  type AudioLevels,
  FOV, CAM_MARGIN, BASE_HALF_D, BASE_HALF_H,
  PALETTES, createSharedUniforms,
} from "@/visuals/shared";
import { getTemplate } from "@/visuals/registry";

export interface VisualizerProps {
  /** Live raw frequency band values (0–100). */
  low:  number;
  mid:  number;
  high: number;
  /** Per-band influence percentages (0–200). */
  settings: VisualizerSettings;
  /** Visual styling settings (density, speed, element size, depth, glow, palette). */
  visualSettings: ParticleVisualSettings;
  /** Which visual template to render. Changing this hot-swaps the geometry. */
  templateId: VisualTemplateId;
  /** Kaleidoscope post-processing on/off (mirrors the scene into radial wedges). */
  kaleidoscope: boolean;
  /** Number of mirrored wedges when kaleidoscope is on. */
  kaleidoscopeSegments: number;
  /** Selected recording width in pixels — the renderer drawing-buffer resolution. */
  outputWidth: number;
  /** Selected recording height in pixels — the renderer drawing-buffer resolution. */
  outputHeight: number;
  /** Selected capture frame rate (30/60) — the perf-warning threshold scales to it. */
  frameRate: number;
  /**
   * Called with the live WebGL canvas when the renderer is ready, and with null
   * when it is torn down. Lets the recording workflow capture the exact canvas.
   */
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
  /**
   * Called (debounced) when sustained render FPS drops below the target, and
   * again when it recovers. Lets the UI show a restrained performance warning
   * without ever auto-changing the user's selected output settings.
   */
  onPerformanceWarning?: (isLow: boolean) => void;
}

// Fast attack / slow release smoothing so reactions snap in and fade out.
const SMOOTHING_ATTACK  = 0.35;
const SMOOTHING_RELEASE = 0.055;

// Performance warning thresholds. Sustained render FPS below a fraction of the
// SELECTED target fps across several one-second windows raises a warning; a
// couple of good windows clears it. This only reports — it never changes the
// user's selected output settings.
const PERF_MIN_RATIO   = 0.75; // warn below 75% of target (45 fps @60, ~22 @30)
const PERF_LOW_SAMPLES = 3;
const PERF_OK_SAMPLES  = 2;

function expSmooth(current: number, target: number): number {
  const coeff = target > current ? SMOOTHING_ATTACK : SMOOTHING_RELEASE;
  return current + (target - current) * coeff;
}

// Fullscreen kaleidoscope pass: fold the rendered scene into N mirrored wedges.
const POST_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;
const POST_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uSegments;
  uniform vec2  uResolution;
  varying vec2 vUv;

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vUv - 0.5;
    p.x *= aspect;

    float r = length(p);
    float a = atan(p.y, p.x);

    float seg = 6.2831853071 / uSegments;
    a = mod(a, seg);
    a = abs(a - seg * 0.5);   // mirror inside each wedge for a seamless fold

    vec2 dir = vec2(cos(a), sin(a));
    vec2 q = dir * r;
    q.x /= aspect;
    vec2 uv = q + 0.5;        // MirroredRepeat wrapping keeps samples continuous

    gl_FragColor = texture2D(tDiffuse, uv);
  }
`;

/**
 * Shared 3D host: owns the single WebGLRenderer, scene, camera, animation loop,
 * ResizeObserver, kaleidoscope post-processing pipeline and canvas. The active
 * template plugs in exactly one THREE.Object3D root (Points, InstancedMesh,
 * LineSegments or a Group). Switching template or density disposes the old root
 * and swaps in the new one WITHOUT recreating the renderer, loop, observer,
 * WebGL context, render target or canvas — so audio playback and the recording
 * capture stream are never interrupted.
 */
export function Visualizer({
  low, mid, high, settings, visualSettings, templateId,
  kaleidoscope, kaleidoscopeSegments, outputWidth, outputHeight, frameRate,
  onCanvasReady, onPerformanceWarning,
}: VisualizerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // Read callbacks / props through refs so the single-run effect never restarts.
  const onCanvasReadyRef        = useRef(onCanvasReady);
  const onPerformanceWarningRef = useRef(onPerformanceWarning);
  const lowRef                  = useRef(low);
  const midRef                  = useRef(mid);
  const highRef                 = useRef(high);
  const settingsRef             = useRef(settings);
  const visualSettingsRef       = useRef(visualSettings);
  const templateIdRef           = useRef(templateId);
  const kaleidoscopeRef         = useRef(kaleidoscope);
  const kaleidoscopeSegmentsRef = useRef(kaleidoscopeSegments);
  const outputWRef              = useRef(outputWidth);
  const outputHRef              = useRef(outputHeight);
  const frameRateRef            = useRef(frameRate);

  onCanvasReadyRef.current        = onCanvasReady;
  onPerformanceWarningRef.current = onPerformanceWarning;
  lowRef.current                  = low;
  midRef.current                  = mid;
  highRef.current                 = high;
  settingsRef.current             = settings;
  visualSettingsRef.current       = visualSettings;
  templateIdRef.current           = templateId;
  kaleidoscopeRef.current         = kaleidoscope;
  kaleidoscopeSegmentsRef.current = kaleidoscopeSegments;
  outputWRef.current              = outputWidth;
  outputHRef.current              = outputHeight;
  frameRateRef.current            = frameRate;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // ── Renderer ───────────────────────────────────────────────────────────
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      setWebglFailed(true);
      onCanvasReadyRef.current?.(null);
      return;
    }
    // pixelRatio is 1 so the drawing buffer equals the EXACT selected output
    // dimensions — captureStream() records those pixels, and the device pixel
    // ratio is never multiplied into the recording resolution. The visible canvas
    // is scaled down purely via CSS (letterbox fit) in applyFraming().
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x03040a, 1);
    wrapper.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    onCanvasReadyRef.current?.(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 3000);

    let halfW = BASE_HALF_H;
    let halfH = BASE_HALF_H;
    let halfD = BASE_HALF_D;

    // ── Shared uniforms (referenced by every template material) ─────────────
    const shared = createSharedUniforms(visualSettingsRef.current, halfW, halfH, halfD);

    // ── Kaleidoscope post-processing pipeline (persistent) ──────────────────
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    renderTarget.texture.wrapS = THREE.MirroredRepeatWrapping;
    renderTarget.texture.wrapT = THREE.MirroredRepeatWrapping;
    renderTarget.texture.generateMipmaps = false;

    const postScene  = new THREE.Scene();
    const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postGeometry = new THREE.PlaneGeometry(2, 2);
    const postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:    { value: renderTarget.texture },
        uSegments:   { value: kaleidoscopeSegmentsRef.current },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader:   POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      depthTest:  false,
      depthWrite: false,
    });
    const postQuad = new THREE.Mesh(postGeometry, postMaterial);
    postScene.add(postQuad);

    // ── Active template runtime ──────────────────────────────────────────────
    let currentTemplate = templateIdRef.current;
    let currentDensity  = visualSettingsRef.current.density;
    let runtime: TemplateRuntime = getTemplate(currentTemplate).create({
      density: currentDensity, halfW, halfH, halfD, shared,
    });
    scene.add(runtime.root);

    // ── Resize / depth framing ──────────────────────────────────────────────
    function applyFraming(): void {
      const rect   = wrapper!.getBoundingClientRect();
      const availW = Math.max(1, rect.width);
      const availH = Math.max(1, rect.height);

      // Drawing buffer = the EXACT selected output dimensions. captureStream()
      // records exactly these pixels; the buffer is never multiplied by DPR.
      const outW = Math.max(1, Math.round(outputWRef.current));
      const outH = Math.max(1, Math.round(outputHRef.current));
      const outputAspect = outW / outH;

      renderer.setSize(outW, outH, false); // updateStyle=false — CSS size set below

      // Letterbox-fit the fixed-aspect canvas inside the available preview area
      // (CSS only — never changes the drawing buffer). The flex wrapper centres it
      // and the surrounding space stays dark, so the preview shows exactly the
      // composition that will be recorded. Resizing the window rescales this fit
      // without changing the selected output dimensions.
      let cssW: number, cssH: number;
      if (availW / availH > outputAspect) { cssH = availH; cssW = availH * outputAspect; }
      else                                { cssW = availW; cssH = availW / outputAspect; }
      renderer.domElement.style.width  = `${cssW}px`;
      renderer.domElement.style.height = `${cssH}px`;

      // Camera uses the OUTPUT aspect (not the preview area's aspect).
      camera.aspect = outputAspect;

      const depthScale = visualSettingsRef.current.depth / 100;
      halfD = BASE_HALF_D * depthScale;
      halfH = BASE_HALF_H;
      // Volume width tracks the frame aspect so every template fills the frame
      // consistently across landscape, portrait and square — one responsive
      // calculation, no per-aspect template code.
      halfW = BASE_HALF_H * outputAspect;

      shared.uVolume.value.set(halfW, halfH, halfD);

      camera.position.set(0, 0, halfD + CAM_MARGIN);
      camera.lookAt(0, 0, 0);
      camera.far = halfD * 2 + CAM_MARGIN + 200;
      camera.updateProjectionMatrix();

      const fovRad = (FOV * Math.PI) / 180;
      shared.uPixelScale.value = renderer.domElement.height / (2 * Math.tan(fovRad / 2));

      // Kaleidoscope render target + post resolution match the output dimensions.
      renderTarget.setSize(outW, outH);
      postMaterial.uniforms.uResolution.value.set(outW, outH);

      runtime.onFraming?.(halfW, halfH, halfD);
    }
    applyFraming();

    const ro = new ResizeObserver(() => applyFraming());
    ro.observe(wrapper);

    // Rebuild the active template (new root/geometry/material, dispose old). Used
    // for both template switches and density changes — never touches renderer,
    // loop, render target or canvas.
    function rebuildTemplate(): void {
      const old = runtime;
      scene.remove(old.root);
      old.dispose();
      runtime = getTemplate(currentTemplate).create({
        density: currentDensity, halfW, halfH, halfD, shared,
      });
      scene.add(runtime.root);
      runtime.onFraming?.(halfW, halfH, halfD);
    }

    // ── Loop state ───────────────────────────────────────────────────────────
    let smoothedLow  = 0;
    let smoothedMid  = 0;
    let smoothedHigh = 0;
    let lastPalette: PaletteName = visualSettingsRef.current.palette;
    let lastDepth = visualSettingsRef.current.depth;
    let lastOutputW = outputWRef.current;
    let lastOutputH = outputHRef.current;
    let lastTime = performance.now();
    let rafId = 0;
    // Reused each frame to avoid per-frame object allocation.
    const audioLevels: AudioLevels = { low: 0, mid: 0, high: 0 };

    // FPS sampling for the debounced performance warning (no per-frame renders).
    let fpsWindowStart  = lastTime;
    let fpsFrames       = 0;
    let lowSampleStreak = 0;
    let okSampleStreak  = 0;
    let perfWarned      = false;

    function animate(): void {
      const vs = visualSettingsRef.current;
      const s  = settingsRef.current;

      let needsRebuild = false;

      // Template or density change → rebuild the root (dispose old, no new context).
      if (templateIdRef.current !== currentTemplate || vs.density !== currentDensity) {
        currentTemplate = templateIdRef.current;
        currentDensity  = vs.density;
        needsRebuild = true;
      }

      // Output-dimensions change → re-frame. A resolution-only change (same aspect)
      // just resizes the buffer + render target; an ASPECT change also rebuilds the
      // template so it redistributes to the new bounds. Either way the persistent
      // renderer / context / canvas / render target are reused, never recreated.
      const ow = outputWRef.current, oh = outputHRef.current;
      if (ow !== lastOutputW || oh !== lastOutputH) {
        const oldAspect = lastOutputW / lastOutputH;
        const newAspect = ow / oh;
        lastOutputW = ow;
        lastOutputH = oh;
        applyFraming();
        if (Math.abs(newAspect - oldAspect) > 1e-3) needsRebuild = true;
      }

      // Depth change → re-frame volume + camera + notify template.
      if (vs.depth !== lastDepth) {
        lastDepth = vs.depth;
        applyFraming();
      }

      if (needsRebuild) rebuildTemplate();

      // Palette change → swap shared colour uniforms (no rebuild).
      if (vs.palette !== lastPalette) {
        lastPalette = vs.palette;
        const [a, b, c] = PALETTES[vs.palette];
        shared.uColorA.value.set(a);
        shared.uColorB.value.set(b);
        shared.uColorC.value.set(c);
      }

      // Smooth each raw band toward its influence-scaled target.
      const tLow  = Math.min(1, Math.max(0, lowRef.current  / 100)) * (s.low  / 100);
      const tMid  = Math.min(1, Math.max(0, midRef.current  / 100)) * (s.mid  / 100);
      const tHigh = Math.min(1, Math.max(0, highRef.current / 100)) * (s.high / 100);
      smoothedLow  = expSmooth(smoothedLow,  tLow);
      smoothedMid  = expSmooth(smoothedMid,  tMid);
      smoothedHigh = expSmooth(smoothedHigh, tHigh);

      shared.uLow.value         = smoothedLow;
      shared.uMid.value         = smoothedMid;
      shared.uHigh.value        = smoothedHigh;
      shared.uSpeed.value       = vs.speed / 100;
      shared.uElementSize.value = vs.elementSize / 100;
      shared.uGlow.value        = vs.glow / 100;

      const now = performance.now();
      const dt  = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      shared.uTime.value += dt;

      audioLevels.low  = smoothedLow;
      audioLevels.mid  = smoothedMid;
      audioLevels.high = smoothedHigh;
      runtime.onFrame?.(shared.uTime.value, dt, audioLevels);

      // Render straight to the canvas, or through the kaleidoscope fold. Either
      // way the final image lands on renderer.domElement, so captureStream() keeps
      // recording exactly what the user sees.
      if (kaleidoscopeRef.current) {
        postMaterial.uniforms.uSegments.value = Math.max(2, kaleidoscopeSegmentsRef.current);
        renderer.setRenderTarget(renderTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(postScene, postCamera);
      } else {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
      }
      // ── Performance sampling → debounced warning (never auto-changes settings) ──
      fpsFrames++;
      const fpsElapsed = now - fpsWindowStart;
      if (fpsElapsed >= 1000) {
        // Skip windows inflated by tab-backgrounding / stalls (would read as 0 fps).
        if (fpsElapsed < 3000) {
          // Threshold scales to the SELECTED target fps (30 vs 60) so a smooth
          // 30 fps session never trips a 60 fps-oriented warning.
          const targetFps = frameRateRef.current > 0 ? frameRateRef.current : 60;
          const minFps    = targetFps * PERF_MIN_RATIO;
          const fps = (fpsFrames * 1000) / fpsElapsed;
          if (fps < minFps) { lowSampleStreak++; okSampleStreak = 0; }
          else              { okSampleStreak++;  lowSampleStreak = 0; }
          if (!perfWarned && lowSampleStreak >= PERF_LOW_SAMPLES) {
            perfWarned = true;
            onPerformanceWarningRef.current?.(true);
          } else if (perfWarned && okSampleStreak >= PERF_OK_SAMPLES) {
            perfWarned = false;
            onPerformanceWarningRef.current?.(false);
          }
        } else {
          // Window inflated by tab-backgrounding / a long stall: discard stale
          // streaks so pre-background samples can't trigger a false warning.
          lowSampleStreak = 0;
          okSampleStreak  = 0;
        }
        fpsFrames      = 0;
        fpsWindowStart = now;
      }

      rafId = requestAnimationFrame(animate);
    }
    rafId = requestAnimationFrame(animate);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      onCanvasReadyRef.current?.(null);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      scene.remove(runtime.root);
      runtime.dispose();
      renderTarget.dispose();
      postGeometry.dispose();
      postMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === wrapper) {
        wrapper.removeChild(renderer.domElement);
      }
    };
  }, []); // runs once — all mutable state lives in the closure / uniforms / refs

  return (
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden rounded-xl bg-black flex items-center justify-center">
      {webglFailed && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="text-xs font-mono text-muted-foreground/70 max-w-xs leading-relaxed">
            WebGL isn&apos;t available in this browser or environment, so the 3D
            visual can&apos;t render here. Try a hardware-accelerated browser to
            see it.
          </p>
        </div>
      )}
    </div>
  );
}
