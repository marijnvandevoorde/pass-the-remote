import type { Db, Track } from "./db.ts";

const PAGE_SIZE = 10;
const MAX_TOKENS = 8;

/** Tokenised AND search over title / artist / album. Case-insensitive,
 *  LIKE-based — good enough for thousands of tracks; swap for FTS5 if
 *  the library grows past that. */
export function search(
  db: Db,
  query: string,
  offset: number,
  limit: number = PAGE_SIZE,
): { items: Track[]; total: number } {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);

  if (tokens.length === 0) return { items: [], total: 0 };

  const conds = tokens
    .map(
      () =>
        `(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(artist) LIKE ? ESCAPE '\\' OR LOWER(album) LIKE ? ESCAPE '\\')`,
    )
    .join(" AND ");
  const params: string[] = [];
  for (const t of tokens) {
    const like = `%${escapeLike(t)}%`;
    params.push(like, like, like);
  }

  const totalRow = db.handle
    .prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${conds}`)
    .get(...params) as unknown as { n: number };

  const rows = db.handle
    .prepare(
      `SELECT * FROM tracks WHERE ${conds}
       ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as Track[];

  return { items: rows, total: totalRow.n };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
