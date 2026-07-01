import { useState, useRef, useCallback, useEffect } from "react";
import { AudioUpload } from "@/components/AudioUpload";
import { AudioPlayer } from "@/components/AudioPlayer";
import { FrequencyMeters } from "@/components/FrequencyMeters";
import { ParticleCanvas } from "@/components/ParticleCanvas";
import { useFrequencyAnalysis } from "@/hooks/useFrequencyAnalysis";
import {
  type VisualizerSettings,
  DEFAULT_SETTINGS,
} from "@/types/visualizer";

// ─── Slider sub-component ─────────────────────────────────────────────────────

interface BandSliderProps {
  label:    string;
  dot:      string; // hex colour for the indicator dot
  value:    number;
  onChange: (v: number) => void;
}

function BandSlider({ label, dot, value, onChange }: BandSliderProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: dot }}
          />
          <span className="text-[11px] font-mono text-muted-foreground">
            {label}
          </span>
        </div>
        <span className="text-[11px] font-mono tabular-nums" style={{ color: dot }}>
          {value}%
        </span>
      </div>
      <div className="relative flex items-center h-4">
        {/* Track background */}
        <div className="absolute inset-x-0 h-[3px] rounded-full bg-border/50" />
        {/* Filled portion */}
        <div
          className="absolute left-0 h-[3px] rounded-full pointer-events-none"
          style={{
            width:           `${(value / 200) * 100}%`,
            backgroundColor: dot,
            opacity:         0.7,
          }}
        />
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="relative w-full appearance-none bg-transparent cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:shadow-sm
            [&::-moz-range-thumb]:w-3
            [&::-moz-range-thumb]:h-3
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:border-0"
          style={
            {
              "--thumb-color": dot,
              // CSS custom property used by the thumb pseudo-element below
            } as React.CSSProperties
          }
          aria-label={`${label} influence`}
        />
      </div>
    </div>
  );
}

// Thumb colour via a tiny injected rule — avoids duplicating Tailwind JIT classes
// for every colour variant.
const THUMB_STYLE = `
  input[type=range]::-webkit-slider-thumb { background: var(--thumb-color); }
  input[type=range]::-moz-range-thumb     { background: var(--thumb-color); }
`;

