/**
 * Per-band audio influence multipliers for the particle field.
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

/** Particle density preset — maps to a fixed particle count. */
export type DensityLevel = "low" | "medium" | "high";

/** Named colour palette for the particle field. */
export type PaletteName = "cyanViolet" | "monochrome" | "ember";

/**
 * Visual styling settings for the 3D particle field.
 * Separate from audio influence — resetting one must not affect the other.
 *
 * Note: the old 2D Connection Distance and Trails controls were removed in the
 * 3D refactor. Connection lines no longer exist. Trails were deliberately
 * deferred — a correct WebGL trail needs render-target feedback, which risks
 * uncontrolled brightness build-up, so it is omitted rather than faked.
 */
export interface ParticleVisualSettings {
  /** Particle count preset (low 750 / medium 1500 / high 3000). */
  density:      DensityLevel;
  /** Base particle drift-speed multiplier, 25–200 %. */
  speed:        number;
  /** Resting particle size multiplier before audio reactions, 50–200 %. */
  particleSize: number;
  /** Depth of the 3D volume, 50–200 %. Camera stays outside — no clipping. */
  depth:        number;
  /** Colour palette name. */
  palette:      PaletteName;
  /** Glow intensity, 0–100 %. Applied efficiently in the point shader. */
  glow:         number;
}

export const DEFAULT_VISUAL_SETTINGS: ParticleVisualSettings = {
  density:      "medium",
  speed:        100,
  particleSize: 100,
  depth:        100,
  palette:      "cyanViolet",
  glow:         30,
};

/** Density preset → particle count. */
export const DENSITY_COUNTS: Record<DensityLevel, number> = {
  low:    750,
  medium: 1500,
  high:   3000,
};
