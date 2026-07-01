import { useState, useRef, useCallback, useEffect } from "react";
import { AudioUpload } from "@/components/AudioUpload";
import { AudioPlayer } from "@/components/AudioPlayer";
import { FrequencyMeters } from "@/components/FrequencyMeters";
import { ParticleField } from "@/components/ParticleField";
import { useFrequencyAnalysis } from "@/hooks/useFrequencyAnalysis";
import {
  type VisualizerSettings,
  type ParticleVisualSettings,
  DEFAULT_SETTINGS,
  DEFAULT_VISUAL_SETTINGS,
} from "@/types/visualizer";

// ─── Shared control styles ────────────────────────────────────────────────────

/** Injected once — drives thumb colour via a CSS custom property on each input. */
const THUMB_STYLE = `
  input[type=range]::-webkit-slider-thumb { background: var(--thumb-color, #64748b); }
  input[type=range]::-moz-range-thumb     { background: var(--thumb-color, #64748b); border: 0; }
`;

// ─── BandSlider — for audio influence (0–200 %, coloured dots) ───────────────

interface BandSliderProps {
  label:    string;
  dot:      string;
  value:    number;
  onChange: (v: number) => void;
}

function BandSlider({ label, dot, value, onChange }: BandSliderProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: dot }} />
          <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
        </div>
        <span className="text-[11px] font-mono tabular-nums" style={{ color: dot }}>
          {value}%
        </span>
      </div>
      <div className="relative flex items-center h-4">
        <div className="absolute inset-x-0 h-[3px] rounded-full bg-border/50" />
        <div
          className="absolute left-0 h-[3px] rounded-full pointer-events-none"
          style={{ width: `${(value / 200) * 100}%`, backgroundColor: dot, opacity: 0.7 }}
        />
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="relative w-full appearance-none bg-transparent cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:w-3
            [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full"
          style={{ "--thumb-color": dot } as React.CSSProperties}
          aria-label={`${label} influence`}
        />
      </div>
    </div>
  );
}

// Band dot colours.
const BAND_DOTS = {
  low:  "#22d3ee",
  mid:  "#f59e0b",
  high: "#ec4899",
} as const;

// ─── ControlSlider — for visual settings ─────────────────────────────────────

interface ControlSliderProps {
  label:    string;
  value:    number;
  min:      number;
  max:      number;
  step?:    number;
  unit?:    string;
  onChange: (v: number) => void;
}

