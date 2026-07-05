import { useState, useRef, useEffect, useCallback, type RefObject } from "react";
import {
  type FrequencyBands,
  ZERO_BANDS,
  FFT_SIZE,
  SMOOTHING,
  computeBands,
} from "@/lib/audioAnalysis";

// Re-exported so existing importers (FrequencyMeters, etc.) keep working while
// the band model itself lives in the shared analysis utility.
export type { FrequencyBands } from "@/lib/audioAnalysis";

// ─── Module-level registry ────────────────────────────────────────────────────
/**
 * The Web Audio API allows createMediaElementSource() to be called AT MOST
 * ONCE per HTMLMediaElement — across any AudioContext, permanently.
 *
 * React Strict Mode and Vite HMR both unmount + remount components while the
 * underlying <audio> DOM element survives.  On the re-mount the useRef guards
 * reset to null, so a naive implementation calls createMediaElementSource()
 * a second time and throws.  Storing the {ctx, source} pair in a module-level
 * WeakMap keyed by the element survives remounts and is GC'd when the element
 * leaves the DOM.
 */
interface AudioGraph {
  ctx:        AudioContext;
  source:     MediaElementAudioSourceNode;
  /** Recording tap — mirrors the audio to a MediaStream for MediaRecorder. */
  streamDest: MediaStreamAudioDestinationNode;
}
const audioGraphRegistry = new WeakMap<HTMLAudioElement, AudioGraph>();

/**
 * Get (or lazily create) the singleton {ctx, source, streamDest} for an element.
 * createMediaElementSource is called AT MOST ONCE per element (WeakMap-guarded).
 * The streamDest recording tap is created + connected once, alongside the source.
 */
function getOrCreateGraph(audioEl: HTMLAudioElement): AudioGraph {
  let graph = audioGraphRegistry.get(audioEl);
  if (!graph || graph.ctx.state === "closed") {
    const ctx        = new AudioContext();
    const source     = ctx.createMediaElementSource(audioEl);
    const streamDest = ctx.createMediaStreamDestination();
    source.connect(streamDest); // recording tap — always fed, alongside speakers
    graph = { ctx, source, streamDest };
    audioGraphRegistry.set(audioEl, graph);
  }
  return graph;
}

/** Live audio graph handles exposed to the recording workflow. */
export interface AudioGraphHandle {
  ctx:    AudioContext;
  /** MediaStream carrying the currently-playing audio, for MediaRecorder. */
  stream: MediaStream;
}

export interface FrequencyAnalysis {
  bands: FrequencyBands;
  /**
   * Ensure the audio graph exists and return its context + recording stream.
   * Reuses the existing WeakMap-guarded graph — never builds a second source.
   * Returns null if no audio element is mounted.
   */
  ensureAudioGraph: () => AudioGraphHandle | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Connects the supplied audio element to a Web Audio analyser and returns
 * live per-band energy values (0–100) updated every animation frame.
 *
 * When playback pauses the bands are reset to zero so downstream smoothing can
 * fade audio reactions naturally back to rest.
 */
export function useFrequencyAnalysis(
  audioRef:  RefObject<HTMLAudioElement | null>,
  isPlaying: boolean,
): FrequencyAnalysis {
  const [bands, setBands] = useState<FrequencyBands>(ZERO_BANDS);

  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode  | null>(null);
  const rafRef      = useRef<number        | null>(null);
  const dataRef     = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Reset to zero so the renderer's release smoothing fades reactions out.
      setBands(ZERO_BANDS);
      return;
    }

    const audioEl = audioRef.current;
    if (!audioEl) return;

    // ── Get or create the {ctx, source, streamDest} for this element ──────
    const graph = getOrCreateGraph(audioEl);

    // Close a stale context left over from a previous, different element.
    if (ctxRef.current && ctxRef.current !== graph.ctx && ctxRef.current.state !== "closed") {
      ctxRef.current.close().catch(() => { /* ignore */ });
    }

    const { ctx, source, streamDest } = graph;
    ctxRef.current = ctx;

    // ── Rebuild the analyser (lightweight; always fresh on each mount) ────
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch { /* ignore */ }
    }
    try { source.disconnect(); } catch { /* ignore */ }

    const analyser = ctx.createAnalyser();
    analyser.fftSize               = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;

    source.connect(analyser);
    analyser.connect(ctx.destination); // keep playback audible
    source.connect(streamDest);        // re-feed the recording tap (disconnect above dropped it)

    analyserRef.current = analyser;
    dataRef.current     = new Uint8Array(analyser.frequencyBinCount);

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* ignore */ });
    }

    const data     = dataRef.current;
    const binWidth = ctx.sampleRate / FFT_SIZE;

    // Throttle React state emission to ~30 Hz. The <audio> analyser is read
    // every frame for accuracy, but committing to React state 60×/s would
    // re-render App (and every child) needlessly — the meters use a 60 ms CSS
    // transition and the renderer applies its own per-frame smoothing, so a
    // 30 Hz band feed is indistinguishable while halving render churn.
    const EMIT_INTERVAL_MS = 33;
    let lastEmit = 0;

    function tick(now: number) {
      if (now - lastEmit >= EMIT_INTERVAL_MS) {
        lastEmit = now;
        setBands(computeBands(analyser, data, binWidth));
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
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
      // Source + AudioContext are owned by audioGraphRegistry and must survive
      // remounts so createMediaElementSource is never called twice.
      try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
      analyserRef.current = null;
    };
  }, []);

  // ── Recording graph accessor ──────────────────────────────────────────────
  const ensureAudioGraph = useCallback((): AudioGraphHandle | null => {
    const el = audioRef.current;
    if (!el) return null;
    const graph = getOrCreateGraph(el);
    ctxRef.current = graph.ctx;
    return { ctx: graph.ctx, stream: graph.streamDest.stream };
  }, [audioRef]);

  return { bands, ensureAudioGraph };
}
