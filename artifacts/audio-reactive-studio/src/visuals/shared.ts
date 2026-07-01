import * as THREE from "three";
import type { PaletteName, ParticleVisualSettings, DensityLevel } from "@/types/visualizer";
import type { VisualTemplateId } from "@/visuals/types";

// Predictable colours — bypass sRGB working-space conversion so palette hex
// values render exactly as authored under additive blending.
THREE.ColorManagement.enabled = false;

// ─── Camera / volume constants (shared across every template) ────────────────
export const FOV         = 60;
export const CAM_MARGIN  = 46;  // camera distance beyond the nearest particle plane
export const BASE_HALF_D = 55;  // half depth at 100 % depth setting
export const BASE_HALF_H = 52;  // half height of the volume (world units)

// ─── Palettes ────────────────────────────────────────────────────────────────
// Each palette is three colours blended across each element's colorMix. Cyan
// Violet, Monochrome and Ember are the core three; the rest are extras. Every
// template reads these — no template hardcodes its own colours.
export const PALETTES: Record<PaletteName, [number, number, number]> = {
  cyanViolet: [0x22d3ee, 0x8b5cf6, 0xec4899],
  monochrome: [0xffffff, 0xcbd5e1, 0x64748b],
  ember:      [0xfbbf24, 0xf97316, 0xdc2626],
  aurora:     [0x34d399, 0x22d3ee, 0x818cf8],
  sunset:     [0xfacc15, 0xfb7185, 0x8b5cf6],
  oceanic:    [0x38bdf8, 0x2dd4bf, 0x6366f1],
  plasma:     [0x6366f1, 0xec4899, 0xf59e0b],
  neonMint:   [0xa3e635, 0x22d3ee, 0xf0abfc],
  rose:       [0xfda4af, 0xf43f5e, 0x9f1239],
};

// ─── Shared uniforms ──────────────────────────────────────────────────────────
// One set of uniform *objects* is created per Visualizer mount and shared by
// reference into every template material, so updating a value here updates it
// for whichever template is active. CPU-driven templates (cubes, polyhedra,
// wireframes) read the same objects directly each frame.

export interface SharedUniforms {
  uTime:        { value: number };
  uSpeed:       { value: number };
  uElementSize: { value: number };
  uPixelScale:  { value: number };
  uLow:         { value: number };
  uMid:         { value: number };
  uHigh:        { value: number };
  uGlow:        { value: number };
  uVolume:      { value: THREE.Vector3 };
  uColorA:      { value: THREE.Color };
  uColorB:      { value: THREE.Color };
  uColorC:      { value: THREE.Color };
}

export function createSharedUniforms(
  visual: ParticleVisualSettings,
  halfW: number, halfH: number, halfD: number,
): SharedUniforms {
  const [a, b, c] = PALETTES[visual.palette];
  return {
    uTime:        { value: 0 },
    uSpeed:       { value: visual.speed / 100 },
    uElementSize: { value: visual.elementSize / 100 },
    uPixelScale:  { value: 600 },
    uLow:         { value: 0 },
    uMid:         { value: 0 },
    uHigh:        { value: 0 },
    uGlow:        { value: visual.glow / 100 },
    uVolume:      { value: new THREE.Vector3(halfW, halfH, halfD) },
    uColorA:      { value: new THREE.Color(a) },
    uColorB:      { value: new THREE.Color(b) },
    uColorC:      { value: new THREE.Color(c) },
  };
}

// ─── Template contract ────────────────────────────────────────────────────────

export interface AudioLevels {
  low:  number; // smoothed, influence-scaled 0–~2
  mid:  number;
  high: number;
}

export interface TemplateCreateArgs {
  /** Visual density preset — each template maps it to its own element count. */
  density: DensityLevel;
  halfW:   number;
  halfH:   number;
  halfD:   number;
  shared:  SharedUniforms;
}

/**
 * A live template instance. The host owns the renderer/scene/camera/loop; each
 * runtime owns exactly one THREE.Object3D root (which may be Points, an
 * InstancedMesh, LineSegments, or a Group of children) plus any private CPU
 * state (e.g. moving attractors, per-instance buffers).
 */
