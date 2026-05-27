import fs from "node:fs";
import type { Scanner } from "./scanner.ts";

const DEBOUNCE_MS = 3000;

/** Real-time filesystem watcher. Fires a single debounced re-scan after
 *  the music dir (or any subdirectory) sees activity. The periodic
 *  scan in server.ts remains a safety net for cases where fs.watch
 *  silently misses events (some Docker bind-mounts on macOS/Windows). */
export class Watcher {
  readonly #musicDir: string;
  readonly #scanner: Scanner;
  #handle: fs.FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(musicDir: string, scanner: Scanner) {
    this.#musicDir = musicDir;
    this.#scanner = scanner;
  }

  start(): void {
    try {
      this.#handle = fs.watch(
        this.#musicDir,
        { recursive: true, persistent: false },
        () => this.#schedule(),
      );
      this.#handle.on("error", (e) => {
        console.warn(`[watch] error: ${e.message}`);
      });
      console.log(
        `  watch: ${this.#musicDir} (debounced ${DEBOUNCE_MS}ms)`,
      );
    } catch (e) {
      console.warn(
        `[watch] disabled — ${(e as Error).message} (periodic scan still active)`,
      );
    }
  }

  stop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#handle?.close();
    this.#handle = null;
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#scanner.scan().catch((e: unknown) => {
        console.error("[scan] watch-triggered:", (e as Error).message);
      });
    }, DEBOUNCE_MS);
  }
}
