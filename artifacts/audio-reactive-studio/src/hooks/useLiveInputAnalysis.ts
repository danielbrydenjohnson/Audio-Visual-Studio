import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FrequencyBands,
  ZERO_BANDS,
  FFT_SIZE,
  SMOOTHING,
  computeBands,
} from "@/lib/audioAnalysis";

export type LiveInputStatus =
  | "idle"        // never started this session
  | "requesting"  // waiting on getUserMedia / permission prompt
  | "active"      // mic connected, bands flowing
  | "stopped"     // cleanly stopped by the user
  | "error";      // permission denied, no device, device lost, etc.

export interface LiveInputDevice {
  deviceId: string;
  label:    string;
}

/** Audio handles handed to the recorder for a live-input capture. */
export interface LiveRecordingAudio {
  ctx:         AudioContext;
  audioTracks: MediaStreamTrack[];
}

export interface LiveInputAnalysis {
  status:            LiveInputStatus;
  bands:             FrequencyBands;
  error:             string | null;
  devices:           LiveInputDevice[];
  selectedDeviceId:  string;
  isActive:          boolean;
  setSelectedDeviceId: (id: string) => void;
  refreshDevices:    () => void;
  start:             () => void;
  stop:              () => void;
  /** Current live audio ctx + mic tracks for MediaRecorder, or null if inactive. */
  getRecordingAudio: () => LiveRecordingAudio | null;
}

interface UseLiveInputArgs {
  /**
   * Fired when the live stream ends unexpectedly (device unplugged / lost) — the
   * consumer uses this to stop any in-flight recording cleanly. NOT fired on a
   * user-initiated stop().
   */
  onUnexpectedEnd?: () => void;
}

// Match the uploaded-track emit cadence (~30 Hz) so both paths feel identical.
const EMIT_INTERVAL_MS = 33;

/**
 * Live microphone / line-in analysis. getUserMedia → MediaStreamAudioSourceNode
 * → AnalyserNode → shared computeBands(). The mic is deliberately NEVER connected
 * to ctx.destination (that would monitor the mic to the speakers and cause
 * feedback). The same MediaStream serves both analysis and recording, so no
 * second getUserMedia call is ever made for capture.
 */
