/**
 * Per-band audio influence multipliers.
 * Values are percentages: 0 = the band has no visual effect, 100 = normal
 * reaction, 200 = clearly stronger but still controlled.
 */
export interface VisualizerSettings {
  low:  number; // 0–200 %
  mid:  number; // 0–200 %
  high: number; // 0–200 %
}

export const DEFAULT_SETTINGS: VisualizerSettings = {
  low:  120,
  mid:  100,
  high: 100,
};

// ─── Visual Settings ──────────────────────────────────────────────────────────

/** Visual density preset. Each template maps this to its own element count. */
export type DensityLevel = "low" | "medium" | "high";

/** Named colour palette. Every template reads the active palette (never hardcodes one). */
export type PaletteName =
  | "cyanViolet"
  | "monochrome"
  | "ember"
  | "aurora"
  | "sunset"
  | "oceanic"
  | "plasma"
  | "neonMint"
  | "rose";

/** Kaleidoscope rotation direction. */
export type KaleidoscopeDirection = "clockwise" | "counterclockwise";

/**
 * Visual styling settings shared by every template.
 * Separate from audio influence — resetting one must not affect the other.
 *
 * `density` and `elementSize` are intentionally generic: templates render points,
 * cubes, polyhedra, lines or wireframes, so "density" means element count/complexity
 * and "elementSize" scales point size / mesh scale / line length as appropriate.
 */
export interface ParticleVisualSettings {
  /** Visual density preset — each template maps it to its own count/complexity. */
  density:     DensityLevel;
  /** Base motion-speed multiplier, 25–200 %. */
  speed:       number;
  /** Resting element-size multiplier before audio reactions, 50–200 %. */
  elementSize: number;
  /** Depth of the 3D volume, 50–200 %. Camera stays outside — no clipping. */
  depth:       number;
  /** Colour palette name. */
  palette:     PaletteName;
  /** Glow intensity, 0–100 %. */
  glow:        number;
  /**
   * Global output brightness, 50–200 %. Applied once in the final compositing
   * shader (not per template): 100 % is identity, higher values lift shadows and
   * mid-tones while preserving black and rolling off highlights. Kept separate
   * from Glow — Glow shapes luminous elements, Brightness scales the final image.
   */
  brightness:  number;

  // ── Kaleidoscope post-processing ───────────────────────────────────────────
  /** When true, folds the rendered scene into N mirrored radial wedges. */
  kaleidoscope:          boolean;
  /** Number of mirrored wedges (4 / 6 / 8 / 10 / 12). */
  kaleidoscopeSegments:  number;
  /** When true the kaleidoscope angular mapping rotates continuously over time. */
  kaleidoscopeRotate:    boolean;
  /** Which way the kaleidoscope rotates when rotation is on. */
  kaleidoscopeDirection: KaleidoscopeDirection;
  /** Rotation speed, 0–200 %. 100 % is clearly visible but controlled. */
  kaleidoscopeSpeed:     number;
}

export const DEFAULT_VISUAL_SETTINGS: ParticleVisualSettings = {
  density:     "medium",
  speed:       100,
  elementSize: 100,
  depth:       100,
  palette:     "monochrome",
  glow:        30,
  brightness:  125,

  kaleidoscope:          false,
  kaleidoscopeSegments:  8,
  kaleidoscopeRotate:    false,
  kaleidoscopeDirection: "clockwise",
  kaleidoscopeSpeed:     40,
};

// ─── Post Effects ─────────────────────────────────────────────────────────────

/**
 * Post-processing settings — the EffectComposer stack that runs AFTER the scene
 * (and optional kaleidoscope fold) renders: bloom, then tone-mapped final output.
 * Deliberately separate from both audio settings and ParticleVisualSettings so
 * "Reset Post Effects" touches only these five values and "Reset Visuals" never
 * touches them.
 */
export interface PostEffectSettings {
  /** Master bloom on/off. */
  bloomEnabled:   boolean;
  /** Bloom intensity, 0–3. */
  bloomStrength:  number;
  /** Bloom spread, 0–1. */
  bloomRadius:    number;
  /** Luminance threshold, 0–1 — only areas brighter than this bloom. */
  bloomThreshold: number;
  /** ACES filmic tone-mapping exposure, 0.5–2.0 (1.0 = neutral). */
  exposure:       number;
}

export const DEFAULT_POST_EFFECT_SETTINGS: PostEffectSettings = {
  bloomEnabled:   true,
  bloomStrength:  0.8,
  bloomRadius:    0.35,
  bloomThreshold: 0.15,
  exposure:       1.0,
};

/**
 * Point-template density preset → element count.
 * Used by the points-based Fibonacci Spiral. Mesh/line templates define their
 * own counts (InstancedMesh and LineSegments have different costs).
 */
export const DENSITY_COUNTS: Record<DensityLevel, number> = {
  low:    750,
  medium: 1500,
  high:   3000,
};
