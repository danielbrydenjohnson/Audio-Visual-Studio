/**
 * Shared three-band frequency analysis — the single source of truth for both the
 * uploaded-track path (useFrequencyAnalysis) and the live-input path
 * (useLiveInputAnalysis). Neither hook duplicates FFT/band logic; both drive a
 * BandAnalysisEngine so the meters, visual templates and influence controls
 * receive identical values regardless of where the audio came from.
 *
 *   Low:  20–200 Hz    — sub-bass, basslines, kick energy
 *   Mid:  250–4000 Hz  — snares, claps, vocals, synth body, melody
 *   High: 4000–16000 Hz — hi-hats, cymbals, brightness, transients
 *
 * Each band exposes TWO signals per frame (both 0–100):
 *
 *   level — sustained band energy (averaged FFT magnitude, downstream-smoothed).
 *           The same musical meaning as the original single value: basslines,
 *           pads, vocals, drones, general energy.
 *   hit   — onset/transient envelope. Per-band spectral flux (positive magnitude
 *           change only — fading sounds never register) normalised to 0–1, then
 *           shaped by a frame-rate-independent attack/decay envelope. Kicks,
 *           snares, claps and hats read as sharp spikes that decay smoothly.
 *
 * The analyser's own smoothingTimeConstant is deliberately LOW (0.1): onset
 * detection needs unsmoothed transients. The familiar stable "level" feel is
 * recreated downstream with our own attack/release smoothing instead.
 *
 * Values are NEVER modified by the influence sliders — those apply only inside
 * the renderer.
 */

// ─── Frame model ──────────────────────────────────────────────────────────────

export interface BandSignal {
  /** Sustained band energy, 0–100. */
  level: number;
  /** Transient/onset envelope, 0–100. */
  hit: number;
}

export interface AnalysisFrame {
  low:  BandSignal;
  mid:  BandSignal;
  high: BandSignal;
}

export const BAND_KEYS = ["low", "mid", "high"] as const;
export type BandKey = (typeof BAND_KEYS)[number];

export function makeZeroFrame(): AnalysisFrame {
  return {
    low:  { level: 0, hit: 0 },
    mid:  { level: 0, hit: 0 },
    high: { level: 0, hit: 0 },
  };
}

/** Zero a frame in place (used when playback pauses / live input stops). */
export function zeroFrame(f: AnalysisFrame): void {
  f.low.level = 0;  f.low.hit = 0;
  f.mid.level = 0;  f.mid.hit = 0;
  f.high.level = 0; f.high.hit = 0;
}

// ─── Analyser configuration ───────────────────────────────────────────────────

export const FFT_SIZE = 2048;
/**
 * AnalyserNode smoothingTimeConstant. Kept LOW on purpose: high analyser
 * smoothing blunts the frame-to-frame magnitude jumps that spectral flux needs
 * to see. Level stability is recreated downstream in BandAnalysisEngine.
 */
export const SMOOTHING = 0.1;

interface BandRange { fLow: number; fHigh: number }

export const BAND_RANGES: Record<BandKey, BandRange> = {
  low:  { fLow: 20,   fHigh: 200   },
  mid:  { fLow: 250,  fHigh: 4000  },
  high: { fLow: 4000, fHigh: 16000 },
};

// ─── Level smoothing (downstream replacement for the old analyser smoothing) ──
// The old analyser smoothing (0.75 at ~60 fps reads) behaved like a ~60 ms
// exponential. These time constants reproduce that stable feel — slightly
// faster up than down so levels stay musical without flickering.
const LEVEL_ATTACK_S  = 0.045;
const LEVEL_RELEASE_S = 0.110;

// ─── Spectral-flux normalisation ─────────────────────────────────────────────
// rawFlux is the mean positive per-bin byte delta (0–255 scale) for the band.
// normalisedFlux = clamp(rawFlux * sensitivity, 0, 1). Typical onsets produce
// smaller absolute deltas in higher bands (fewer loud bins), so sensitivity
// rises with frequency.
const FLUX_SENSITIVITY: Record<BandKey, number> = {
  low:  1 / 42,
  mid:  1 / 30,
  high: 1 / 20,
};

// ─── Hit envelope settings (user-adjustable via the Hit Response controls) ────

export interface BandHitSettings {
  attackMs: number;
  decayMs:  number;
}

export interface HitResponseSettings {
  low:  BandHitSettings;
  mid:  BandHitSettings;
  high: BandHitSettings;
}