export function useLiveInputAnalysis({ onUnexpectedEnd }: UseLiveInputArgs = {}): LiveInputAnalysis {
  const [status,           setStatus]           = useState<LiveInputStatus>("idle");
  const [bands,            setBands]            = useState<FrequencyBands>(ZERO_BANDS);
  const [error,            setError]            = useState<string | null>(null);
  const [devices,          setDevices]          = useState<LiveInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const ctxRef      = useRef<AudioContext | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const sourceRef   = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef     = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef      = useRef<number | null>(null);

  // True only while we are tearing the graph down ourselves, so the track
  // "ended" handler can distinguish our own stop from an unexpected disconnect.
  const stoppingRef  = useRef(false);
  const activeRef    = useRef(false);
  // Synchronous re-entry guard around the async start() setup.
  const busyRef      = useRef(false);
  // Monotonic session id: any stop()/teardown/new-start bumps it so an in-flight
  // start() that resolves later (e.g. after the permission prompt) detects it was
  // superseded, releases the just-acquired mic, and never reactivates capture.
  const startIdRef   = useRef(0);
  const onUnexpectedEndRef = useRef(onUnexpectedEnd);
  onUnexpectedEndRef.current = onUnexpectedEnd;

  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** Stop tracks, disconnect nodes, close the context, drop all refs. */
  const teardownGraph = useCallback(() => {
    cancelRaf();
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) {
        t.onended = null;
        t.stop();
      }
      streamRef.current = null;
    }
    try { sourceRef.current?.disconnect(); }   catch { /* ignore */ }
    try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
    sourceRef.current   = null;
    analyserRef.current = null;
    dataRef.current     = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => { /* ignore */ });
  }, [cancelRaf]);

  const refreshDevices = useCallback(() => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== "function") return;
    md.enumerateDevices()
      .then(list => {
        const inputs = list
          .filter(d => d.kind === "audioinput" && d.deviceId)
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
        setDevices(inputs);
      })
      .catch(() => { /* ignore */ });
  }, []);

  /** Internal stop — `opts` lets the unexpected-end path set an error status. */
  const stopInternal = useCallback(
    (opts?: { status?: LiveInputStatus; error?: string | null }) => {
      stoppingRef.current = true;
      activeRef.current   = false;
      // Invalidate any in-flight start() so it can't reactivate capture later.
      startIdRef.current++;
      teardownGraph();
      setBands(ZERO_BANDS);
      if (opts?.error !== undefined) setError(opts.error);
      setStatus(opts?.status ?? "stopped");
      busyRef.current   = false;
      stoppingRef.current = false;
    },
    [teardownGraph],
  );

  const handleTrackEnded = useCallback(() => {
    // Ignore ended events we caused ourselves via stop()/teardown.
    if (stoppingRef.current || !activeRef.current) return;
    onUnexpectedEndRef.current?.();
    stopInternal({
      status: "error",
      error:  "Live input ended — the input device was disconnected.",
    });
  }, [stopInternal]);

  const start = useCallback(() => {
    if (busyRef.current || activeRef.current) return;
    busyRef.current = true;
    setError(null);
    setStatus("requesting");

    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      setStatus("error");
      setError("This browser doesn't support live microphone input (getUserMedia unavailable).");
      busyRef.current = false;
      return;
    }

    const wantId = selectedDeviceId;
    const constraints: MediaStreamConstraints = {
      audio: wantId ? { deviceId: { exact: wantId } } : true,
    };

    // This start owns session `myStart`; if it's superseded (by stop/teardown or
    // a newer start) while awaiting, we release resources instead of committing.
    const myStart = ++startIdRef.current;
    const isCurrent = () => startIdRef.current === myStart;

    void (async () => {
      let stream: MediaStream;
      try {
        stream = await md.getUserMedia(constraints);
      } catch (err) {
        const name = (err as DOMException)?.name;
        let msg = "Couldn't access the microphone.";
        if (name === "NotAllowedError" || name === "SecurityError") {
          msg = "Microphone permission was denied. Allow mic access in your browser to use Live Input.";
        } else if (name === "NotFoundError") {
          msg = "No audio input device was found. Connect a microphone and try again.";
        } else if (name === "OverconstrainedError") {
          msg = "The selected input device is unavailable. Pick a different device or use the default.";
        } else if (name === "NotReadableError") {
          msg = "The audio input device is already in use or can't be read.";
        }
        setStatus("error");
        setError(msg);
        busyRef.current = false;
        return;
      }

      // Superseded during the permission prompt (e.g. user switched modes or
      // pressed stop) — release the mic immediately, don't touch state/refs.
      if (!isCurrent()) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }

      let ctx: AudioContext;
      try {
        ctx = new AudioContext();
      } catch {
        for (const t of stream.getTracks()) t.stop();
        setStatus("error");
        setError("Couldn't initialise the audio engine for live input.");
        busyRef.current = false;
        return;
      }
      try {
        if (ctx.state === "suspended") await ctx.resume();
      } catch { /* non-fatal; some browsers resume on first frame */ }

      // Superseded while resuming the context — tear down and bail.
      if (!isCurrent()) {
        for (const t of stream.getTracks()) t.stop();
        if (ctx.state !== "closed") ctx.close().catch(() => { /* ignore */ });
        return;
      }

      let source: MediaStreamAudioSourceNode;
      try {
        source = ctx.createMediaStreamSource(stream);
      } catch {
        for (const t of stream.getTracks()) t.stop();
        ctx.close().catch(() => { /* ignore */ });
        setStatus("error");
        setError("Couldn't route the microphone into the analyser.");
        busyRef.current = false;
        return;
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize               = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      // Analysis only — NEVER connect to ctx.destination (avoids mic feedback).
      source.connect(analyser);

      const data     = new Uint8Array(analyser.frequencyBinCount);
      const binWidth = ctx.sampleRate / FFT_SIZE;

      ctxRef.current      = ctx;
      streamRef.current   = stream;
      sourceRef.current   = source;
      analyserRef.current = analyser;
      dataRef.current     = data;

      // Detect device unplug / stream loss while live.
      for (const t of stream.getAudioTracks()) t.onended = handleTrackEnded;

      activeRef.current = true;
      busyRef.current   = false;
      setStatus("active");

      // Permission is granted now, so labels are available — refresh the list.
      refreshDevices();

      let lastEmit = 0;
      const tick = (now: number) => {
        if (now - lastEmit >= EMIT_INTERVAL_MS) {
          lastEmit = now;
          setBands(computeBands(analyser, data, binWidth));
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    })();
  }, [selectedDeviceId, handleTrackEnded, refreshDevices]);

  const stop = useCallback(() => { stopInternal(); }, [stopInternal]);

  const getRecordingAudio = useCallback((): LiveRecordingAudio | null => {
    if (!activeRef.current || !ctxRef.current || !streamRef.current) return null;
    const audioTracks = streamRef.current.getAudioTracks();
    if (audioTracks.length === 0) return null;
    return { ctx: ctxRef.current, audioTracks };
  }, []);

  // Initial enumeration + live device-change tracking.
  useEffect(() => {
    refreshDevices();
    const md = navigator.mediaDevices;
    if (md && typeof md.addEventListener === "function") {
      md.addEventListener("devicechange", refreshDevices);
      return () => md.removeEventListener("devicechange", refreshDevices);
    }
    return undefined;
  }, [refreshDevices]);

  // Full teardown on unmount — release the mic, drop all resources.
  useEffect(() => {
    return () => {
      stoppingRef.current = true;
      activeRef.current   = false;
      startIdRef.current++;
      teardownGraph();
    };
  }, [teardownGraph]);

  return {
    status, bands, error, devices, selectedDeviceId,
    isActive: status === "active",
    setSelectedDeviceId, refreshDevices, start, stop, getRecordingAudio,
  };
}
