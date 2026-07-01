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
  /**
   * Called with the live WebGL canvas when the renderer is ready, and with null
   * when it is torn down. Lets the recording workflow capture the exact canvas.
   */
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
}

// Fast attack / slow release smoothing so reactions snap in and fade out.
const SMOOTHING_ATTACK  = 0.35;
const SMOOTHING_RELEASE = 0.055;

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
  kaleidoscope, kaleidoscopeSegments, onCanvasReady,
}: VisualizerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // Read callbacks / props through refs so the single-run effect never restarts.
  const onCanvasReadyRef        = useRef(onCanvasReady);
  const lowRef                  = useRef(low);
  const midRef                  = useRef(mid);
  const highRef                 = useRef(high);
  const settingsRef             = useRef(settings);
  const visualSettingsRef       = useRef(visualSettings);
  const templateIdRef           = useRef(templateId);
  const kaleidoscopeRef         = useRef(kaleidoscope);
  const kaleidoscopeSegmentsRef = useRef(kaleidoscopeSegments);

  onCanvasReadyRef.current        = onCanvasReady;
  lowRef.current                  = low;
  midRef.current                  = mid;
  highRef.current                 = high;
  settingsRef.current             = settings;
  visualSettingsRef.current       = visualSettings;
  templateIdRef.current           = templateId;
  kaleidoscopeRef.current         = kaleidoscope;
  kaleidoscopeSegmentsRef.current = kaleidoscopeSegments;

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // cap DPR
    renderer.setClearColor(0x03040a, 1);
    wrapper.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
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
      const width  = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const aspect = width / height;

      renderer.setSize(width, height, false);
      camera.aspect = aspect;

      const depthScale = visualSettingsRef.current.depth / 100;
      halfD = BASE_HALF_D * depthScale;
      halfH = BASE_HALF_H;
      halfW = BASE_HALF_H * Math.max(1, aspect);

      shared.uVolume.value.set(halfW, halfH, halfD);

      camera.position.set(0, 0, halfD + CAM_MARGIN);
      camera.lookAt(0, 0, 0);
      camera.far = halfD * 2 + CAM_MARGIN + 200;
      camera.updateProjectionMatrix();

      const fovRad = (FOV * Math.PI) / 180;
      shared.uPixelScale.value = renderer.domElement.height / (2 * Math.tan(fovRad / 2));

      // Match the render target to the drawing-buffer size, and give the post
      // shader the canvas aspect for correct radial folding.
      const dpr = renderer.getPixelRatio();
      renderTarget.setSize(Math.max(1, Math.floor(width * dpr)), Math.max(1, Math.floor(height * dpr)));
      postMaterial.uniforms.uResolution.value.set(width, height);

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
    let lastTime = performance.now();
    let rafId = 0;
    // Reused each frame to avoid per-frame object allocation.
    const audioLevels: AudioLevels = { low: 0, mid: 0, high: 0 };

    function animate(): void {
      const vs = visualSettingsRef.current;
      const s  = settingsRef.current;

      // Template or density change → rebuild once (dispose old, no new context).
      if (templateIdRef.current !== currentTemplate || vs.density !== currentDensity) {
        currentTemplate = templateIdRef.current;
        currentDensity  = vs.density;
        rebuildTemplate();
      }

      // Depth change → re-frame volume + camera + notify template.
      if (vs.depth !== lastDepth) {
        lastDepth = vs.depth;
        applyFraming();
      }

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
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden rounded-xl">
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