// Band dot colours — match the PALETTE in ParticleCanvas and the frequency meters.
const BAND_DOTS = {
  sub:  "#22d3ee", // cyan-400
  low:  "#8b5cf6", // violet-500
  mid:  "#f59e0b", // amber-500
  high: "#ec4899", // pink-500
} as const;

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [audioUrl,  setAudioUrl]  = useState<string | null>(null);
  const [fileName,  setFileName]  = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [settings,  setSettings]  = useState<VisualizerSettings>(DEFAULT_SETTINGS);

  const audioRef      = useRef<HTMLAudioElement | null>(null);
  const currentUrlRef = useRef<string | null>(null);

  const bands = useFrequencyAnalysis(audioRef, isPlaying);

  // Revoke current object URL on unmount.
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
    };
  }, []);

  const handleFile = useCallback((file: File) => {
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    const url = URL.createObjectURL(file);
    currentUrlRef.current = url;
    setAudioUrl(url);
    setFileName(file.name);
    setIsPlaying(false);
  }, []);

  const handleChangeFile = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
    setAudioUrl(null);
    setFileName(null);
    setIsPlaying(false);
  }, []);

  function setSetting(key: keyof VisualizerSettings, value: number) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  const hasAudio = audioUrl !== null && fileName !== null;

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground flex flex-col overflow-hidden font-sans selection:bg-primary/30">
      {/* Inject thumb-colour rule */}
      <style>{THUMB_STYLE}</style>

      {/* Header */}
      <header className="h-14 border-b border-border/60 flex items-center px-6 shrink-0 bg-background z-20">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 rounded-full bg-primary/10 border border-primary/50 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          </div>
          <h1 className="font-semibold text-sm tracking-wide text-foreground">
            Audio Reactive Studio
          </h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">

        {/* Left column: canvas preview + transport */}
        <section className="flex-1 flex flex-col bg-muted/10 p-6 gap-4 relative isolate overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] -z-10" />

          {/* Canvas preview */}
          <div className="flex-1 border border-border/40 rounded-xl bg-black shadow-2xl relative overflow-hidden min-h-0">
            <ParticleCanvas
              sub={bands.sub}
              low={bands.low}
              mid={bands.mid}
              high={bands.high}
              settings={settings}
            />
            <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary/40 rounded-tl-lg pointer-events-none z-10" />
            <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary/40 rounded-tr-lg pointer-events-none z-10" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary/40 rounded-bl-lg pointer-events-none z-10" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary/40 rounded-br-lg pointer-events-none z-10" />
          </div>

          {/* Transport strip */}
          <div className="rounded-xl border border-border/40 bg-card/60 backdrop-blur-sm px-5 py-4 flex flex-col gap-4 shrink-0">
            {hasAudio ? (
              <>
                <AudioPlayer
                  src={audioUrl}
                  fileName={fileName}
                  audioRef={audioRef}
                  onChangeFile={handleChangeFile}
                  onPlayStateChange={setIsPlaying}
                />
                <FrequencyMeters bands={bands} />
              </>
            ) : (
              <div className="h-14 flex items-center">
                <AudioUpload onFile={handleFile} />
              </div>
            )}
          </div>
        </section>

        {/* Controls Panel */}
        <aside className="w-[300px] border-l border-border/60 bg-card flex flex-col shrink-0 overflow-hidden relative z-10 shadow-xl">
          <div className="h-14 border-b border-border/60 flex items-center px-5 shrink-0 bg-card">
            <h2 className="font-medium text-[11px] tracking-[0.15em] uppercase text-muted-foreground">
              Controls
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-8">

            {/* ── Visualizer Section ── */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-3 bg-primary/70 rounded-full" />
                  <h3 className="text-sm font-medium text-foreground">Visualizer</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSettings(DEFAULT_SETTINGS)}
                  className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
                >
                  Reset
                </button>
              </div>

              <div className="space-y-4 pt-0.5">
                <BandSlider
                  label="Sub Influence"
                  dot={BAND_DOTS.sub}
                  value={settings.sub}
                  onChange={v => setSetting("sub", v)}
                />
                <BandSlider
                  label="Low Influence"
                  dot={BAND_DOTS.low}
                  value={settings.low}
                  onChange={v => setSetting("low", v)}
                />
                <BandSlider
                  label="Mid Influence"
                  dot={BAND_DOTS.mid}
                  value={settings.mid}
                  onChange={v => setSetting("mid", v)}
                />
                <BandSlider
                  label="High Influence"
                  dot={BAND_DOTS.high}
                  value={settings.high}
                  onChange={v => setSetting("high", v)}
                />
              </div>
            </div>

            {/* ── Color & Post Section (placeholder) ── */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-3 bg-chart-2/70 rounded-full" />
                <h3 className="text-sm font-medium text-foreground">Color & Post</h3>
              </div>
              <div className="h-28 rounded-lg border border-border/40 bg-muted/20 flex flex-col items-center justify-center gap-2">
                <div className="flex gap-2">
                  <div className="w-4 h-4 rounded-full bg-chart-1 shadow-sm" />
                  <div className="w-4 h-4 rounded-full bg-chart-2 shadow-sm" />
                  <div className="w-4 h-4 rounded-full bg-chart-3 shadow-sm" />
                </div>
                <span className="text-[11px] text-muted-foreground font-medium mt-1">
                  Palette & Effects
                </span>
              </div>
            </div>

            {/* ── Output Section (placeholder) ── */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-3 bg-chart-3/70 rounded-full" />
                <h3 className="text-sm font-medium text-foreground">Output</h3>
              </div>
              <div className="h-20 rounded-lg border border-border/40 bg-muted/20 flex items-center justify-center">
                <span className="text-[11px] text-muted-foreground font-medium">
                  Resolution & Export
                </span>
              </div>
            </div>

          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
