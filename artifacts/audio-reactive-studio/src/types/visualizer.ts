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