export const DEFAULT_HIT_RESPONSE: HitResponseSettings = {
  low:  { attackMs: 5, decayMs: 150 },
  mid:  { attackMs: 5, decayMs: 100 },
  high: { attackMs: 2, decayMs: 60  },
};

export const HIT_ATTACK_MIN = 1;
export const HIT_ATTACK_MAX = 50;
export const HIT_DECAY_MIN  = 20;
export const HIT_DECAY_MAX  = 500;

// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * Stateful per-frame analysis: band levels (averaged energy + downstream
 * smoothing), per-band spectral flux against the previous frame's spectrum,
 * and attack/decay hit envelopes. One instance per audio source; reset() when
 * the source stops so stale spectra/envelopes never leak into the next run.
 *
 * All smoothing uses measured dt (frame-rate independent) — never assumes 60fps.
 */
export class BandAnalysisEngine {
  /** Previous frame's FFT magnitudes (for positive-difference spectral flux). */
  private prev: Uint8Array<ArrayBuffer> | null = null;
  private level = [0, 0, 0];
  private env   = [0, 0, 0];
  private lastNow: number | null = null;

  reset(): void {
    this.prev = null;
    this.level[0] = this.level[1] = this.level[2] = 0;
    this.env[0]   = this.env[1]   = this.env[2]   = 0;
    this.lastNow = null;
  }

  /**
   * Read the analyser's current spectrum and update `out` in place with each
   * band's level + hit. `binWidth` is `ctx.sampleRate / FFT_SIZE` — bin indices
   * are always derived from it, never hardcoded.
   */
  analyse(
    analyser: AnalyserNode,
    data: Uint8Array<ArrayBuffer>,
    binWidth: number,
    nowMs: number,
    hits: HitResponseSettings,
    out: AnalysisFrame,
  ): void {
    analyser.getByteFrequencyData(data);

    // Measured seconds since the previous analysis frame, clamped so a tab
    // stall can't produce a huge integration step.
    const dt = this.lastNow === null
      ? 1 / 60
      : Math.min(0.1, Math.max(0.001, (nowMs - this.lastNow) / 1000));
    this.lastNow = nowMs;

    const prev = this.prev !== null && this.prev.length === data.length ? this.prev : null;

    for (let bi = 0; bi < BAND_KEYS.length; bi++) {
      const key = BAND_KEYS[bi];
      const { fLow, fHigh } = BAND_RANGES[key];
      // binIndex = round(freqHz / binWidth), clamped to the spectrum.
      const startBin = Math.max(0, Math.floor(fLow / binWidth));
      const endBin   = Math.min(data.length - 1, Math.ceil(fHigh / binWidth));
      const nBins    = Math.max(1, endBin - startBin + 1);

      // One pass per band: averaged energy (level) + positive-diff flux (hit).
      let sum = 0;
      let flux = 0;
      for (let i = startBin; i <= endBin; i++) {
        sum += data[i];
        if (prev !== null) {
          const d = data[i] - prev[i];
          if (d > 0) flux += d; // rising energy only — fades never register
        }
      }

      // LEVEL: averaged band energy 0–100, smoothed downstream so it keeps the
      // stable feel the old analyser smoothing provided.
      const target = ((sum / nBins) / 255) * 100;
      const tauL = target > this.level[bi] ? LEVEL_ATTACK_S : LEVEL_RELEASE_S;
      this.level[bi] += (1 - Math.exp(-dt / tauL)) * (target - this.level[bi]);

      // HIT: normalised flux shaped by the attack/decay envelope.
      const x = prev !== null
        ? Math.min(1, Math.max(0, (flux / nBins) * FLUX_SENSITIVITY[key]))
        : 0;
      const bandHit = hits[key];
      const attackS = Math.max(0.001, bandHit.attackMs / 1000);
      const decayS  = Math.max(0.005, bandHit.decayMs  / 1000);
      const tauE = x > this.env[bi] ? attackS : decayS;
      this.env[bi] += (1 - Math.exp(-dt / tauE)) * (x - this.env[bi]);

      const o = out[key];
      o.level = this.level[bi];
      o.hit   = Math.min(1, Math.max(0, this.env[bi])) * 100;
    }

    // Keep this frame's spectrum for the next flux comparison.
    if (this.prev === null || this.prev.length !== data.length) {
      this.prev = new Uint8Array(data.length);
    }
    this.prev.set(data);
  }
}
