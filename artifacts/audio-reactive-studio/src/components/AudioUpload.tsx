import { useRef, type DragEvent, type ChangeEvent } from "react";

interface AudioUploadProps {
  onFile: (file: File) => void;
}

const ACCEPTED_MIME = ["audio/mpeg", "audio/wav", "audio/wave", "audio/x-wav"];
const ACCEPTED_EXT = [".mp3", ".wav"];

function isAccepted(file: File): boolean {
  if (ACCEPTED_MIME.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return ACCEPTED_EXT.some((ext) => name.endsWith(ext));
}

export function AudioUpload({ onFile }: AudioUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef(false);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!isAccepted(file)) return;
    onFile(file);
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    handleFiles(e.target.files);
    // Reset so the same file can be re-selected
    e.target.value = "";
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragRef.current = false;
    handleFiles(e.dataTransfer.files);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragRef.current = true;
  }

  return (
    <div
      className="flex flex-col items-center justify-center gap-3 h-full cursor-pointer select-none"
      onClick={() => inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={() => { dragRef.current = false; }}
    >
      {/* Upload icon */}
      <svg
        className="w-6 h-6 text-muted-foreground/50"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>

      <div className="flex flex-col items-center gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          Drop an audio file or{" "}
          <span className="text-primary underline underline-offset-2">browse</span>
        </span>
        <span className="text-[10px] text-muted-foreground/50 font-mono uppercase tracking-wider">
          MP3 · WAV
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,audio/mpeg,audio/wav"
        className="hidden"
        onChange={handleChange}
      />
    </div>
  );
}
