import fs from "node:fs/promises";
import path from "node:path";
import { AUDIO_EXTS } from "./mime.ts";
import { Db, legacyIdFor, trackIdFor } from "./db.ts";
import { readTags } from "./tags.ts";
import { searchText } from "./normalize.ts";

const EXTS = new Set(AUDIO_EXTS.map((e) => `.${e}`));

/** What a client can be told about indexing (GET /api/status). */
export interface ScanState {
  scanning: boolean;
  /** Files looked at so far in the running scan. */
  progress: number;
  /** Unix seconds when the last scan finished, null before the first. */
  lastScanAt: number | null;
  lastScanSeconds: number | null;
  /** Audio files found by the last scan. */
  lastSeen: number;
  /** Why the music folder can't be read, or null. */
  lastError: string | null;
}

export interface ScanResult {
  seen: number;
  probed: number;
  removed: number;
}

/** Walks `musicDir`, upserts every audio file into the index, prunes
 *  rows whose files no longer exist on disk. Files whose size and mtime
 *  are unchanged keep their row without another ffprobe. */
export class Scanner {
  readonly #db: Db;
  readonly #root: string;
  #running: Promise<ScanResult> | null = null;
  #again = false;
  readonly state: ScanState = {
    scanning: false,
    progress: 0,
    lastScanAt: null,
    lastScanSeconds: null,
    lastSeen: 0,
    lastError: null,
  };

  constructor(db: Db, musicDir: string) {
    this.#db = db;
    this.#root = path.resolve(musicDir);
  }

