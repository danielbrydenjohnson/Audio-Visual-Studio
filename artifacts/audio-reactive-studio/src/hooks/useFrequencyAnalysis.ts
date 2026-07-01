import { useState, useRef, useEffect, type RefObject } from "react";

export interface FrequencyBands {
  sub:  number; // 20–80 Hz,    0–100
  low:  number; // 80–250 Hz,   0–100
  mid:  number; // 250–4000 Hz, 0–100
  high: number; // 4000–16kHz,  0–100
}

const ZERO_BANDS: FrequencyBands = { sub: 0, low: 0, mid: 0, high: 0 };

const FFT_SIZE = 2048;
const SMOOTHING = 0.75;

interface BandRange { fLow: number; fHigh: number }

const BAND_RANGES: Record<keyof FrequencyBands, BandRange> = {
  sub:  { fLow: 20,   fHigh: 80    },
  low:  { fLow: 80,   fHigh: 250   },
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

// ─── Module-level registry ────────────────────────────────────────────────────
/**
 * The Web Audio API allows createMediaElementSource() to be called AT MOST
 * ONCE per HTMLMediaElement — across any AudioContext, permanently.
 *
 * React Strict Mode and Vite HMR both unmount + remount components while the
 * underlying <audio> DOM element survives.  On the re-mount the useRef guards
 * reset to null, so a naive implementation calls createMediaElementSource()
 * a second time and throws:
 *   "HTMLMediaElement already connected to a different MediaElementSourceNode"
 *
 * Storing the {ctx, source} pair in a WeakMap keyed by the HTMLAudioElement
 * solves this: the entry persists across React unmount/remount cycles because
 * WeakMap is module-scoped, and it is automatically GC'd when the element is
 * removed from the DOM (e.g. when the user changes the audio file).
 */
interface AudioGraph {
  ctx:    AudioContext;
  source: MediaElementAudioSourceNode;
}
const audioGraphRegistry = new WeakMap<HTMLAudioElement, AudioGraph>();

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Connects the supplied audio element to a Web Audio analyser and returns
 * live per-band energy values (0–100) updated every animation frame.
 *
 * - AudioContext + MediaElementAudioSourceNode are created lazily on first
 *   play, honouring the browser's autoplay policy.
 * - A module-level WeakMap ensures createMediaElementSource is never called
 *   twice for the same element (safe across HMR / Strict Mode remounts).
 * - The analyser is rebuilt on each effect run; only the source + context
 *   are preserved across remounts.
 * - Cancels the RAF loop and disconnects the analyser on unmount.
 */
export function useFrequencyAnalysis(
  audioRef:  RefObject<HTMLAudioElement | null>,
  isPlaying: boolean,
): FrequencyBands {
  const [bands, setBands] = useState<FrequencyBands>(ZERO_BANDS);

  // Refs for the audio graph — never in state to avoid re-renders.
  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode  | null>(null);
  const rafRef      = useRef<number        | null>(null);
  const dataRef     = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // ── Main effect: build graph + run RAF while playing ─────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const audioEl = audioRef.current;
    if (!audioEl) return;

    // ── Get or create the {ctx, source} pair for this element ─────────────
    let graph = audioGraphRegistry.get(audioEl);

    if (!graph || graph.ctx.state === "closed") {
      // Close any previous context (element changed, or context was closed).
      if (ctxRef.current && ctxRef.current.state !== "closed") {
        ctxRef.current.close().catch(() => { /* ignore */ });
      }
      const ctx    = new AudioContext();
      const source = ctx.createMediaElementSource(audioEl);
      graph        = { ctx, source };
      audioGraphRegistry.set(audioEl, graph);
    }

    const { ctx, source } = graph;
    ctxRef.current = ctx;

    // ── Rebuild the analyser (lightweight; always fresh on each mount) ────
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch { /* ignore */ }
    }
    // Disconnect source from any stale analyser before attaching a new one.
    try { source.disconnect(); } catch { /* ignore */ }

    const analyser = ctx.createAnalyser();
    analyser.fftSize              = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;

    source.connect(analyser);
    analyser.connect(ctx.destination); // keep playback audible

    analyserRef.current = analyser;
    dataRef.current     = new Uint8Array(analyser.frequencyBinCount);

    // ── Resume context (autoplay policy may have suspended it) ────────────
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* ignore */ });
    }

    // ── RAF loop ──────────────────────────────────────────────────────────
    const data     = dataRef.current;
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
      // isPlaying changed — stop the loop; leave graph intact.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, audioRef]);

  // ── Global cleanup on unmount ─────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Disconnect the analyser only.
      // Source + AudioContext are owned by audioGraphRegistry and must
      // survive remounts so createMediaElementSource is never called twice.
      try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
      analyserRef.current = null;
    };
  }, []);

  return bands;
}
