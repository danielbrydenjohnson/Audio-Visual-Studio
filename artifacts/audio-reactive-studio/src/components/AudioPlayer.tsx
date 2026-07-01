import {
  useState,
  useEffect,
  useCallback,
  type RefObject,
  type SyntheticEvent,
} from "react";

export interface AudioPlayerProps {
  src: string;
  fileName: string;
  /** Ref owned by the parent — shared with the frequency-analysis hook. */
  audioRef: RefObject<HTMLAudioElement | null>;
  onChangeFile: () => void;
  /**
   * When true, the "Change" button is visually disabled and non-interactive.
   * Set this during recording so the audio source cannot be replaced mid-capture.
   */
  changeFileDisabled?: boolean;
  /** Called whenever play/pause state changes so the parent can react. */
  onPlayStateChange: (playing: boolean) => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  src,
  fileName,
  audioRef,
  onChangeFile,
  changeFileDisabled = false,
  onPlayStateChange,
}: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  // Reset all playback state when the source changes
  useEffect(() => {
    setIsPlaying(false);
    onPlayStateChange(false);
    setCurrentTime(0);
    setDuration(0);
    setSeekValue(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const handleLoadedMetadata = useCallback(
    (e: SyntheticEvent<HTMLAudioElement>) => {
      setDuration(e.currentTarget.duration);
    },
    []
  );

  const handleTimeUpdate = useCallback(
    (e: SyntheticEvent<HTMLAudioElement>) => {
      if (!isSeeking) {
        const t = e.currentTarget.currentTime;
        setCurrentTime(t);
        setSeekValue(t);
      }
    },
    [isSeeking]
  );

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    onPlayStateChange(false);
    setCurrentTime(0);
    setSeekValue(0);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioRef]);

  // Sync from the element's own play/pause events so ANY trigger — the button
  // or programmatic playback started by the recorder — keeps state consistent
  // and drives the frequency analyser.
  const handlePlay = useCallback(() => {
    setIsPlaying(true);
    onPlayStateChange(true);
  }, [onPlayStateChange]);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
    onPlayStateChange(false);
  }, [onPlayStateChange]);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => { /* autoplay policy — no-op */ });
    } else {
      audio.pause();
    }
  }, [audioRef]);

  // Seek slider handlers
  function handleSeekStart(e: React.ChangeEvent<HTMLInputElement>) {
    setIsSeeking(true);
    setSeekValue(Number(e.target.value));
  }

  function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSeekValue(Number(e.target.value));
  }

  function handleSeekEnd(e: React.ChangeEvent<HTMLInputElement>) {
    const t = Number(e.target.value);
    setSeekValue(t);
    setCurrentTime(t);
    if (audioRef.current) {
      audioRef.current.currentTime = t;
    }
    setIsSeeking(false);
  }

  const progress = duration > 0 ? (seekValue / duration) * 100 : 0;

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Audio element — ref is owned by App and shared with useFrequencyAnalysis */}
      <audio
        ref={audioRef}
        src={src}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPause={handlePause}
        preload="metadata"
      />

      {/* File info row */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="w-3.5 h-3.5 text-primary shrink-0"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M9 3v10.55A4 4 0 1 0 11 17V7h4V3H9z" />
          </svg>
          <span
            className="text-xs font-mono text-foreground/80 truncate"
            title={fileName}
          >
            {fileName}
          </span>
        </div>
        <button
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0 uppercase tracking-wider font-mono disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
          onClick={onChangeFile}
          disabled={changeFileDisabled}
          type="button"
          title={changeFileDisabled ? "Cannot change audio file while recording" : undefined}
        >
          Change
        </button>
      </div>

      {/* Transport row */}
      <div className="flex items-center gap-4">
        {/* Play / Pause */}
        <button
          onClick={togglePlayPause}
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          className="w-8 h-8 rounded-full bg-primary/10 border border-primary/40 hover:bg-primary/20 transition-colors flex items-center justify-center shrink-0"
        >
          {isPlaying ? (
            <svg className="w-3 h-3 text-primary" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="w-3 h-3 text-primary ml-0.5" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>

        {/* Current time */}
        <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0 tabular-nums">
          {formatTime(currentTime)}
        </span>

        {/* Seek slider */}
        <div className="relative flex-1 h-4 flex items-center">
          <div className="absolute inset-x-0 h-[3px] rounded-full bg-border/60" />
          <div
            className="absolute left-0 h-[3px] rounded-full bg-primary/70 pointer-events-none"
            style={{ width: `${progress}%` }}
          />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={seekValue}
            onChange={handleSeekChange}
            onMouseDown={handleSeekStart as unknown as React.MouseEventHandler}
            onTouchStart={handleSeekStart as unknown as React.TouchEventHandler}
            onMouseUp={handleSeekEnd as unknown as React.MouseEventHandler}
            onTouchEnd={handleSeekEnd as unknown as React.TouchEventHandler}
            className="relative w-full appearance-none bg-transparent cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none
              [&::-webkit-slider-thumb]:w-3
              [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full
              [&::-webkit-slider-thumb]:bg-primary
              [&::-webkit-slider-thumb]:shadow-sm
              [&::-moz-range-thumb]:w-3
              [&::-moz-range-thumb]:h-3
              [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-primary
              [&::-moz-range-thumb]:border-0"
            aria-label="Seek"
          />
        </div>

        {/* Duration */}
        <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0 tabular-nums text-right">
          {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
