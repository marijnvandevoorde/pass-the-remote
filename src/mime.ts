/** Audio file extension → MIME type. Lowercase keys. */
const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
};

export const AUDIO_EXTS: ReadonlyArray<string> = Object.keys(MIME);

export function extToMime(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}
