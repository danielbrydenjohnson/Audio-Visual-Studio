import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  type VisualizerSettings,
  type ParticleVisualSettings,
  type PaletteName,
  DENSITY_COUNTS,
} from "@/types/visualizer";

// Predictable colours — bypass sRGB working-space conversion so the palette
// hex values render exactly as authored under additive blending.
THREE.ColorManagement.enabled = false;

export interface ParticleFieldProps {
  /** Live raw frequency band values (0–100). */
  low:  number;
  mid:  number;
  high: number;
  /** Per-band influence percentages (0–200). */
  settings: VisualizerSettings;
  /** Visual styling settings (density, speed, size, depth, glow, palette). */
  visualSettings: ParticleVisualSettings;
  /**
   * Called with the live WebGL canvas when the renderer is ready, and with null
   * when it is torn down. Lets the recording workflow capture the exact canvas
   * without fragile DOM queries.
   */
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
}

// ─── Palettes ─────────────────────────────────────────────────────────────────
// Each palette is three colours blended across each particle's colorMix.

const PALETTES: Record<PaletteName, [number, number, number]> = {
  cyanViolet: [0x22d3ee, 0x8b5cf6, 0xec4899],
  monochrome: [0xffffff, 0xcbd5e1, 0x64748b],
  ember:      [0xfbbf24, 0xf97316, 0xdc2626],
};

// ─── Volume constants ─────────────────────────────────────────────────────────

const BASE_HALF_D  = 55;   // half depth at 100 % depth setting
const CAM_MARGIN   = 46;   // camera distance beyond the nearest particle plane
const FOV          = 60;
const BASE_HALF_H  = 52;   // half height of the x/y volume (world units)

// ─── Smoothing (fast attack / slow release) ─────────────────────────────────
const SMOOTHING_ATTACK  = 0.35;
const SMOOTHING_RELEASE = 0.055;

function expSmooth(current: number, target: number): number {
  const coeff = target > current ? SMOOTHING_ATTACK : SMOOTHING_RELEASE;
  return current + (target - current) * coeff;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ─── Shaders ──────────────────────────────────────────────────────────────────
// All per-particle motion + audio reactions happen here. Base position, velocity
// and every affinity are stable attributes; audio reactions are instantaneous
// offsets so they never permanently alter the base positions.

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uParticleSize;
  uniform float uPixelScale;
  uniform float uLow;
  uniform float uMid;
  uniform float uHigh;
  uniform vec3  uVolume;   // half-extents (x, y, z)
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;

  attribute vec3  aVelocity;
  attribute float aBaseSize;
  attribute float aBaseOpacity;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aMoveSpeed;
  attribute float aLowAff;
  attribute float aMidAff;
  attribute float aHighAff;
  attribute float aSparkleThresh;
  attribute float aColorMix;

  varying vec3  vColor;
  varying float vOpacity;

  vec3 paletteColor(float t) {
    return t < 0.5
      ? mix(uColorA, uColorB, t * 2.0)
      : mix(uColorB, uColorC, (t - 0.5) * 2.0);
  }

  void main() {
    // ── Base drift through 3D space (wrapped into the volume) ──────────────
    vec3 p = position + aVelocity * uTime * uSpeed;
    p = mod(p + uVolume, 2.0 * uVolume) - uVolume;

    // ── Organic per-particle float — own phase, speed, direction ──────────
    float t = uTime * aMoveSpeed * uSpeed;
    p += vec3(
      sin(aPhase + t),
      cos(aPhase * 1.3 + t * 0.9),
      sin(aPhase * 0.7 + t * 1.1)
    ) * uVolume * 0.02;

    // ── LOW: heavy, rhythmic — individual outward push + move toward camera ─
    float low = uLow * aLowAff;
    vec3 radial = normalize(p + vec3(0.0001));
    p += radial * low * (uVolume.x * 0.13);
    p.z += low * (uVolume.z * 0.16);

    // ── MID: fluid curved / side-to-side motion, each with its own phase ───
    float mid = uMid * aMidAff;
    float ma = aPhase + uTime * (1.4 + aMoveSpeed * 2.0);
    p.xy += vec2(cos(ma), sin(ma * 1.3)) * mid * (uVolume.x * 0.11);
    p.z  += sin(ma * 0.8) * mid * (uVolume.z * 0.05);

    // ── HIGH: sparkle among a changing subset (per-particle twinkle) ───────
    float tw = fract(sin(aSeed * 91.17 + uTime * (6.0 + aMoveSpeed * 6.0)) * 43758.5453);
    float sparkle = uHigh * aHighAff * step(aSparkleThresh, tw);

    // ── Project ────────────────────────────────────────────────────────────
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.001);

    // Depth brightness: nearer particles brighter, distant dimmer.
    float depthF = clamp((uVolume.z * 2.0 + CAM_NEAR - dist) / (uVolume.z * 2.0), 0.12, 1.0);

    // Size: base * user size * (low swell + sparkle flash), attenuated by depth.
    float size = aBaseSize * uParticleSize * (1.0 + low * 0.9 + sparkle * 1.5);
    gl_PointSize = clamp(size * uPixelScale / dist, 1.0, 64.0);

    gl_Position = projectionMatrix * mv;

    // ── Colour ──────────────────────────────────────────────────────────────
    vec3 col = paletteColor(aColorMix);
    col *= (0.7 + depthF * 0.5);       // depth brightness
    col += col * mid * 0.55;           // MID individual colour modulation
    col += vec3(sparkle) * 0.85;       // HIGH sparkle whitening
    vColor = col;

    vOpacity = clamp(aBaseOpacity * depthF + low * 0.22 + sparkle * 0.75, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform float uGlow;

  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    // Radial point sprite: soft core with a glow halo controlled by uGlow.
    float r = length(gl_PointCoord - 0.5) * 2.0; // 0 at centre, 1 at edge
    float core = smoothstep(1.0, 0.0, r);
    float glowExp = mix(2.6, 0.7, uGlow);        // higher glow → softer, larger halo
    float a = pow(core, glowExp);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor, a * vOpacity);
  }
