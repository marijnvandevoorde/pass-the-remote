import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

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

/** Tiny wrapper around node:sqlite — keep statements close to the model. */
export class Db {
  readonly handle: DatabaseSync;
  readonly #upsert;
  readonly #getById;
  readonly #prune;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.handle = new DatabaseSync(dbPath);
    this.handle.exec(SCHEMA);
    this.#upsert = this.handle.prepare(`
      INSERT INTO tracks (id, abs_path, rel_path, title, artist, album, duration_sec, size_bytes, ext, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rel_path     = excluded.rel_path,
        title        = excluded.title,
        artist       = excluded.artist,
        album        = excluded.album,
        duration_sec = excluded.duration_sec,
        size_bytes   = excluded.size_bytes,
        ext          = excluded.ext,
        indexed_at   = excluded.indexed_at
    `);
    this.#getById = this.handle.prepare("SELECT * FROM tracks WHERE id = ?");
    this.#prune = this.handle.prepare("DELETE FROM tracks WHERE indexed_at < ?");
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
    );
  }

  getById(id: string): Track | null {
    const row = this.#getById.get(id);
    return (row as Track | undefined) ?? null;
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