  /** Runs a sweep. A call during a running sweep doesn't start a second
   *  one in parallel and isn't dropped either: one more sweep follows the
   *  running one (a file copied in mid-scan is picked up), and the call
   *  resolves when that one is done. */
  scan(): Promise<ScanResult> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      let result: ScanResult;
      try {
        do {
          this.#again = false;
          result = await this.#sweep();
        } while (this.#again);
        return result;
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  async #sweep(): Promise<ScanResult> {
    const t0 = Date.now();
    const startedAt = Math.floor(t0 / 1000);
    this.state.scanning = true;
    this.state.progress = 0;
    let seen = 0;
    let probed = 0;
    try {
      try {
        const st = await fs.stat(this.#root);
        if (!st.isDirectory()) throw new Error("not a directory");
      } catch (e) {
        this.state.lastError = `music folder ${this.#root} can't be read: ${(e as Error).message}`;
        console.warn(`[scan] ${this.state.lastError}`);
        return { seen: 0, probed: 0, removed: 0 };
      }
      const known = this.#db.fileStates();
      const unreadable: string[] = [];
      for await (const file of walk(this.#root, unreadable)) {
        if (!EXTS.has(path.extname(file).toLowerCase())) continue;
        this.state.progress++;
        try {
          const stat = await fs.stat(file);
          if (!stat.isFile()) continue;
          const rel = path.relative(this.#root, file);
          const id = trackIdFor(rel);
          const mtime = Math.floor(stat.mtimeMs);
          const prev = known.get(id);
          if (
            prev !== undefined &&
            prev.mtime_ms === mtime &&
            prev.size_bytes === stat.size &&
            prev.search_text !== null
          ) {
            this.#db.touch(prev.id, startedAt, file);
            seen++;
            continue;
          }
          // Real tags first (ID3 / Vorbis / MP4 / etc. via ffprobe),
          // falling back to the filename/path heuristic field-by-field
          // so a tagged title still beats a folder-derived artist.
          const tags = await readTags(file);
          probed++;
          const fallback = parseFilename(rel);
          const title = tags?.title ?? fallback.title;
          const artist = tags?.artist ?? fallback.artist;
          const album = tags?.album ?? fallback.album;
          this.#db.upsert({
            id,
            legacy_id: legacyIdFor(file),
            abs_path: file,
            rel_path: rel,
            title,
            artist,
            album,
            duration_sec: tags?.durationSec ?? 0,
            size_bytes: stat.size,
            ext: path.extname(file).slice(1).toLowerCase(),
            indexed_at: startedAt,
            mtime_ms: mtime,
            search_text: searchText({
              title,
              artist,
              album,
              fileBase: path.basename(rel, path.extname(rel)),
            }),
          });
          seen++;
        } catch (e) {
          console.warn(`[scan] skip ${file}: ${(e as Error).message}`);
        }
      }
      // Don't prune what we couldn't look at: an unreadable subfolder or
      // an empty mount point (NAS share not mounted) would otherwise wipe
      // tracks that are still there.
      let removed = 0;
      if (unreadable.length > 0) {
        console.warn(
          `[scan] ${unreadable.length} folder(s) unreadable (${unreadable.slice(0, 3).join(", ")}); not pruning`,
        );
      } else if (seen === 0 && this.#db.count() > 0) {
        console.warn(`[scan] music folder is empty but the index isn't; not pruning (is the folder mounted?)`);
      } else {
        removed = this.#db.pruneStale(startedAt);
      }
      this.state.lastError =
        seen === 0 ? `no audio files found in ${this.#root}` : null;
      const secs = (Date.now() - t0) / 1000;
      this.state.lastScanAt = Math.floor(Date.now() / 1000);
      this.state.lastScanSeconds = Math.round(secs * 10) / 10;
      this.state.lastSeen = seen;
      console.log(
        `[scan] ${seen} files (${probed} read, ${seen - probed} unchanged), pruned ${removed}, ${secs.toFixed(1)}s`,
      );
      return { seen, probed, removed };
    } finally {
      this.state.scanning = false;
    }
  }
}

/** Every file under `dir`, following symlinks (each real folder once, so a
 *  link loop can't recurse forever). Folders that can't be read are added
 *  to `unreadable`. Hidden entries are skipped. */
async function* walk(
  dir: string,
  unreadable: string[],
  visited: Set<string> = new Set(),
): AsyncGenerator<string> {
  let real: string;
  let entries: import("node:fs").Dirent[];
  try {
    real = await fs.realpath(dir);
    if (visited.has(real)) return;
    visited.add(real);
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    unreadable.push(`${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // hidden
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue; // dangling link
      }
    }
    if (isDir) {
      yield* walk(full, unreadable, visited);
    } else if (isFile) {
      yield full;
    }
  }
}

/** Heuristic metadata from path + filename, for files without tags.
 *  `Artist/Album/01 - Title.mp3` → folders give artist and album.
 *  `Any Folder/Artist - Title.mp3` → the filename's artist wins over a
 *  single folder (often a playlist or user folder, not an artist).
 *  Folders named like an id (32 hex characters) are never an artist. */
export function parseFilename(rel: string): {
  title: string | null;
  artist: string | null;
  album: string | null;
} {
  const base = path.basename(rel, path.extname(rel));
  const dirs = path
    .dirname(rel)
    .split(path.sep)
    .filter((s) => s.length > 0 && s !== "." && !/^[0-9a-f]{32}$/i.test(s));
  let parts = base
    .split(" - ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // "01 - Title", "01 - Artist - Title": a leading track number isn't a field.
  if (parts.length >= 2 && /^\d+$/.test(parts[0] ?? "")) parts = parts.slice(1);

  const folderArtist = dirs.length >= 2 ? (dirs[0] ?? null) : null;
  const folderAlbum = dirs.length >= 2 ? (dirs[1] ?? null) : null;

  if (parts.length <= 1) {
    return {
      title: stripTrackNum(parts[0] ?? base) || null,
      artist: folderArtist ?? dirs[0] ?? null,
      album: folderAlbum,
    };
  }
  if (folderArtist !== null) {
    // Artist/Album layout: trust the folders; drop a repeated artist.
    const repeated = (parts[0] ?? "").toLowerCase() === folderArtist.toLowerCase();
    const title = repeated ? parts.slice(1).join(" - ") : parts.join(" - ");
    return { title: stripTrackNum(title) || null, artist: folderArtist, album: folderAlbum };
  }
  if (parts.length === 2) {
    return { title: stripTrackNum(parts[1] ?? "") || null, artist: parts[0] ?? null, album: null };
  }
  return {
    title: stripTrackNum(parts.slice(2).join(" - ")) || null,
    artist: parts[0] ?? null,
    album: parts[1] ?? null,
  };
}

function stripTrackNum(s: string): string {
  return s.replace(/^\d+[\s._-]+/, "").trim();
}
