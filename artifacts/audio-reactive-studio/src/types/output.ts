/**
 * Professional output-format settings for the final recording.
 *
 * These are intentionally separate from visual/audio settings: the output format
 * controls the recorded video's aspect ratio, pixel resolution and frame rate,
 * and must stay fixed for the duration of a recording. All dimensions are exact
 * and centrally defined here so the renderer, preview and recorder agree.
 */

export type AspectRatioId = "16:9" | "9:16" | "1:1";
export type ResolutionId  = "720p" | "1080p";
export type FrameRateId   = 30 | 60;

export interface OutputSettings {
  aspectRatio: AspectRatioId;
  resolution:  ResolutionId;
  frameRate:   FrameRateId;
}

/** Sensible central defaults: 16:9 landscape, 1080p, 60 fps. */
export const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
  aspectRatio: "16:9",
  resolution:  "1080p",
  frameRate:   60,
};

export interface OutputDimensions {
  width:  number;
  height: number;
}

/**
 * Exact recording dimensions per aspect ratio + resolution. These are the pixel
 * dimensions of the renderer drawing buffer AND the recorded WebM.
 */
const DIMENSION_TABLE: Record<AspectRatioId, Record<ResolutionId, OutputDimensions>> = {
  "16:9": { "720p": { width: 1280, height: 720 },  "1080p": { width: 1920, height: 1080 } },
  "9:16": { "720p": { width: 720,  height: 1280 }, "1080p": { width: 1080, height: 1920 } },
  "1:1":  { "720p": { width: 720,  height: 720 },  "1080p": { width: 1080, height: 1080 } },
};

/** Look up the exact output pixel dimensions for a format. */
export function getOutputDimensions(aspect: AspectRatioId, resolution: ResolutionId): OutputDimensions {
  return DIMENSION_TABLE[aspect][resolution];
}

export type Orientation = "landscape" | "portrait" | "square";

/** Orientation word used in the downloaded filename and readouts. */
export function orientationOf(aspect: AspectRatioId): Orientation {
  return aspect === "16:9" ? "landscape" : aspect === "9:16" ? "portrait" : "square";
}

/** Filename-safe format label, e.g. "1080p-landscape". */
export function formatLabelOf(settings: OutputSettings): string {
  return `${settings.resolution}-${orientationOf(settings.aspectRatio)}`;
}

// ─── Select option lists (label text lives here so the UI stays declarative) ──

export const ASPECT_OPTIONS: { value: AspectRatioId; label: string }[] = [
  { value: "16:9", label: "16:9 Landscape" },
  { value: "9:16", label: "9:16 Portrait" },
  { value: "1:1",  label: "1:1 Square" },
];

export const RESOLUTION_OPTIONS: { value: ResolutionId; label: string }[] = [
  { value: "720p",  label: "720p" },
  { value: "1080p", label: "1080p" },
];

export const FRAME_RATE_OPTIONS: { value: FrameRateId; label: string }[] = [
  { value: 30, label: "30 fps" },
  { value: 60, label: "60 fps" },
];
