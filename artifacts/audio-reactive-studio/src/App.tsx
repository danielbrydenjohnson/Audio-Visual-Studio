import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { AudioUpload } from "@/components/AudioUpload";
import { AudioPlayer } from "@/components/AudioPlayer";
import { AudioSourceSelector } from "@/components/AudioSourceSelector";
import { LiveInputPanel } from "@/components/LiveInputPanel";
import { FrequencyMeters } from "@/components/FrequencyMeters";
import { Visualizer } from "@/components/Visualizer";
import { RecordingPanel } from "@/components/RecordingPanel";
import { useFrequencyAnalysis } from "@/hooks/useFrequencyAnalysis";
import { useLiveInputAnalysis } from "@/hooks/useLiveInputAnalysis";
import { useRecorder } from "@/hooks/useRecorder";
import {
  type AudioSourceMode,
  DEFAULT_AUDIO_SOURCE_MODE,
} from "@/types/audioSource";
import {
  type VisualizerSettings,
  type ParticleVisualSettings,
  type KaleidoscopeDirection,
  DEFAULT_SETTINGS,
  DEFAULT_VISUAL_SETTINGS,
} from "@/types/visualizer";
import {
  type VisualTemplateId,
  VISUAL_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  getTemplateMeta,
} from "@/visuals/types";
import {
  type OutputSettings,
  type OutputFormatId,
  type AspectRatioId,
  type ResolutionId,
  type FrameRateId,
  DEFAULT_OUTPUT_SETTINGS,
  getOutputDimensions,
  formatLabelOf,
  isFormatSupported,
  formatDisplayName,
  ASPECT_OPTIONS,
  RESOLUTION_OPTIONS,
  FRAME_RATE_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
} from "@/types/output";

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
  label:     string;
  value:     string;
  options:   SelectOption[];
  disabled?: boolean;
  onChange:  (v: string) => void;
}

