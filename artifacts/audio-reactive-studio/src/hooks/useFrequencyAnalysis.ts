import { useState, useRef, useEffect, type RefObject } from "react";

export interface FrequencyBands {
  sub: number;  // 20–80 Hz,    0–100
  low: number;  // 80–250 Hz,   0–100
  mid: number;  // 250–4000 Hz, 0–100
  high: number; // 4000–16kHz,  0–100
}

const ZERO_BANDS: FrequencyBands = { sub: 0, low: 0, mid: 0, high: 0 };

const FFT_SIZE = 2048;
const SMOOTHING = 0.75;

interface BandRange { fLow: number; fHigh: number }

const BAND_RANGES: Record<keyof FrequencyBands, BandRange> = {
  sub:  { fLow: 20,   fHigh: 80 },
  low:  { fLow: 80,   fHigh: 250 },
  mid:  { fLow: 250,  fHigh: 4000 },
  high: { fLow: 4000, fHigh: 16000 },
};

/** Average the FFT byte values in [fLow, fHigh] Hz, normalised to 0–100. */
function averageBand(
  data: Uint8Array<ArrayBuffer>,
  binWidth: number,
  fLow: number,
  fHigh: number
): number {
  const startBin = Math.max(0, Math.floor(fLow / binWidth));
  const endBin = Math.min(data.length - 1, Math.ceil(fHigh / binWidth));
  if (startBin > endBin) return 0;
  let sum = 0;
  for (let i = startBin; i <= endBin; i++) sum += data[i];
  return ((sum / (endBin - startBin + 1)) / 255) * 100;
}

/**
 * Connects the supplied audio element to a Web Audio analyser and returns
 * live per-band energy values (0–100) updated every animation frame.
 *
 * - Creates the AudioContext and MediaElementAudioSourceNode lazily on the
 *   first play, honouring the browser's autoplay policy.
 * - Guards against duplicate MediaElementAudioSourceNodes for the same element.
 * - Cancels the RAF loop and disconnects all nodes on unmount.
 */
export function useFrequencyAnalysis(
  audioRef: RefObject<HTMLAudioElement | null>,
  isPlaying: boolean
): FrequencyBands {
  const [bands, setBands] = useState<FrequencyBands>(ZERO_BANDS);

  // Persisted audio-graph references (never stored in state to avoid re-renders)
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  /** Which element the source node was created for — guards against duplicates. */
  const connectedElRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // ── Main effect: set up graph + run RAF loop while playing ─────────────────
  useEffect(() => {
    if (!isPlaying) {
      // Pause: stop the RAF loop but leave the graph intact
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const audioEl = audioRef.current;
    if (!audioEl) return; // safety guard (shouldn't happen when isPlaying is true)

    // Create AudioContext on first play (requires user gesture in most browsers)
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = new AudioContext();
    }
    const ctx = ctxRef.current;

    // Build the graph only if this is a new audio element
    if (connectedElRef.current !== audioEl) {
      // Disconnect previous source node (different element)
      if (sourceRef.current) {
        try { sourceRef.current.disconnect(); } catch { /* ignore */ }
        sourceRef.current = null;
      }
      if (analyserRef.current) {
        try { analyserRef.current.disconnect(); } catch { /* ignore */ }
        analyserRef.current = null;
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;

      // createMediaElementSource must only be called once per element
      const source = ctx.createMediaElementSource(audioEl);
      source.connect(analyser);
      analyser.connect(ctx.destination); // keep playback audible

      sourceRef.current = source;
      analyserRef.current = analyser;
      connectedElRef.current = audioEl;
      dataRef.current = new Uint8Array(analyser.frequencyBinCount);
    }

    // Resume context that was suspended by the browser's autoplay policy
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* ignore */ });
    }

    // Start RAF loop
    const analyser = analyserRef.current!;
    const data = dataRef.current!;
    const binWidth = ctx.sampleRate / FFT_SIZE;

    function tick() {
      analyser.getByteFrequencyData(data);
      setBands({
        sub:  averageBand(data, binWidth, BAND_RANGES.sub.fLow,  BAND_RANGES.sub.fHigh),
        low:  averageBand(data, binWidth, BAND_RANGES.low.fLow,  BAND_RANGES.low.fHigh),
        mid:  averageBand(data, binWidth, BAND_RANGES.mid.fLow,  BAND_RANGES.mid.fHigh),
        high: averageBand(data, binWidth, BAND_RANGES.high.fLow, BAND_RANGES.high.fHigh),
      });
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      // isPlaying changed — stop the loop (graph stays connected)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, audioRef]);

  // ── Global cleanup on unmount ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
      try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
      ctxRef.current?.close().catch(() => { /* ignore */ });
      sourceRef.current = null;
      analyserRef.current = null;
      ctxRef.current = null;
      connectedElRef.current = null;
    };
  }, []);

  return bands;
}
