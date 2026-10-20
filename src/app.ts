import http from "node:http";
import fs from "node:fs";
import type { Config } from "./config.ts";
import { Db } from "./db.ts";
import { Scanner } from "./scanner.ts";
import { makeRouter } from "./routes.ts";
import { CoverCache } from "./covers.ts";

/** Package version, served by /api/health and /api/status. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

/** Wires the index, scanner and HTTP handler; doesn't listen or scan.
 *  Used by server.ts and by the tests. */
export function createApp(config: Config): {
  db: Db;
  scanner: Scanner;
  server: http.Server;
} {
  const db = new Db(config.dbPath);
  const scanner = new Scanner(db, config.musicDir);
  const server = http.createServer(
    makeRouter({
      db,
      config,
      scan: scanner.state,
      version: VERSION,
      covers: new CoverCache(config.musicDir),
    }),
  );
  return { db, scanner, server };
}
