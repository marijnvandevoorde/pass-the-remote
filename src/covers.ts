// Cover art for search results: a picture next to the track
// (`<track>.jpg`, the Pass the Aux library layout), the art embedded in
// the file, or a folder picture (cover.jpg, folder.jpg, front.jpg,
// album.jpg). Thumbnails are made with the system `ffmpeg` (ships in the
// Docker image) and kept in a small in-memory cache. Without ffmpeg a
// picture file is served as is and embedded art is unavailable.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Track } from "./db.ts";

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const FOLDER_NAMES = ["cover", "folder", "front", "album"];
const THUMB_PX = 300;
const CACHE_MAX = 300;
const FFMPEG_TIMEOUT_MS = 10_000;

function imageExt(name: string): string | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext in IMAGE_MIME ? ext : null;
}

/** The picture file to use for `fileName` among a folder's `entries`:
 *  one with the same base name first, then a folder picture. Returns an
 *  entry name, or null. Case-insensitive. */
export function pickCoverFile(fileName: string, entries: readonly string[]): string | null {
  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const images = entries.filter((e) => !e.startsWith(".") && imageExt(e) !== null);
  const sibling = images.find((e) => path.basename(e, path.extname(e)).toLowerCase() === base);
  if (sibling !== undefined) return sibling;
  for (const name of FOLDER_NAMES) {
    const hit = images.find((e) => path.basename(e, path.extname(e)).toLowerCase() === name);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Whether `coverRel` is the track's own picture (same base name). */
function isSibling(t: Pick<Track, "rel_path">, coverRel: string): boolean {
  const strip = (p: string): string => path.basename(p, path.extname(p)).toLowerCase();
  return strip(coverRel) === strip(t.rel_path);
}

export type CoverSource = { kind: "file"; rel: string } | { kind: "embedded" };

/** Where a track's cover comes from, or null when it has none. */
export function coverSource(
  t: Pick<Track, "rel_path" | "cover_path" | "embedded_art">,
): CoverSource | null {
  if (t.cover_path !== null && isSibling(t, t.cover_path)) return { kind: "file", rel: t.cover_path };
  if (t.embedded_art === 1) return { kind: "embedded" };
  if (t.cover_path !== null) return { kind: "file", rel: t.cover_path };
  return null;
}

export interface Cover {
  data: Buffer;
  mime: string;
}

/** Thumbnails by track and source, least recently used dropped first. */
export class CoverCache {
  readonly #root: string;
  readonly #cache = new Map<string, Cover>();

  constructor(musicDir: string) {
    this.#root = path.resolve(musicDir);
  }

  async get(t: Track): Promise<Cover | null> {
    const src = coverSource(t);
    if (src === null) return null;
    const file = src.kind === "file" ? path.join(this.#root, src.rel) : t.abs_path;
    let mtime: number;
    try {
      mtime = (await fs.stat(file)).mtimeMs;
    } catch {
      return null; // deleted since the last scan
    }
    const key = `${t.id}:${src.kind}:${file}:${mtime}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit;
    }
    let cover: Cover | null = null;
    const thumb = await thumbnail(file);
    if (thumb !== null) cover = { data: thumb, mime: "image/jpeg" };
    else if (src.kind === "file") {
      // No ffmpeg (or it can't read the picture): send the file as is.
      const ext = imageExt(file);
      if (ext !== null) {
        try {
          cover = { data: await fs.readFile(file), mime: IMAGE_MIME[ext] ?? "image/jpeg" };
        } catch {
          cover = null;
        }
      }
    }
    if (cover === null) return null;
    this.#cache.set(key, cover);
    while (this.#cache.size > CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return cover;
  }
}

/** A JPEG at most THUMB_PX wide from a picture file or the first
 *  picture stream of an audio file; null when ffmpeg is missing or
 *  there's no picture. */
function thumbnail(file: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        "ffmpeg",
        [
          "-v", "error",
          "-i", file,
          "-map", "0:v:0",
          "-frames:v", "1",
          "-vf", `scale='min(${THUMB_PX},iw)':-2`,
          "-f", "image2pipe",
          "-c:v", "mjpeg",
          "-q:v", "4",
          "-",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => proc.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => out.push(b));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const data = Buffer.concat(out);
      resolve(code === 0 && data.length > 0 ? data : null);
    });
  });
}
