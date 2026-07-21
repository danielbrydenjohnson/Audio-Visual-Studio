import { useState, useRef, useEffect, useCallback, type RefObject } from "react";
import {
  type AnalysisFrame,
  type HitResponseSettings,
  BandAnalysisEngine,
  makeZeroFrame,
  zeroFrame,
  FFT_SIZE,
  SMOOTHING,
} from "@/lib/audioAnalysis";

// Re-exported so existing importers keep working while the band model itself
// lives in the shared analysis utility.
export type { AnalysisFrame } from "@/lib/audioAnalysis";

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
  /**
   * ~30 Hz React snapshot for the meters. `level` is the current smoothed
   * value; `hit` is the PEAK hit seen since the previous emission so short
   * transients can't fall between state updates.
   */
  bands: AnalysisFrame;
  /**
   * Mutable frame updated every animation frame (~60 Hz). The renderer reads
   * this directly each frame so hits stay crisp without React re-render churn.
   * The object identity is stable for the lifetime of the hook.
   */
  frame: RefObject<AnalysisFrame>;
  /**
   * Ensure the audio graph exists and return its context + recording stream.
   * Reuses the existing WeakMap-guarded graph — never builds a second source.
   * Returns null if no audio element is mounted.
   */
  ensureAudioGraph: () => AudioGraphHandle | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Connects the supplied audio element to a Web Audio analyser and returns live
 * per-band {level, hit} signals (each 0–100) updated every animation frame.
 *
 * When playback pauses the frame is zeroed and the engine reset so downstream
 * smoothing fades reactions naturally back to rest (and no stale spectrum
 * leaks into the next play).
 */
export function useFrequencyAnalysis(
  audioRef:    RefObject<HTMLAudioElement | null>,
  isPlaying:   boolean,
  hitResponse: HitResponseSettings,
): FrequencyAnalysis {
  const [bands, setBands] = useState<AnalysisFrame>(makeZeroFrame);

  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode  | null>(null);
  const rafRef      = useRef<number        | null>(null);
  const dataRef     = useRef<Uint8Array<ArrayBuffer> | null>(null);

  // Engine + per-frame output live in refs so the analyser effect never has to
  // restart when hit settings change — the tick reads hitRef.current live.
  const engineRef = useRef<BandAnalysisEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new BandAnalysisEngine();
  const frameRef = useRef<AnalysisFrame | null>(null);
  if (frameRef.current === null) frameRef.current = makeZeroFrame();

  const hitRef = useRef(hitResponse);
  hitRef.current = hitResponse;

  useEffect(() => {
    const engine = engineRef.current!;
    const frame  = frameRef.current!;

    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Reset to zero so the renderer's release smoothing fades reactions out,
      // and drop the engine's prev-spectrum/envelope state.
      engine.reset();
      zeroFrame(frame);
      setBands(makeZeroFrame());
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

    // The analyser is read EVERY animation frame (the renderer consumes the
    // mutable frame at full rate), but React state is only committed at ~30 Hz
    // — committing 60×/s would re-render App (and every child) needlessly.
    // Between emissions the hit value is peak-held so a 1-frame spike is still
    // visible on the meters.
    const EMIT_INTERVAL_MS = 33;
    let lastEmit = 0;
    let peakLow = 0, peakMid = 0, peakHigh = 0;

    function tick(now: number) {
      engine.analyse(analyser, data, binWidth, now, hitRef.current, frame);
      if (frame.low.hit  > peakLow)  peakLow  = frame.low.hit;
      if (frame.mid.hit  > peakMid)  peakMid  = frame.mid.hit;
      if (frame.high.hit > peakHigh) peakHigh = frame.high.hit;

      if (now - lastEmit >= EMIT_INTERVAL_MS) {
        lastEmit = now;
        setBands({
          low:  { level: frame.low.level,  hit: peakLow  },
          mid:  { level: frame.mid.level,  hit: peakMid  },
          high: { level: frame.high.level, hit: peakHigh },
        });
        peakLow = peakMid = peakHigh = 0;
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

  return {
    bands,
    frame: frameRef as RefObject<AnalysisFrame>,
    ensureAudioGraph,
  };
}
