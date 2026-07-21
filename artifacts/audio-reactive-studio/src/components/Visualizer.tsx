import { useEffect, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  type VisualizerSettings,
  type ParticleVisualSettings,
  type PostEffectSettings,
  type PaletteName,
} from "@/types/visualizer";
import type { VisualTemplateId } from "@/visuals/types";
import type { AnalysisFrame } from "@/lib/audioAnalysis";
import {
  type TemplateRuntime,
  type AudioLevels,
  FOV, CAM_MARGIN, BASE_HALF_D, BASE_HALF_H,
  PALETTES, createSharedUniforms,
} from "@/visuals/shared";
import { getTemplate } from "@/visuals/registry";

export interface VisualizerProps {
  /**
   * Live analysis frame — a mutable ref updated every animation frame by the
   * active analysis hook. Each band carries {level, hit} (both 0–100). The
   * render loop reads it directly each frame so hits stay crisp at full frame
   * rate (React prop updates would quantise them to ~30 Hz).
   */
  audioFrame: RefObject<AnalysisFrame>;
  /** Per-band influence percentages (0–200). */
  settings: VisualizerSettings;
  /**
   * Visual styling settings (density, speed, element size, depth, glow, palette,
   * kaleidoscope on/off, segments, rotation). All kaleidoscope settings live here
   * so Reset Visuals restores the full set in one step.
   */
  visualSettings: ParticleVisualSettings;
  /**
   * Post-processing settings (bloom + exposure). Applied as per-frame pass
   * property/uniform writes — never rebuilds the composer, so they are safe to
   * change live during recording.
   */
  postEffects: PostEffectSettings;
  /** Which visual template to render. Changing this hot-swaps the geometry. */
  templateId: VisualTemplateId;
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
// Hit signals pass through with INSTANT attack (the engine's envelope already
// shapes the rise — extra smoothing here would blunt the transients); only
// downward motion is eased slightly (τ ≈ 60 ms) so a pause / source stop fades
// hit reactions out instead of hard-snapping them to zero.
const HIT_RELEASE_TAU_S = 0.06;

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

// Kaleidoscope + brightness pass (runs inside the EffectComposer, BEFORE bloom
// and the final OutputPass). Every frame in BOTH modes: samples the rendered
// scene, optionally folds it into N mirrored wedges (only when uKaleidoscope is
// on), then applies the global brightness curve. HDR-safe: energy above 1.0 is
// passed through untouched so bloom still sees bright linear highlights.
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
  uniform float uBrightness;     // 0.5–2.0; 1.0 = identity (preserves appearance)
  uniform float uKaleidoscope;   // 1.0 = fold into wedges, 0.0 = straight pass-through
  uniform float uAngleOffset;    // accumulated rotation angle (radians); shifts the
                                 // angular reference frame before the wedge fold so
                                 // the whole kaleidoscope pattern rotates over time
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;

    // Kaleidoscope fold — applied only when enabled, otherwise straight sampling.
    if (uKaleidoscope > 0.5) {
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 p = vUv - 0.5;
      p.x *= aspect;

      float r = length(p);
      float a = atan(p.y, p.x);

      // Apply the accumulated angle offset BEFORE the wedge fold.
      // This shifts the whole angular reference frame, rotating the kaleidoscope
      // effect itself without touching the scene, camera, or canvas transform.
      float seg = 6.2831853071 / uSegments;
      a = mod(a + uAngleOffset, seg);
      a = abs(a - seg * 0.5);    // mirror inside each wedge for a seamless fold

      vec2 dir = vec2(cos(a), sin(a));
      vec2 q = dir * r;
      q.x /= aspect;
      uv = q + 0.5;              // MirroredRepeat wrapping keeps samples continuous
    }

    vec3 c = texture2D(tDiffuse, uv).rgb;

    // Global brightness as a "screen against itself" curve:
    //   out = 1 - (1 - c) ^ brightness
    // At 100% this is exactly identity. Higher values lift shadows and mid-tones
    // the most and taper toward the top; pure black always maps to 0.
    // The curve only makes sense on 0–1 values, so HDR energy above 1.0 (additive
    // blending into the HalfFloat target) is split off and added back afterwards —
    // clamping it away here would starve the bloom pass of its highlights.
    vec3 excess = max(c - 1.0, vec3(0.0));
    vec3 base   = clamp(c, 0.0, 1.0);
    base = 1.0 - pow(1.0 - base, vec3(uBrightness));