function ControlSlider({ label, value, min, max, step = 1, unit = "%", onChange }: ControlSliderProps) {
  const fillPct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
        <span className="text-[11px] font-mono tabular-nums text-foreground/70">
          {value}{unit}
        </span>
      </div>
      <div className="relative flex items-center h-4">
        <div className="absolute inset-x-0 h-[3px] rounded-full bg-border/50" />
        <div
          className="absolute left-0 h-[3px] rounded-full pointer-events-none bg-slate-400/60"
          style={{ width: `${fillPct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="relative w-full appearance-none bg-transparent cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:w-3
            [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full"
          aria-label={label}
        />
      </div>
    </div>
  );
}

// ─── ControlSelect — styled select for palette and density ───────────────────

interface SelectOption { value: string; label: string; }

interface ControlSelectProps {
  label:    string;
  value:    string;
  options:  SelectOption[];
  onChange: (v: string) => void;
}

function ControlSelect({ label, value, options, onChange }: ControlSelectProps) {
  return (
    <div className="space-y-1.5">
      <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full text-[11px] font-mono bg-muted/40 border border-border/60
          rounded-md px-2.5 py-1.5 text-foreground cursor-pointer
          hover:border-border focus:outline-none focus:ring-1 focus:ring-primary/40
          appearance-none"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center" }}
        aria-label={label}
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Section divider ──────────────────────────────────────────────────────────

function SectionDivider() {
  return <div className="border-t border-border/30 -mx-1" />;
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [audioUrl,  setAudioUrl]  = useState<string | null>(null);
  const [fileName,  setFileName]  = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [settings,       setSettings]       = useState<VisualizerSettings>(DEFAULT_SETTINGS);
  const [visualSettings, setVisualSettings] = useState<ParticleVisualSettings>(DEFAULT_VISUAL_SETTINGS);

  const audioRef      = useRef<HTMLAudioElement | null>(null);
  const currentUrlRef = useRef<string | null>(null);

  const bands = useFrequencyAnalysis(audioRef, isPlaying);

  // Revoke object URL on unmount.
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

  // Per-key helpers — each touch only the relevant state tree.
  function setSetting(key: keyof VisualizerSettings, value: number) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }
  function setVisual<K extends keyof ParticleVisualSettings>(key: K, value: ParticleVisualSettings[K]) {
    setVisualSettings(prev => ({ ...prev, [key]: value }));
  }

  const hasAudio = audioUrl !== null && fileName !== null;

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground flex flex-col overflow-hidden font-sans selection:bg-primary/30">
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

      {/* Main */}
      <main className="flex-1 flex overflow-hidden">

        {/* Canvas + transport */}
        <section className="flex-1 flex flex-col bg-muted/10 p-6 gap-4 relative isolate overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] -z-10" />

          <div className="flex-1 border border-border/40 rounded-xl bg-black shadow-2xl relative overflow-hidden min-h-0">
            <ParticleField
              low={bands.low}
              mid={bands.mid}
              high={bands.high}
              settings={settings}
              visualSettings={visualSettings}
            />
            <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary/40 rounded-tl-lg pointer-events-none z-10" />
            <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary/40 rounded-tr-lg pointer-events-none z-10" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary/40 rounded-bl-lg pointer-events-none z-10" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary/40 rounded-br-lg pointer-events-none z-10" />
          </div>

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

          <div className="flex-1 overflow-y-auto p-5 space-y-7">

            {/* ── Audio Reaction Section ── */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-3 bg-primary/70 rounded-full" />
                  <h3 className="text-sm font-medium text-foreground">Audio Reaction</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSettings(DEFAULT_SETTINGS)}
                  className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
                  title="Reset audio influence to defaults"
                >
                  Reset Audio
                </button>
              </div>

              <div className="space-y-4">
                <BandSlider label="Low Influence"  dot={BAND_DOTS.low}  value={settings.low}  onChange={v => setSetting("low",  v)} />
                <BandSlider label="Mid Influence"  dot={BAND_DOTS.mid}  value={settings.mid}  onChange={v => setSetting("mid",  v)} />
                <BandSlider label="High Influence" dot={BAND_DOTS.high} value={settings.high} onChange={v => setSetting("high", v)} />
              </div>
            </div>

            {/* ── Particle Field Section ── */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-3 bg-chart-2/70 rounded-full" />
                  <h3 className="text-sm font-medium text-foreground">Particle Field</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setVisualSettings(DEFAULT_VISUAL_SETTINGS)}
                  className="text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
                  title="Reset all visual settings to defaults"
                >
                  Reset Visuals
                </button>
              </div>

              <div className="space-y-4">
                <ControlSelect
                  label="Particle Density"
                  value={visualSettings.density}
                  options={[
                    { value: "low",    label: "Low — 750 particles" },
                    { value: "medium", label: "Medium — 1,500 particles" },
                    { value: "high",   label: "High — 3,000 particles" },
                  ]}
                  onChange={v => setVisual("density", v as ParticleVisualSettings["density"])}
                />
                <ControlSlider
                  label="Motion Speed"
                  value={visualSettings.speed}
                  min={25}
                  max={200}
                  onChange={v => setVisual("speed", v)}
                />
                <ControlSlider
                  label="Particle Size"
                  value={visualSettings.particleSize}
                  min={50}
                  max={200}
                  onChange={v => setVisual("particleSize", v)}
                />
                <ControlSlider
                  label="Depth"
                  value={visualSettings.depth}
                  min={50}
                  max={200}
                  onChange={v => setVisual("depth", v)}
                />
              </div>

              <SectionDivider />

              <div className="space-y-4">
                <ControlSelect
                  label="Palette"
                  value={visualSettings.palette}
                  options={[
                    { value: "cyanViolet", label: "Cyan Violet" },
                    { value: "monochrome", label: "Monochrome" },
                    { value: "ember",      label: "Ember" },
                  ]}
                  onChange={v => setVisual("palette", v as ParticleVisualSettings["palette"])}
                />
                <ControlSlider
                  label="Glow"
                  value={visualSettings.glow}
                  min={0}
                  max={100}
                  onChange={v => setVisual("glow", v)}
                />
              </div>
            </div>

          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