export interface TemplateRuntime {
  /** The single object added to / removed from the shared scene. */
  root: THREE.Object3D;
  /** Per-frame hook. Shared uniforms (time, audio, speed…) are already set. */
  onFrame?(time: number, dt: number, audio: AudioLevels): void;
  /** Called on resize / depth change with the new volume half-extents. */
  onFraming?(halfW: number, halfH: number, halfD: number): void;
  /** Dispose every geometry, material and template-owned GPU resource. */
  dispose(): void;
}

export interface VisualTemplate {
  readonly id: VisualTemplateId;
  create(args: TemplateCreateArgs): TemplateRuntime;
}

// ─── GLSL building blocks ─────────────────────────────────────────────────────

/** Shared uniform + varying declarations and the palette helper. */
export const GLSL_HEADER = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uElementSize;
  uniform float uPixelScale;
  uniform float uLow;
  uniform float uMid;
  uniform float uHigh;
  uniform float uGlow;
  uniform vec3  uVolume;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;

  varying vec3  vColor;
  varying float vOpacity;

  vec3 paletteColor(float t) {
    return t < 0.5
      ? mix(uColorA, uColorB, t * 2.0)
      : mix(uColorB, uColorC, (t - 0.5) * 2.0);
  }
`;

/** Shared radial point-sprite fragment shader with a glow-controlled halo. */
export const FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  uniform float uGlow;

  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0; // 0 at centre, 1 at edge
    float core = smoothstep(1.0, 0.0, r);
    float glowExp = mix(2.6, 0.7, uGlow);        // higher glow → softer, larger halo
    float a = pow(core, glowExp);
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vColor, a * vOpacity);
  }
`;

/** Flat fragment shader for line segments (no gl_PointCoord). */
export const LINE_FRAGMENT_SHADER = /* glsl */ `
  precision mediump float;

  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    if (vOpacity <= 0.002) discard;
    gl_FragColor = vec4(vColor, vOpacity);
  }
`;

/**
 * Build a ShaderMaterial from a template-specific vertex body (its attributes +
 * main()). The body may use everything declared in GLSL_HEADER plus the
 * CAM_NEAR constant. Shared uniforms are referenced by identity so host updates
 * propagate; `extra` adds template-private uniforms. `fragmentShader` defaults
 * to the point-sprite shader; line templates pass LINE_FRAGMENT_SHADER.
 */
export function makeMaterial(
  vertexBody: string,
  shared: SharedUniforms,
  extra: Record<string, THREE.IUniform> = {},
  fragmentShader: string = FRAGMENT_SHADER,
): THREE.ShaderMaterial {
  const vertexShader =
    `const float CAM_NEAR = ${CAM_MARGIN.toFixed(1)};\n` + GLSL_HEADER + "\n" + vertexBody;
  return new THREE.ShaderMaterial({
    uniforms:       { ...shared, ...extra } as Record<string, THREE.IUniform>,
    vertexShader,
    fragmentShader,
    transparent:    true,
    depthWrite:     false,
    depthTest:      false,
    blending:       THREE.AdditiveBlending,
  });
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Pick one dominant band affinity + weak baselines for the other two. */
export function randomAffinities(): [number, number, number] {
  let l = rand(0.0, 0.3);
  let m = rand(0.0, 0.3);
  let h = rand(0.0, 0.3);
  const dom = Math.floor(Math.random() * 3);
  if (dom === 0) l = rand(0.72, 1.0);
  else if (dom === 1) m = rand(0.72, 1.0);
  else h = rand(0.72, 1.0);
  return [l, m, h];
}

/** Utility to register a Float32 attribute on a geometry. */
export function setF32(geo: THREE.BufferGeometry, name: string, arr: Float32Array, itemSize: number) {
  geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
}

/**
 * CPU-side equivalent of the GLSL paletteColor(): blend three palette colours
 * across t∈[0,1]. Writes into `out` (reused each frame to avoid allocation).
 */
export function paletteMix(
  t: number, a: THREE.Color, b: THREE.Color, c: THREE.Color, out: THREE.Color,
): THREE.Color {
  if (t < 0.5) out.copy(a).lerp(b, t * 2);
  else out.copy(b).lerp(c, (t - 0.5) * 2);
  return out;
}

/** Positive modulo wrap of v into [-half, half]. */
export function wrap(v: number, half: number): number {
  const s = 2 * half;
  return (((v + half) % s) + s) % s - half;
}