    gl_FragColor = vec4(base + excess, 1.0);
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
  audioFrame, settings, visualSettings, postEffects, templateId,
  outputWidth, outputHeight, frameRate,
  onCanvasReady, onPerformanceWarning,
}: VisualizerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // Read callbacks / props through refs so the single-run effect never restarts.
  const onCanvasReadyRef        = useRef(onCanvasReady);
  const onPerformanceWarningRef = useRef(onPerformanceWarning);
  const audioFrameRef           = useRef(audioFrame);
  const settingsRef             = useRef(settings);
  const visualSettingsRef       = useRef(visualSettings);
  const postEffectsRef          = useRef(postEffects);
  const templateIdRef           = useRef(templateId);
  const outputWRef              = useRef(outputWidth);
  const outputHRef              = useRef(outputHeight);
  const frameRateRef            = useRef(frameRate);

  onCanvasReadyRef.current        = onCanvasReady;
  onPerformanceWarningRef.current = onPerformanceWarning;
  audioFrameRef.current           = audioFrame;
  settingsRef.current             = settings;
  visualSettingsRef.current       = visualSettings;
  postEffectsRef.current          = postEffects;
  templateIdRef.current           = templateId;
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
    // ACES filmic tone mapping — applied EXACTLY ONCE by the composer's final
    // OutputPass (custom template ShaderMaterials never include tone-mapping or
    // colour-space chunks, so nothing upstream converts twice). Exposure is a
    // live per-frame write below.
    renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = postEffectsRef.current.exposure;
    renderer.outputColorSpace    = THREE.SRGBColorSpace;
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

    // ── Post-processing pipeline (persistent EffectComposer) ────────────────
    // RenderPass → kaleidoscope/brightness ShaderPass → UnrealBloomPass →
    // OutputPass. Built ONCE; every later change is a pass property / uniform
    // write. The final OutputPass always renders to the same visible canvas
    // (renderer.domElement), so captureStream() records the post-processed image.
    //
    // The composer's ping-pong target is HalfFloatType so additive blending can
    // exceed 1.0 in linear light (bloom feeds on that headroom); samples: 4 keeps
    // MSAA through the off-screen passes; MirroredRepeat wrapping lets the
    // kaleidoscope fold sample outside [0,1] seamlessly (EffectComposer clones
    // this target for its second buffer, wrap settings included).
    const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
      type:      THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples:   4,
    });
    composerTarget.texture.wrapS = THREE.MirroredRepeatWrapping;
    composerTarget.texture.wrapT = THREE.MirroredRepeatWrapping;
    composerTarget.texture.generateMipmaps = false;

    const composer   = new EffectComposer(renderer, composerTarget);
    const renderPass = new RenderPass(scene, camera);
    // Always enabled: it branches on uKaleidoscope internally and also applies
    // the global brightness curve, exactly like the previous manual quad.
    const kaleidoPass = new ShaderPass({
      uniforms: {
        tDiffuse:      { value: null }, // wired to the read buffer by ShaderPass
        uSegments:     { value: visualSettingsRef.current.kaleidoscopeSegments },
        uResolution:   { value: new THREE.Vector2(1, 1) },
        uBrightness:   { value: visualSettingsRef.current.brightness / 100 },
        uKaleidoscope: { value: visualSettingsRef.current.kaleidoscope ? 1 : 0 },
        uAngleOffset:  { value: 0 },
      },
      vertexShader:   POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
    });
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      postEffectsRef.current.bloomStrength,
      postEffectsRef.current.bloomRadius,
      postEffectsRef.current.bloomThreshold,
    );
    bloomPass.enabled = postEffectsRef.current.bloomEnabled;
    // OutputPass applies renderer.toneMapping (ACES) + linear→sRGB conversion —
    // the ONLY place in the chain where either happens.
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(kaleidoPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);

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

      // Composer buffers (and every pass, bloom included — composer.setSize
      // fans out to pass.setSize) match the EXACT output dimensions; DPR is
      // never multiplied in.
      composer.setSize(outW, outH);
      kaleidoPass.uniforms.uResolution.value.set(outW, outH);

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
    let hitLow  = 0;
    let hitMid  = 0;
    let hitHigh = 0;
    let lastPalette: PaletteName = visualSettingsRef.current.palette;
    let lastDepth = visualSettingsRef.current.depth;
    let lastOutputW = outputWRef.current;
    let lastOutputH = outputHRef.current;
    let lastTime = performance.now();
    let rafId = 0;
    // Kaleidoscope rotation — accumulated angle (radians). Updated each frame
    // via delta-time so rotation is frame-rate independent. Never reset by
    // direction/speed changes; kept in a closure var so React state is never
    // written from inside requestAnimationFrame.
    let kAngle = 0;
    // Radians/second at 100 % speed — visibly clear but not overwhelming.
    const K_BASE_RATE = 0.5;
    // Reused each frame to avoid per-frame object allocation.
    const audioLevels: AudioLevels = { low: 0, mid: 0, high: 0, lowHit: 0, midHit: 0, highHit: 0 };

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

      const now = performance.now();
      const dt  = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      shared.uTime.value += dt;

      // Influence scaling applies to BOTH signals of a band: at 0 % the band
      // has no effect at all (level and hit alike); at 200 % both are doubled.
      const frame = audioFrameRef.current.current;
      const tLow  = Math.min(1, Math.max(0, frame.low.level  / 100)) * (s.low  / 100);
      const tMid  = Math.min(1, Math.max(0, frame.mid.level  / 100)) * (s.mid  / 100);
      const tHigh = Math.min(1, Math.max(0, frame.high.level / 100)) * (s.high / 100);
      smoothedLow  = expSmooth(smoothedLow,  tLow);
      smoothedMid  = expSmooth(smoothedMid,  tMid);
      smoothedHigh = expSmooth(smoothedHigh, tHigh);

      // Hits: instant attack, eased release (see HIT_RELEASE_TAU_S above).
      const tLowHit  = Math.min(1, Math.max(0, frame.low.hit  / 100)) * (s.low  / 100);
      const tMidHit  = Math.min(1, Math.max(0, frame.mid.hit  / 100)) * (s.mid  / 100);
      const tHighHit = Math.min(1, Math.max(0, frame.high.hit / 100)) * (s.high / 100);
      const hitRel = 1 - Math.exp(-dt / HIT_RELEASE_TAU_S);
      hitLow  = tLowHit  >= hitLow  ? tLowHit  : hitLow  + (tLowHit  - hitLow)  * hitRel;
      hitMid  = tMidHit  >= hitMid  ? tMidHit  : hitMid  + (tMidHit  - hitMid)  * hitRel;
      hitHigh = tHighHit >= hitHigh ? tHighHit : hitHigh + (tHighHit - hitHigh) * hitRel;

      shared.uLow.value         = smoothedLow;
      shared.uMid.value         = smoothedMid;
      shared.uHigh.value        = smoothedHigh;
      shared.uLowHit.value      = hitLow;
      shared.uMidHit.value      = hitMid;
      shared.uHighHit.value     = hitHigh;
      shared.uSpeed.value       = vs.speed / 100;
      shared.uElementSize.value = vs.elementSize / 100;
      shared.uGlow.value        = vs.glow / 100;

      audioLevels.low     = smoothedLow;
      audioLevels.mid     = smoothedMid;
      audioLevels.high    = smoothedHigh;
      audioLevels.lowHit  = hitLow;
      audioLevels.midHit  = hitMid;
      audioLevels.highHit = hitHigh;
      runtime.onFrame?.(shared.uTime.value, dt, audioLevels);

      // Single composer path for BOTH modes: RenderPass → kaleidoscope/brightness
      // → bloom → OutputPass (ACES + sRGB, once). All updates below are plain
      // pass-property / uniform writes — no composer or pass is ever rebuilt, no
      // per-frame allocation — and the final image always lands on
      // renderer.domElement so captureStream() records exactly what the user
      // sees, including live post-effect tweaks made during recording.
      kaleidoPass.uniforms.uKaleidoscope.value = vs.kaleidoscope ? 1 : 0;
      kaleidoPass.uniforms.uSegments.value     = Math.max(2, vs.kaleidoscopeSegments);
      kaleidoPass.uniforms.uBrightness.value   = Math.max(0.01, vs.brightness / 100);

      const pe = postEffectsRef.current;
      bloomPass.enabled            = pe.bloomEnabled;
      bloomPass.strength           = pe.bloomStrength;
      bloomPass.radius             = pe.bloomRadius;
      bloomPass.threshold          = pe.bloomThreshold;
      renderer.toneMappingExposure = pe.exposure; // read by OutputPass each render

      // Advance the kaleidoscope angle offset. The angle accumulates in a closure
      // variable (never React state) so writes never re-render the component.
      // When rotate is off we simply skip the add — the angle freezes at its
      // current value, keeping the current rotated view instead of snapping to 0.
      if (vs.kaleidoscope && vs.kaleidoscopeRotate) {
        const sign = vs.kaleidoscopeDirection === "clockwise" ? 1 : -1;
        kAngle += sign * (vs.kaleidoscopeSpeed / 100) * K_BASE_RATE * dt;
        // Keep the angle in [-2π, 2π] so floating-point precision never degrades
        // in long sessions. The fold is periodic so the visual is identical.
        if (kAngle >  Math.PI * 2) kAngle -= Math.PI * 2;
        if (kAngle < -Math.PI * 2) kAngle += Math.PI * 2;
      }
      kaleidoPass.uniforms.uAngleOffset.value = kAngle;
      composer.render();
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
      // Dispose every pass (ShaderPass frees its material/quad, UnrealBloomPass
      // its internal mip targets/materials), then the composer's own ping-pong
      // render targets. renderPass has no GPU resources of its own.
      kaleidoPass.dispose();
      bloomPass.dispose();
      outputPass.dispose();
      composer.dispose();
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
