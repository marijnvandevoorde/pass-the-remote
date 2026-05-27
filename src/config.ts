/** Server config — all fields come from the environment. */
export interface Config {
  host: string;
  port: number;
  /** Root folder scanned for audio files. */
  musicDir: string;
  /** SQLite database file. */
  dbPath: string;
  /** Bearer secret clients must send in `Authorization`. */
  secret: string;
  /** Re-scan interval in seconds; 0 disables the periodic re-scan. */
  scanIntervalS: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function nonNegativeInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = (env.REMOTE_SECRET ?? "").trim();
  if (secret === "") {
    throw new Error(
      "REMOTE_SECRET is required (set it in .env or the environment).",
    );
  }
  return Object.freeze({
    host: (env.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
    port: positiveInt(env.PORT, 3000),
    musicDir: (env.MUSIC_DIR ?? "./music").trim() || "./music",
    dbPath: (env.DB_PATH ?? "./library.db").trim() || "./library.db",
    secret,
    scanIntervalS: nonNegativeInt(env.SCAN_INTERVAL_S, 300),
  });
}