`;

// ─── Particle attribute generation ──────────────────────────────────────────

interface GeometryBuild {
  geometry: THREE.BufferGeometry;
}

/**
 * Build a fresh BufferGeometry for `count` particles with stable, randomly
 * generated attributes. Most particles get one dominant band (high affinity in
 * one band, low in the others) so the three reactions stay visually distinct,
 * while a little cross-bleed lets a particle react to more than one band.
 */
function buildGeometry(count: number, halfW: number, halfH: number, halfD: number): GeometryBuild {
  const position   = new Float32Array(count * 3);
  const velocity   = new Float32Array(count * 3);
  const baseSize   = new Float32Array(count);
  const baseOpac   = new Float32Array(count);
  const seed       = new Float32Array(count);
  const phase      = new Float32Array(count);
  const moveSpeed  = new Float32Array(count);
  const lowAff     = new Float32Array(count);
  const midAff     = new Float32Array(count);
  const highAff    = new Float32Array(count);
  const sparkleTh  = new Float32Array(count);
  const colorMix   = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    position[i * 3 + 0] = rand(-halfW, halfW);
    position[i * 3 + 1] = rand(-halfH, halfH);
    position[i * 3 + 2] = rand(-halfD, halfD);

    // Random drift direction + speed (world units / sec), incl. z toward/away.
    const dir = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1));
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(rand(1.4, 4.6));
    velocity[i * 3 + 0] = dir.x;
    velocity[i * 3 + 1] = dir.y;
    velocity[i * 3 + 2] = dir.z;

    baseSize[i]  = rand(0.7, 2.3);
    baseOpac[i]  = rand(0.35, 0.9);
    seed[i]      = rand(0, 1000);
    phase[i]     = rand(0, Math.PI * 2);
    moveSpeed[i] = rand(0.3, 1.2);
    sparkleTh[i] = rand(0.6, 0.94);
    colorMix[i]  = Math.random();

    // Affinities: pick a dominant band, give the others a weak baseline.
    let l = rand(0.0, 0.3);
    let m = rand(0.0, 0.3);
    let h = rand(0.0, 0.3);
    const dom = Math.floor(Math.random() * 3);
    if (dom === 0) l = rand(0.72, 1.0);
    else if (dom === 1) m = rand(0.72, 1.0);
    else h = rand(0.72, 1.0);
    lowAff[i]  = l;
    midAff[i]  = m;
    highAff[i] = h;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position",       new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aVelocity",      new THREE.BufferAttribute(velocity, 3));
  geometry.setAttribute("aBaseSize",      new THREE.BufferAttribute(baseSize, 1));
  geometry.setAttribute("aBaseOpacity",   new THREE.BufferAttribute(baseOpac, 1));
  geometry.setAttribute("aSeed",          new THREE.BufferAttribute(seed, 1));
  geometry.setAttribute("aPhase",         new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute("aMoveSpeed",     new THREE.BufferAttribute(moveSpeed, 1));
  geometry.setAttribute("aLowAff",        new THREE.BufferAttribute(lowAff, 1));
  geometry.setAttribute("aMidAff",        new THREE.BufferAttribute(midAff, 1));
  geometry.setAttribute("aHighAff",       new THREE.BufferAttribute(highAff, 1));
  geometry.setAttribute("aSparkleThresh", new THREE.BufferAttribute(sparkleTh, 1));
  geometry.setAttribute("aColorMix",      new THREE.BufferAttribute(colorMix, 1));

  return { geometry };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParticleField({
  low, mid, high, settings, visualSettings, onCanvasReady,
}: ParticleFieldProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  // Read the callback through a ref so the single-run effect never restarts.
  const onCanvasReadyRef = useRef(onCanvasReady);
  onCanvasReadyRef.current = onCanvasReady;

  // Ref bridge — synchronous mirror of all props so the single-run effect reads
  // the latest values every frame without restarting or re-rendering.
  const lowRef            = useRef(low);
  const midRef            = useRef(mid);
  const highRef           = useRef(high);
  const settingsRef       = useRef(settings);
  const visualSettingsRef = useRef(visualSettings);

  lowRef.current            = low;
  midRef.current            = mid;
  highRef.current           = high;
  settingsRef.current       = settings;
  visualSettingsRef.current = visualSettings;

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x03040a, 1); // very dark background
    wrapper.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    onCanvasReadyRef.current?.(renderer.domElement);

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 3000);

    // ── Volume + camera geometry (recomputed on resize / depth change) ──────
    let halfW = BASE_HALF_H;
    let halfH = BASE_HALF_H;
    let halfD = BASE_HALF_D;

    // Uniforms.
    const [cA, cB, cC] = PALETTES[visualSettingsRef.current.palette];
    const uniforms = {
      uTime:         { value: 0 },
      uSpeed:        { value: 1 },
      uParticleSize: { value: 1 },
      uPixelScale:   { value: 600 },
      uLow:          { value: 0 },
      uMid:          { value: 0 },
      uHigh:         { value: 0 },
      uGlow:         { value: visualSettingsRef.current.glow / 100 },
      uVolume:       { value: new THREE.Vector3(halfW, halfH, halfD) },
      uColorA:       { value: new THREE.Color(cA) },
      uColorB:       { value: new THREE.Color(cB) },
      uColorC:       { value: new THREE.Color(cC) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader:   `const float CAM_NEAR = ${CAM_MARGIN.toFixed(1)};\n` + VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent:    true,
      depthWrite:     false,
      depthTest:      false,
      blending:       THREE.AdditiveBlending,
    });

    // ── Points ───────────────────────────────────────────────────────────
    let currentDensity = visualSettingsRef.current.density;
    let build = buildGeometry(DENSITY_COUNTS[currentDensity], halfW, halfH, halfD);
    const points = new THREE.Points(build.geometry, material);
    points.frustumCulled = false; // positions are shader-driven; skip CPU culling
    scene.add(points);

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

      uniforms.uVolume.value.set(halfW, halfH, halfD);

      // Camera sits CAM_MARGIN beyond the nearest particle plane — always
      // outside the volume, so it can never clip into particles.
      camera.position.set(0, 0, halfD + CAM_MARGIN);
      camera.lookAt(0, 0, 0);
      camera.far = halfD * 2 + CAM_MARGIN + 200;
      camera.updateProjectionMatrix();

      // gl_PointSize is in framebuffer pixels — use the drawing-buffer height.
      const fovRad = (FOV * Math.PI) / 180;
      uniforms.uPixelScale.value = renderer.domElement.height / (2 * Math.tan(fovRad / 2));
    }
    applyFraming();

    const ro = new ResizeObserver(() => applyFraming());
    ro.observe(wrapper);

    // ── Smoothed audio (kept entirely inside the loop closure) ─────────────
    let smoothedLow  = 0;
    let smoothedMid  = 0;
    let smoothedHigh = 0;

    let rafId = 0;
    let lastPalette: PaletteName = visualSettingsRef.current.palette;
    let lastDepth = visualSettingsRef.current.depth;
    let lastTime = performance.now();

    function animate(): void {
      const vs = visualSettingsRef.current;
      const s  = settingsRef.current;

      // Density change → rebuild geometry once (no new renderer / loop / RO).
      if (vs.density !== currentDensity) {
        currentDensity = vs.density;
        const old = points.geometry;
        build = buildGeometry(DENSITY_COUNTS[currentDensity], halfW, halfH, halfD);
        points.geometry = build.geometry;
        old.dispose();
      }

      // Depth change → re-frame (updates volume + camera).
      if (vs.depth !== lastDepth) {
        lastDepth = vs.depth;
        applyFraming();
      }

      // Palette change → swap uniform colours (no rebuild).
      if (vs.palette !== lastPalette) {
        lastPalette = vs.palette;
        const [a, b, c] = PALETTES[vs.palette];
        uniforms.uColorA.value.set(a);
        uniforms.uColorB.value.set(b);
        uniforms.uColorC.value.set(c);
      }

      // Smooth each raw band toward its (influence-scaled) target.
      const tLow  = Math.min(1, Math.max(0, lowRef.current  / 100)) * (s.low  / 100);
      const tMid  = Math.min(1, Math.max(0, midRef.current  / 100)) * (s.mid  / 100);
      const tHigh = Math.min(1, Math.max(0, highRef.current / 100)) * (s.high / 100);
      smoothedLow  = expSmooth(smoothedLow,  tLow);
      smoothedMid  = expSmooth(smoothedMid,  tMid);
      smoothedHigh = expSmooth(smoothedHigh, tHigh);

      uniforms.uLow.value         = smoothedLow;
      uniforms.uMid.value         = smoothedMid;
      uniforms.uHigh.value        = smoothedHigh;
      uniforms.uSpeed.value       = vs.speed / 100;
      uniforms.uParticleSize.value = vs.particleSize / 100;
      uniforms.uGlow.value        = vs.glow / 100;
      const now = performance.now();
      uniforms.uTime.value       += Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      renderer.render(scene, camera);
      rafId = requestAnimationFrame(animate);
    }
    rafId = requestAnimationFrame(animate);

    // ── Cleanup ──────────────────────────────────────────────────────────
    return () => {
      onCanvasReadyRef.current?.(null);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      scene.remove(points);
      points.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === wrapper) {
        wrapper.removeChild(renderer.domElement);
      }
    };
  }, []); // runs once — all mutable state lives in the closure / uniforms

  return (
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden rounded-xl">
      {webglFailed && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="text-xs font-mono text-muted-foreground/70 max-w-xs leading-relaxed">
            WebGL isn&apos;t available in this browser or environment, so the 3D
            particle field can&apos;t render here. Try a hardware-accelerated
            browser to see it.
          </p>
        </div>
      )}
    </div>
  );
}
