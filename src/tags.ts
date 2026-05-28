// Reads title/artist/album/duration from any audio container ffprobe
// understands (mp3 ID3, flac/ogg/opus Vorbis comments, m4a/mp4 atoms,
// wav INFO, etc.). Spawns the system `ffprobe` binary — there is
// deliberately no npm dependency here, matching the project's
// zero-runtime-deps policy. If ffprobe isn't on PATH or returns
// nothing useful, callers fall back to filename heuristics.

import { spawn } from "node:child_process";

export interface AudioTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
}

/** Returns parsed tags + duration, or `null` if ffprobe is missing /
 *  unusable for this file. Never throws — failures resolve to null. */
export async function readTags(absPath: string): Promise<AudioTags | null> {
  const json = await runFfprobe(absPath);
  if (json === null) return null;
  const fmt = obj(json["format"]);
  const tags = lcKeys(obj(fmt["tags"]));
  // ffprobe also exposes per-stream tags; some containers (notably
  // Ogg Vorbis / Opus) put them there instead of on `format`. First
  // stream that has any of the three wins.
  const streams = Array.isArray(json["streams"]) ? json["streams"] : [];
  let streamTags: Record<string, unknown> = {};
  for (const s of streams) {
    const st = lcKeys(obj(obj(s)["tags"]));
    if (st["title"] || st["artist"] || st["album"]) {
      streamTags = st;
      break;
    }
  }
  const get = (k: string): string | null =>
    pickStr(tags[k]) ?? pickStr(streamTags[k]) ?? null;
  const durationRaw = Number(fmt["duration"]);
  return {
    title: get("title"),
    artist: get("artist") ?? get("album_artist"),
    album: get("album"),
    durationSec: Number.isFinite(durationRaw) && durationRaw > 0
      ? durationRaw
      : null,
  };
}

/** Spawns `ffprobe -of json` and returns parsed stdout, or null on
 *  any failure (binary missing, non-zero exit, malformed JSON). */
function runFfprobe(absPath: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        "ffprobe",
        [
          "-v", "error",
          "-show_format",
          "-show_streams",
          "-of", "json",
          absPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    proc.stdout.on("data", (b: Buffer) => out.push(b));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
        resolve(parsed !== null && typeof parsed === "object" ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** ffprobe normalises tag-key case across container types differently
 *  (Vorbis comments stay uppercase, ID3v2 frames get lowercased, etc.).
 *  Lowercasing here lets the caller use a single canonical key. */
function lcKeys(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k.toLowerCase()] = v;
  return out;
}

function pickStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
