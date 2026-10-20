import type { Db, Track } from "./db.ts";
import { normalize } from "./normalize.ts";

const PAGE_SIZE = 10;
const MAX_TOKENS = 8;
/** Matches ranked in memory; a query this broad needs more words anyway. */
const MAX_RANKED = 2000;

/** Tokenised AND search over artist / title / album / filename, accent-
 *  and punctuation-insensitive (see normalize.ts). Best matches first:
 *  exact title, then the whole query as a phrase, then words that start
 *  a word in the title or artist; ties alphabetical. LIKE-based — fine
 *  for tens of thousands of tracks. */
export function search(
  db: Db,
  query: string,
  offset: number,
  limit: number = PAGE_SIZE,
): { items: Track[]; total: number } {
  const phrase = normalize(query);
  const tokens = phrase
    .split(" ")
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);

  if (tokens.length === 0) return { items: [], total: 0 };

  const conds = tokens.map(() => `search_text LIKE ? ESCAPE '\\'`).join(" AND ");
  const params = tokens.map((t) => `%${escapeLike(t)}%`);

  const totalRow = db.handle
    .prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${conds}`)
    .get(...params) as unknown as { n: number };

  const rows = db.handle
    .prepare(
      `SELECT * FROM tracks WHERE ${conds}
       ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE
       LIMIT ?`,
    )
    .all(...params, MAX_RANKED) as unknown as Track[];

  const scored = rows.map((t, i) => ({ t, i, s: score(t, phrase, tokens) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return {
    items: scored.slice(offset, offset + limit).map((x) => x.t),
    total: totalRow.n,
  };
}

function score(t: Track, phrase: string, tokens: string[]): number {
  const title = normalize(t.title ?? "");
  const artist = normalize(t.artist ?? "");
  let s = 0;
  if (title === phrase) s += 8;
  if (`${artist} ${title}` === phrase || `${title} ${artist}` === phrase) s += 8;
  if (` ${title} `.includes(` ${phrase} `)) s += 4;
  if (` ${artist} `.includes(` ${phrase} `)) s += 3;
  for (const tok of tokens) {
    if (` ${title}`.includes(` ${tok}`)) s += 2;
    else if (` ${artist}`.includes(` ${tok}`)) s += 1;
  }
  return s;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
