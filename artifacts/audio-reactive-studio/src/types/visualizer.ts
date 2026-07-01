/**
 * Per-band influence multipliers for the particle visualiser.
 * Values are percentages: 0 = off, 100 = normal, 200 = double strength.
 */
export interface VisualizerSettings {
  sub:  number; // 0–200 %
  low:  number; // 0–200 %
  mid:  number; // 0–200 %
  high: number; // 0–200 %
}

export const DEFAULT_SETTINGS: VisualizerSettings = {
  sub:  140,
  low:  100,
  mid:   80,
  high: 100,
};

// ─── Visual Settings ──────────────────────────────────────────────────────────

/** Particle density preset — maps to a fixed particle count. */
export type DensityLevel = "low" | "medium" | "high";

/** Named colour palette for the particle field. */
export type PaletteName = "cyanViolet" | "monochrome" | "ember";

/**
 * Visual styling settings for the particle field.
 * Separate from audio influence — resetting one must not affect the other.
 */
export interface ParticleVisualSettings {
  /** Particle count preset. */
  density:            DensityLevel;
  /** Base particle velocity multiplier, 25–200 %. */
  speed:              number;
  /** Resting particle radius multiplier before audio reactions, 50–200 %. */
  particleSize:       number;
  /** Max pixel distance for connection lines, 0–160 px. At 0 no lines are drawn. */
  connectionDistance: number;
  /** Colour palette name. */
  palette:            PaletteName;
  /** Canvas shadowBlur intensity, 0–100 %. Applied to particles only, not lines. */
  glow:               number;
  /** Motion trail retention, 0–90 %. At 0 the canvas is fully cleared each frame. */
  trails:             number;
}

export const DEFAULT_VISUAL_SETTINGS: ParticleVisualSettings = {
  density:            "medium",
  speed:              100,
  particleSize:       100,
  connectionDistance: 90,
  palette:            "cyanViolet",
  glow:               25,
  trails:             0,
};
