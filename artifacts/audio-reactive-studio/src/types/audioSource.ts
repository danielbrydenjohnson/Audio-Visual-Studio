/**
 * Audio source mode. The visual renderer never cares which one is active — it
 * only ever receives Low/Mid/High band values — but the transport UI, analysis
 * path and recording audio routing differ between the two.
 */
export type AudioSourceMode = "uploaded-track" | "live-input";

export const DEFAULT_AUDIO_SOURCE_MODE: AudioSourceMode = "uploaded-track";

export const AUDIO_SOURCE_OPTIONS: { value: AudioSourceMode; label: string }[] = [
  { value: "uploaded-track", label: "Uploaded Track" },
  { value: "live-input",     label: "Live Input" },
];
