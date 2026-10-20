import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { searchText } from "./normalize.ts";

/** A single indexed track. */
export interface Track {
  id: string;
  abs_path: string;
  rel_path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration_sec: number;
  size_bytes: number | null;
  ext: string;
  indexed_at: number;
  /** File mtime when it was last read; an unchanged file isn't re-probed. */
  mtime_ms: number | null;
  /** Normalised artist/title/album/filename (see normalize.ts). */
  search_text: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tracks (
    id           TEXT PRIMARY KEY,
    abs_path     TEXT NOT NULL UNIQUE,
    rel_path     TEXT NOT NULL,
    title        TEXT,
    artist       TEXT,
    album        TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    size_bytes   INTEGER,
    ext          TEXT NOT NULL,
    indexed_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
  CREATE INDEX IF NOT EXISTS idx_tracks_title  ON tracks(title);
`;

/** Columns added after the first release; added in place on boot. A row
 *  with NULL in them is re-read on the next scan. */
const ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ["mtime_ms", "INTEGER"],
  ["search_text", "TEXT"],
];

/** Bump when what the scanner derives from a file changes (tag handling,
 *  filename heuristic, search form): every file is re-read once. */
const INDEX_VERSION = 2;

export interface FileState {
  id: string;
  mtime_ms: number | null;
  size_bytes: number | null;
  search_text: string | null;
}

/** Tiny wrapper around node:sqlite — keep statements close to the model. */
export class Db {
  readonly handle: DatabaseSync;
  readonly #upsert;
  readonly #getById;
  readonly #prune;
  readonly #touch;
  readonly #count;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.handle = new DatabaseSync(dbPath);
    this.handle.exec(SCHEMA);
    const have = new Set(
      (this.handle.prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const [name, type] of ADDED_COLUMNS) {
      if (!have.has(name)) this.handle.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
    }
    if (!have.has("search_text")) this.#backfillSearchText();
    const version = Number(
      (this.handle.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    if (version < INDEX_VERSION) {
      this.handle.exec("UPDATE tracks SET mtime_ms = NULL");
      this.handle.exec(`PRAGMA user_version = ${INDEX_VERSION}`);
    }
    this.#upsert = this.handle.prepare(`
      INSERT INTO tracks (id, abs_path, rel_path, title, artist, album, duration_sec, size_bytes, ext, indexed_at, mtime_ms, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rel_path     = excluded.rel_path,
        title        = excluded.title,
        artist       = excluded.artist,
        album        = excluded.album,
        duration_sec = excluded.duration_sec,
        size_bytes   = excluded.size_bytes,
        ext          = excluded.ext,
        indexed_at   = excluded.indexed_at,
        mtime_ms     = excluded.mtime_ms,
        search_text  = excluded.search_text
    `);
    this.#getById = this.handle.prepare("SELECT * FROM tracks WHERE id = ?");
    this.#prune = this.handle.prepare("DELETE FROM tracks WHERE indexed_at < ?");
    this.#touch = this.handle.prepare("UPDATE tracks SET indexed_at = ? WHERE id = ?");
    this.#count = this.handle.prepare("SELECT COUNT(*) AS n FROM tracks");
  }

  /** Upgrade from a version without search_text: fill it from what the
   *  rows already hold, so search keeps working while the first scan
   *  re-reads every file. */
  #backfillSearchText(): void {
    const rows = this.handle
      .prepare("SELECT id, rel_path, title, artist, album FROM tracks")
      .all() as unknown as Array<Pick<Track, "id" | "rel_path" | "title" | "artist" | "album">>;
    const update = this.handle.prepare("UPDATE tracks SET search_text = ? WHERE id = ?");
    this.handle.exec("BEGIN");
    for (const r of rows) {
      const fileBase = path.basename(r.rel_path, path.extname(r.rel_path));
      update.run(searchText({ title: r.title, artist: r.artist, album: r.album, fileBase }), r.id);
    }
    this.handle.exec("COMMIT");
  }

  upsert(t: Track): void {
    this.#upsert.run(
      t.id,
      t.abs_path,
      t.rel_path,
      t.title,
      t.artist,
      t.album,
      t.duration_sec,
      t.size_bytes,
      t.ext,
      t.indexed_at,
      t.mtime_ms,
      t.search_text,
    );
  }

  getById(id: string): Track | null {
    const row = this.#getById.get(id);
    return (row as Track | undefined) ?? null;
  }

  /** What the index knows about every file, keyed by absolute path, so a
   *  scan can skip files that haven't changed. */
  fileStates(): Map<string, FileState> {
    const rows = this.handle
      .prepare("SELECT id, abs_path, mtime_ms, size_bytes, search_text FROM tracks")
      .all() as unknown as Array<FileState & { abs_path: string }>;
    return new Map(rows.map((r) => [r.abs_path, r]));
  }

  /** Mark an unchanged file as seen by the current scan. */
  touch(id: string, indexedAt: number): void {
    this.#touch.run(indexedAt, id);
  }

  count(): number {
    return Number((this.#count.get() as { n: number } | undefined)?.n ?? 0);
  }

  /** Drop rows whose indexed_at predates a freshly-completed scan. */
  pruneStale(cutoffEpoch: number): number {
    const r = this.#prune.run(cutoffEpoch);
    return Number(r.changes ?? 0);
  }

  close(): void {
    this.handle.close();
  }
}
