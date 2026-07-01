/**
 * Professional output-format settings for the final recording.
 *
 * These are intentionally separate from visual/audio settings: the output format
 * controls the recorded video's aspect ratio, pixel resolution and frame rate,
 * and must stay fixed for the duration of a recording. All dimensions are exact
 * and centrally defined here so the renderer, preview and recorder agree.
 */

export type AspectRatioId = "16:9" | "9:16" | "1:1";
export type ResolutionId  = "720p" | "1080p" | "4k";
export type FrameRateId   = 30 | 60;
/** Recording container. MP4 requires genuine native MediaRecorder support. */
export type OutputFormatId = "mp4" | "webm";

export interface OutputSettings {
  format:      OutputFormatId;
  aspectRatio: AspectRatioId;
  resolution:  ResolutionId;
  frameRate:   FrameRateId;
}

/** Sensible central defaults: MP4, 16:9 landscape, 1080p, 60 fps. */
export const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
  format:      "mp4",
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
  "16:9": { "720p": { width: 1280, height:  720 }, "1080p": { width: 1920, height: 1080 }, "4k": { width: 3840, height: 2160 } },
  "9:16": { "720p": { width:  720, height: 1280 }, "1080p": { width: 1080, height: 1920 }, "4k": { width: 2160, height: 3840 } },
  "1:1":  { "720p": { width:  720, height:  720 }, "1080p": { width: 1080, height: 1080 }, "4k": { width: 2160, height: 2160 } },
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
  { value: "4k",    label: "4K" },
];

export const FRAME_RATE_OPTIONS: { value: FrameRateId; label: string }[] = [
  { value: 30, label: "30 fps" },
  { value: 60, label: "60 fps" },
];

export const OUTPUT_FORMAT_OPTIONS: { value: OutputFormatId; label: string }[] = [
  { value: "mp4",  label: "MP4" },
  { value: "webm", label: "WebM" },
];

// ─── Recording bitrate targets ───────────────────────────────────────────────
// Central function so no component scatters raw bitrate numbers.
// videoBitsPerSecond: tiered by resolution and frame rate, matching professional
// streaming targets (higher fps needs ~65% more bits to preserve motion quality).
// audioBitsPerSecond: 192 kbps — transparent for music / spoken word in MP4/WebM.

const VIDEO_BPS_30: Record<ResolutionId, number> = {
  "720p":  6_000_000,
  "1080p": 12_000_000,
  "4k":    35_000_000,
};
const VIDEO_BPS_60: Record<ResolutionId, number> = {
  "720p":  10_000_000,
  "1080p": 20_000_000,
  "4k":    55_000_000,
};

/**
 * Derive the requested video and audio bitrates for MediaRecorder from the
 * selected resolution and frame rate.  Pass both values to the MediaRecorder
 * constructor; then read recorder.videoBitsPerSecond for the actual value the
 * browser committed to.
 */
export function getRecordingBitrate(
  resolution: ResolutionId,
  frameRate:  number,
): { videoBitsPerSecond: number; audioBitsPerSecond: number } {
  const videoBitsPerSecond = frameRate >= 50 ? VIDEO_BPS_60[resolution] : VIDEO_BPS_30[resolution];
  return { videoBitsPerSecond, audioBitsPerSecond: 192_000 };
}

// ─── Native recording MIME support ───────────────────────────────────────────
// A format only records if MediaRecorder.isTypeSupported() confirms a concrete
// MIME type for it. MP4 support in particular varies by browser, so we never
// assume it — and we never fall back across containers (that would produce a
// file whose real contents disagree with the requested/named format).

/** Candidate MP4 MIME types, most-specific first. */
export const MP4_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
];

/** Candidate WebM MIME types, most-capable first. */
export const WEBM_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function mimeCandidatesFor(format: OutputFormatId): string[] {
  return format === "mp4" ? MP4_MIME_CANDIDATES : WEBM_MIME_CANDIDATES;
}

/**
 * The first genuinely-supported MIME type for a format, or "" if the browser
 * cannot natively record that container. Never crosses containers.
 */
export function pickMimeTypeForFormat(format: OutputFormatId): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const mime of mimeCandidatesFor(format)) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

/** True when the browser can natively record the given format. */
export function isFormatSupported(format: OutputFormatId): boolean {
  return pickMimeTypeForFormat(format) !== "";
}

/**
 * Derive the true container (and therefore file extension) from a REAL
 * MediaRecorder MIME type — never from the user's selection — so the extension
 * always matches the bytes in the Blob.
 */
export function containerFromMime(mime: string): OutputFormatId {
  return mime.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

/** Human-facing format label, e.g. "MP4" / "WebM". */
export function formatDisplayName(format: OutputFormatId): string {
  return format === "mp4" ? "MP4" : "WebM";
}
