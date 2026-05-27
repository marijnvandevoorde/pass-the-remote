import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AUDIO_EXTS } from "./mime.ts";
import { Db } from "./db.ts";

const EXTS = new Set(AUDIO_EXTS.map((e) => `.${e}`));

/** Walks `musicDir`, upserts every audio file into the index, prunes
 *  rows whose files no longer exist on disk. */
export class Scanner {
  readonly #db: Db;
  readonly #root: string;
  #running = false;

  constructor(db: Db, musicDir: string) {
    this.#db = db;
    this.#root = path.resolve(musicDir);
  }

  /** Single full sweep. Safe to invoke concurrently — calls overlap as
   *  no-ops; the next one starts after the in-flight one settles. */
  async scan(): Promise<{ seen: number; removed: number }> {
    if (this.#running) return { seen: 0, removed: 0 };
    this.#running = true;
    const startedAt = Math.floor(Date.now() / 1000);
    let seen = 0;
    try {
      try {
        await fs.access(this.#root);
      } catch {
        console.warn(`[scan] music dir does not exist: ${this.#root}`);
        return { seen: 0, removed: 0 };
      }
      for await (const file of walk(this.#root)) {
        if (!EXTS.has(path.extname(file).toLowerCase())) continue;
        try {
          const stat = await fs.stat(file);
          if (!stat.isFile()) continue;
          const id = crypto.createHash("md5").update(file).digest("hex");
          const rel = path.relative(this.#root, file);
          const parsed = parseFilename(rel);
          this.#db.upsert({
            id,
            abs_path: file,
            rel_path: rel,
            title: parsed.title,
            artist: parsed.artist,
            album: parsed.album,
            duration_sec: 0,
            size_bytes: stat.size,
            ext: path.extname(file).slice(1).toLowerCase(),
            indexed_at: startedAt,
          });
          seen++;
        } catch (e) {
          console.warn(`[scan] skip ${file}: ${(e as Error).message}`);
        }
      }
      const removed = this.#db.pruneStale(startedAt);
      console.log(`[scan] indexed ${seen} files, pruned ${removed} stale`);
      return { seen, removed };
    } finally {
      this.#running = false;
    }
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // hidden / sidecar files
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** Heuristic metadata from path + filename. Folder layout wins (we
 *  trust `Artist/Album/01 - Title.mp3` more than free-form filenames). */
export function parseFilename(rel: string): {
  title: string | null;
  artist: string | null;
  album: string | null;
} {
  const base = path.basename(rel, path.extname(rel));
  const dirParts = path
    .dirname(rel)
    .split(path.sep)
    .filter((s) => s.length > 0 && s !== ".");
  const parts = base
    .split(" - ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let artist: string | null = null;
  let album: string | null = null;
  let title: string | null = null;

  if (dirParts.length >= 2) {
    artist = dirParts[0] ?? null;
    album = dirParts[1] ?? null;
  } else if (dirParts.length === 1) {
    artist = dirParts[0] ?? null;
  }

  if (parts.length <= 1) {
    title = stripTrackNum(parts[0] ?? base);
  } else if (parts.length === 2) {
    if (artist === null) artist = parts[0] ?? null;
    title = stripTrackNum(parts[1] ?? "");
  } else {
    if (artist === null) artist = parts[0] ?? null;
    if (album === null) album = parts[1] ?? null;
    title = stripTrackNum(parts.slice(2).join(" - "));
  }
  return { title: title || null, artist, album };
}

function stripTrackNum(s: string): string {
  return s.replace(/^\d+[\s._-]+/, "").trim();
}
