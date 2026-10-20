/** Search form of a string: lowercase, accents stripped, apostrophes
 *  dropped, any other punctuation turned into a space.
 *  "Beyoncé" → "beyonce", "AC/DC" → "ac dc", "Guns N' Roses" → "guns n roses".
 *  Done in JS because SQLite's LOWER() only folds ASCII ("ÉDITH" stays). */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Everything a track is found by: artist, title, album and filename in
 *  search form, plus artist and title without spaces so "acdc" finds
 *  "AC/DC". */
export function searchText(parts: {
  title: string | null;
  artist: string | null;
  album: string | null;
  fileBase: string;
}): string {
  const artist = normalize(parts.artist ?? "");
  const title = normalize(parts.title ?? "");
  const fields = [
    artist,
    title,
    normalize(parts.album ?? ""),
    normalize(parts.fileBase),
    artist.replace(/ /g, ""),
    title.replace(/ /g, ""),
  ];
  return ` ${fields.filter((f) => f !== "").join(" ")} `;
}