function ControlSelect({ label, value, options, disabled = false, onChange }: ControlSelectProps) {
  return (
    <div className={`space-y-1.5 ${disabled ? "opacity-50" : ""}`}>
      <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="w-full text-[11px] font-mono bg-muted/40 border border-border/60
          rounded-md px-2.5 py-1.5 text-foreground cursor-pointer
          hover:border-border focus:outline-none focus:ring-1 focus:ring-primary/40
          appearance-none disabled:cursor-not-allowed"
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

// ─── ControlToggle — on/off switch ───────────────────────────────────────────

interface ControlToggleProps {
  label:     string;
  value:     boolean;
  disabled?: boolean;
  onChange:  (v: boolean) => void;
}

function ControlToggle({ label, value, disabled = false, onChange }: ControlToggleProps) {
  return (
    <div className={`flex items-center justify-between ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          value ? "bg-primary/70" : "bg-muted/60 border border-border/60"
        } disabled:cursor-not-allowed`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

// ─── Section divider ──────────────────────────────────────────────────────────

function SectionDivider() {
  return <div className="border-t border-border/30 -mx-1" />;
}

// ─── TemplateSelector — selectable cards for the three visual templates ───────

interface TemplateSelectorProps {
  value:    VisualTemplateId;
  onChange: (id: VisualTemplateId) => void;
}

function TemplateSelector({ value, onChange }: TemplateSelectorProps) {
  const active = getTemplateMeta(value);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        {VISUAL_TEMPLATES.map(t => {
          const selected = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              aria-pressed={selected}
              className={`rounded-md border px-2 py-2 text-[10px] font-mono leading-tight text-center transition-colors ${
                selected
                  ? "border-primary/70 bg-primary/15 text-primary"
                  : "border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:text-foreground"
              }`}
              title={t.description}
            >
              {t.name}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] font-mono leading-relaxed text-muted-foreground/70">
        {active.description}
      </p>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [audioUrl,  setAudioUrl]  = useState<string | null>(null);
  const [fileName,  setFileName]  = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [settings,       setSettings]       = useState<VisualizerSettings>(DEFAULT_SETTINGS);
  const [visualSettings, setVisualSettings] = useState<ParticleVisualSettings>(DEFAULT_VISUAL_SETTINGS);
  const [templateId,     setTemplateId]     = useState<VisualTemplateId>(DEFAULT_TEMPLATE_ID);
  const [output,               setOutput]               = useState<OutputSettings>(DEFAULT_OUTPUT_SETTINGS);
  const [perfWarning,          setPerfWarning]          = useState(false);
  const [audioSourceMode,      setAudioSourceMode]      = useState<AudioSourceMode>(DEFAULT_AUDIO_SOURCE_MODE);

  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const audioRef      = useRef<HTMLAudioElement | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  // Lets the live-input hook stop an in-flight recording if the mic drops out,
  // without a circular dependency on the recorder (assigned just below).
  const stopRecordingRef = useRef<() => void>(() => { /* noop until wired */ });

  const isLive = audioSourceMode === "live-input";

  // Uploaded-track analysis is gated off while in live mode so its bands fade to
  // zero and it never fights the live analyser for the meters/visuals.
  const uploaded  = useFrequencyAnalysis(audioRef, isPlaying && !isLive);
  const liveInput = useLiveInputAnalysis({
    onUnexpectedEnd: () => { stopRecordingRef.current(); },
  });

  const ensureAudioGraph = uploaded.ensureAudioGraph;
  // The renderer + meters are source-agnostic: they only ever see Low/Mid/High.
  const bands = isLive ? liveInput.bands : uploaded.bands;

  // Exact recording dimensions + filename label derived from the output format.
  const outputDims  = getOutputDimensions(output.aspectRatio, output.resolution);
  const formatLabel = formatLabelOf(output);

  // Whether the currently-selected container can be natively recorded here, plus
  // the small status text shown beneath the Output Format control.
  const selectedFormatSupported = useMemo(() => isFormatSupported(output.format), [output.format]);
  const otherFormat: OutputFormatId = output.format === "mp4" ? "webm" : "mp4";
  const formatStatusText = selectedFormatSupported
    ? (output.format === "mp4" ? "Native MP4 supported" : "WebM supported")
    : `${formatDisplayName(output.format)} unavailable in this browser`;

  const recorder = useRecorder({
    audioRef, canvas, ensureAudioGraph,
    mode: audioSourceMode,
    getLiveAudio: liveInput.getRecordingAudio,
    liveActive: liveInput.isActive,
    // Live captures need no uploaded file — the base name becomes "live-input".
    fileName: isLive ? "live-input" : fileName,
    frameRate: output.frameRate, formatLabel,
    format: output.format,
    aspectRatio: output.aspectRatio,
    resolution: output.resolution,
  });

  // Wire the mic-drop safety stop now that the recorder exists.
  stopRecordingRef.current = recorder.stop;

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
  const recordingLocked = recorder.status === "recording" || recorder.status === "starting";

  // Switch between uploaded-track and live-input. Uploaded→live pauses playback
  // (keeping the file in memory); live→uploaded releases the microphone. Blocked
  // entirely while recording so the source can't change mid-capture.
  const handleModeChange = useCallback((next: AudioSourceMode) => {
    if (recordingLocked || next === audioSourceMode) return;
    if (next === "live-input") {
      const a = audioRef.current;
      if (a && !a.paused) a.pause();
      setIsPlaying(false);
    } else {
      liveInput.stop(); // release the mic + turn off the browser indicator
    }
    setAudioSourceMode(next);
  }, [recordingLocked, audioSourceMode, liveInput]);

  // Stopping live input during a recording cleanly ends the recording first.
  const handleStopLive = useCallback(() => {
    if (recorder.status === "recording") recorder.stop();
    liveInput.stop();
  }, [recorder, liveInput]);

  // ── Fullscreen ──────────────────────────────────────────────────────────────
  // Only the visualizer stage goes fullscreen, so every control (transport,
  // sliders, panels) is physically outside the fullscreen element and cannot be
  // interacted with. Esc or the small ✕ button exits.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current && stageRef.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen().catch(() => { /* denied or unsupported */ });
    }
  }, []);

  // Output format is locked during recording so it can't change mid-capture.
  function setOutputSetting<K extends keyof OutputSettings>(key: K, value: OutputSettings[K]) {
    if (recordingLocked) return;
    setOutput(prev => ({ ...prev, [key]: value }));
  }

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

          <div
            ref={stageRef}
            className={`flex-1 bg-black relative overflow-hidden min-h-0 ${
              isFullscreen ? "" : "border border-border/40 rounded-xl shadow-2xl"
            }`}
          >
            <Visualizer
              low={bands.low}
              mid={bands.mid}
              high={bands.high}
              settings={settings}
              visualSettings={visualSettings}
              templateId={templateId}
              outputWidth={outputDims.width}
              outputHeight={outputDims.height}
              frameRate={output.frameRate}
              onCanvasReady={setCanvas}
              onPerformanceWarning={setPerfWarning}
            />
            {/* Active template name — hidden in fullscreen (pure visual mode) */}
            {!isFullscreen && (
              <div className="absolute top-3 left-3 z-10 pointer-events-none">
                <div className="flex items-center gap-2 rounded-md bg-black/40 backdrop-blur-sm border border-border/40 px-2.5 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  <span className="text-[10px] font-mono tracking-wide text-foreground/80">
                    {getTemplateMeta(templateId).name}
                  </span>
                </div>
              </div>
            )}
            {/* Fullscreen toggle */}
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              className="absolute top-3 right-3 z-10 flex items-center justify-center w-8 h-8 rounded-md
                bg-black/40 backdrop-blur-sm border border-border/40 text-foreground/70
                hover:text-foreground hover:border-border transition-colors"
            >
              {isFullscreen ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
            {!isFullscreen && (
              <>
                <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary/40 rounded-tl-lg pointer-events-none z-10" />
                <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary/40 rounded-tr-lg pointer-events-none z-10" />
                <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary/40 rounded-bl-lg pointer-events-none z-10" />
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary/40 rounded-br-lg pointer-events-none z-10" />
              </>
            )}
          </div>

          <div className="rounded-xl border border-border/40 bg-card/60 backdrop-blur-sm px-5 py-4 flex flex-col gap-4 shrink-0">
            <AudioSourceSelector
              value={audioSourceMode}
              disabled={recordingLocked}
              onChange={handleModeChange}
            />

            {isLive ? (
              <>
                <LiveInputPanel
                  status={liveInput.status}
                  error={liveInput.error}
                  devices={liveInput.devices}
                  selectedDeviceId={liveInput.selectedDeviceId}
                  isActive={liveInput.isActive}
                  recording={recordingLocked}
                  onSelectDevice={liveInput.setSelectedDeviceId}
                  onStart={liveInput.start}
                  onStop={handleStopLive}
                />
                <FrequencyMeters bands={bands} />
              </>
            ) : hasAudio ? (
              <>
                <AudioPlayer
                  src={audioUrl}
                  fileName={fileName}
                  audioRef={audioRef}
                  onChangeFile={handleChangeFile}
                  changeFileDisabled={recordingLocked}
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

            {/* ── Visualizer Section ── */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-3 bg-chart-2/70 rounded-full" />
                  <h3 className="text-sm font-medium text-foreground">Visualizer</h3>
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

              {/* Template selector — locked while recording so the visual can't
                  change halfway through a capture. */}
              <TemplateSelector
                value={templateId}
                onChange={setTemplateId}
              />

              <SectionDivider />

              <div className="space-y-4">
                <ControlSelect
                  label="Visual Density"
                  value={visualSettings.density}
                  options={[
                    { value: "low",    label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high",   label: "High" },
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
                  label="Element Size"
                  value={visualSettings.elementSize}
                  min={50}
                  max={200}
                  onChange={v => setVisual("elementSize", v)}
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
                    { value: "monochrome", label: "Monochrome" },
                    { value: "cyanViolet", label: "Cyan Violet" },
                    { value: "ember",      label: "Ember" },
                    { value: "aurora",     label: "Aurora" },
                    { value: "sunset",     label: "Sunset" },
                    { value: "oceanic",    label: "Oceanic" },
                    { value: "plasma",     label: "Plasma" },
                    { value: "neonMint",   label: "Neon Mint" },
                    { value: "rose",       label: "Rose" },
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
                <ControlSlider
                  label="Brightness"
                  value={visualSettings.brightness}
                  min={50}
                  max={200}
                  onChange={v => setVisual("brightness", v)}
                />

                <ControlToggle
                  label="Kaleidoscope"
                  value={visualSettings.kaleidoscope}
                  onChange={v => setVisual("kaleidoscope", v)}
                />
                {visualSettings.kaleidoscope && (
                  <>
                    <ControlSelect
                      label="Kaleidoscope Segments"
                      value={String(visualSettings.kaleidoscopeSegments)}
                      options={[
                        { value: "4",  label: "4 segments" },
                        { value: "6",  label: "6 segments" },
                        { value: "8",  label: "8 segments" },
                        { value: "10", label: "10 segments" },
                        { value: "12", label: "12 segments" },
                      ]}
                      onChange={v => setVisual("kaleidoscopeSegments", Number(v))}
                    />
                    <ControlToggle
                      label="Kaleidoscope Rotate"
                      value={visualSettings.kaleidoscopeRotate}
                      onChange={v => setVisual("kaleidoscopeRotate", v)}
                    />
                    {/* Direction — two-button segmented control */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-mono text-muted-foreground">Rotation Direction</span>
                      <div className="grid grid-cols-2 gap-1.5">
                        {(["clockwise", "counterclockwise"] as KaleidoscopeDirection[]).map(dir => {
                          const selected = visualSettings.kaleidoscopeDirection === dir;
                          return (
                            <button
                              key={dir}
                              type="button"
                              aria-pressed={selected}
                              onClick={() => setVisual("kaleidoscopeDirection", dir)}
                              className={`rounded-md border px-2 py-1.5 text-[10px] font-mono text-center transition-colors ${
                                selected
                                  ? "border-primary/70 bg-primary/15 text-primary"
                                  : "border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:text-foreground"
                              }`}
                            >
                              {dir === "clockwise" ? "Clockwise" : "C-clockwise"}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <ControlSlider
                      label={`Rotation Speed`}
                      value={visualSettings.kaleidoscopeSpeed}
                      min={0}
                      max={200}
                      onChange={v => setVisual("kaleidoscopeSpeed", v)}
                    />
                  </>
                )}
              </div>
            </div>

            {/* ── Output / Recording Section ── */}
            <RecordingPanel
              recorder={recorder}
              notReadyHint={isLive ? "Start Live Input to enable recording" : undefined}
            >
              <div className="space-y-4">
                {isLive && (
                  <p className="text-[10px] font-mono leading-relaxed text-muted-foreground/70 bg-muted/30 border border-border/40 rounded-md px-2.5 py-2">
                    Live input recordings stop manually — press Stop when you're done.
                  </p>
                )}
                <div className="space-y-2">
                  <ControlSelect
                    label="Output Format"
                    value={output.format}
                    disabled={recordingLocked}
                    options={OUTPUT_FORMAT_OPTIONS}
                    onChange={v => setOutputSetting("format", v as OutputFormatId)}
                  />
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${selectedFormatSupported ? "bg-emerald-500" : "bg-amber-500"}`}
                    />
                    <span className="text-[10px] font-mono text-muted-foreground/70">
                      {formatStatusText}
                    </span>
                  </div>
                </div>

                {/* Native format unavailable: block recording + offer a one-click
                    switch (never silently record the other container or mislabel
                    the file). */}
                {!selectedFormatSupported && (
                  <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
                    <p className="text-[10px] font-mono leading-relaxed text-amber-400/90">
                      Native {formatDisplayName(output.format)} recording isn’t available in this
                      browser. Switch to {formatDisplayName(otherFormat)} to record.
                    </p>
                    <button
                      type="button"
                      onClick={() => setOutputSetting("format", otherFormat)}
                      disabled={recordingLocked}
                      className="w-full rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[10px] font-mono text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Switch to {formatDisplayName(otherFormat)}
                    </button>
                  </div>
                )}

                <ControlSelect
                  label="Aspect Ratio"
                  value={output.aspectRatio}
                  disabled={recordingLocked}
                  options={ASPECT_OPTIONS}
                  onChange={v => setOutputSetting("aspectRatio", v as AspectRatioId)}
                />
                <ControlSelect
                  label="Resolution"
                  value={output.resolution}
                  disabled={recordingLocked}
                  options={RESOLUTION_OPTIONS}
                  onChange={v => setOutputSetting("resolution", v as ResolutionId)}
                />
                <ControlSelect
                  label="Frame Rate"
                  value={String(output.frameRate)}
                  disabled={recordingLocked}
                  options={FRAME_RATE_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))}
                  onChange={v => setOutputSetting("frameRate", Number(v) as FrameRateId)}
                />

                {output.resolution === "4k" && (
                  <p className="text-[10px] font-mono leading-relaxed text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-2">
                    {output.frameRate === 60
                      ? "4K at 60 fps is highly demanding and may not record smoothly on all devices."
                      : "4K recording is demanding and may drop frames on some devices. Test with a short clip first."}
                  </p>
                )}
                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/70">
                  <span>Recording</span>
                  <span className="tabular-nums text-foreground/60">
                    {formatDisplayName(output.format)} · {outputDims.width} × {outputDims.height} · {output.frameRate} fps
                  </span>
                </div>

                {recordingLocked && (
                  <p className="text-[9px] font-mono text-amber-400/80 uppercase tracking-wider">
                    Output format locked while recording
                  </p>
                )}
                {perfWarning && (
                  <p className="text-[10px] font-mono leading-relaxed text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-2">
                    Rendering is dropping frames at {outputDims.width} × {outputDims.height} · {output.frameRate} fps.
                    For smoother output, lower the resolution or frame rate.
                  </p>
                )}
              </div>
            </RecordingPanel>

          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
