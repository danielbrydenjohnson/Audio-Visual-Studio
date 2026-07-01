import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type SyntheticEvent,
} from "react";

interface AudioPlayerProps {
  src: string;
  fileName: string;
  onChangeFile: () => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ src, fileName, onChangeFile }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  // Reset state when src changes
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSeekValue(0);
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
    setCurrentTime(0);
    setSeekValue(0);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
    }
  }, []);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(() => {
        /* autoplay policy — no-op */
      });
      setIsPlaying(true);
    }
  }, [isPlaying]);

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
      {/* Hidden native audio element */}
      <audio
        ref={audioRef}
        src={src}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        preload="metadata"
      />

      {/* File info row */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          {/* Music note icon */}
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
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0 uppercase tracking-wider font-mono"
          onClick={onChangeFile}
          type="button"
        >
          Change
        </button>
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-4">
        {/* Play / Pause button */}
        <button
          onClick={togglePlayPause}
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          className="w-8 h-8 rounded-full bg-primary/10 border border-primary/40 hover:bg-primary/20 transition-colors flex items-center justify-center shrink-0"
        >
          {isPlaying ? (
            /* Pause icon */
            <svg className="w-3 h-3 text-primary" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            /* Play icon — shifted right 1px for optical centering */
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
          {/* Track background */}
          <div className="absolute inset-x-0 h-[3px] rounded-full bg-border/60" />
          {/* Filled track */}
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
