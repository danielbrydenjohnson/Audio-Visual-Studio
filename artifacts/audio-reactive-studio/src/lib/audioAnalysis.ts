/**
 * Shared three-band frequency analysis — the single source of truth for both the
 * uploaded-track path (useFrequencyAnalysis) and the live-input path
 * (useLiveInputAnalysis). Neither hook duplicates FFT/band logic; both call
 * computeBands() so the meters, visual templates and influence controls receive
 * identical band values regardless of where the audio came from.
 *
 *   Low:  20–200 Hz    — sub-bass, basslines, kick energy
 *   Mid:  250–4000 Hz  — snares, claps, vocals, synth body, melody
 *   High: 4000–16000 Hz — hi-hats, cymbals, brightness, transients
 *
 * Values are raw analyser energy normalised 0–100. They are NEVER modified by the
 * influence sliders — those apply only inside the renderer.
 */
export interface FrequencyBands {
  low:  number;
  mid:  number;
  high: number;
}

export const ZERO_BANDS: FrequencyBands = { low: 0, mid: 0, high: 0 };

export const FFT_SIZE = 2048;
export const SMOOTHING = 0.75;

interface BandRange { fLow: number; fHigh: number }

export const BAND_RANGES: Record<keyof FrequencyBands, BandRange> = {
  low:  { fLow: 20,   fHigh: 200   },
  mid:  { fLow: 250,  fHigh: 4000  },
  high: { fLow: 4000, fHigh: 16000 },
};

/** Average FFT byte values in [fLow, fHigh] Hz, normalised 0–100. */
function averageBand(
  data: Uint8Array<ArrayBuffer>,
  binWidth: number,
  fLow: number,
  fHigh: number,
): number {
  const startBin = Math.max(0, Math.floor(fLow / binWidth));
  const endBin   = Math.min(data.length - 1, Math.ceil(fHigh / binWidth));
  if (startBin > endBin) return 0;
  let sum = 0;
  for (let i = startBin; i <= endBin; i++) sum += data[i];
  return ((sum / (endBin - startBin + 1)) / 255) * 100;
}

/**
 * Read the analyser's current spectrum into `data` and reduce it to the three
 * normalised band values. `binWidth` is `ctx.sampleRate / FFT_SIZE`.
 */
export function computeBands(
  analyser: AnalyserNode,
  data: Uint8Array<ArrayBuffer>,
  binWidth: number,
): FrequencyBands {
  analyser.getByteFrequencyData(data);
  return {
    low:  averageBand(data, binWidth, BAND_RANGES.low.fLow,  BAND_RANGES.low.fHigh),
    mid:  averageBand(data, binWidth, BAND_RANGES.mid.fLow,  BAND_RANGES.mid.fHigh),
    high: averageBand(data, binWidth, BAND_RANGES.high.fLow, BAND_RANGES.high.fHigh),
  };
}
