import http from "node:http";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Scanner } from "./scanner.ts";
import { Watcher } from "./watcher.ts";
import { makeRouter } from "./routes.ts";

function tryLoadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional — env vars may be injected directly.
  }
}

export function start(): void {
  tryLoadEnv();
  const config = loadConfig(process.env);
  const db = new Db(config.dbPath);
  const scanner = new Scanner(db, config.musicDir);
  const watcher = new Watcher(config.musicDir, scanner);

  // Boot fast: kick the initial scan off in the background.
  void scanner.scan().catch((e: unknown) => {
    console.error("[scan] initial:", (e as Error).message);
  });
  if (config.scanIntervalS > 0) {
    setInterval(() => {
      void scanner.scan().catch((e: unknown) => {
        console.error("[scan] periodic:", (e as Error).message);
      });
    }, config.scanIntervalS * 1000).unref();
  }

  const server = http.createServer(makeRouter({ db, config }));
  server.listen(config.port, config.host, () => {
    console.log(
      `Pass the Remote listening on ${config.host}:${config.port}`,
    );
    console.log(`  music: ${config.musicDir}`);
    console.log(`  db:    ${config.dbPath}`);
    console.log(
      config.scanIntervalS > 0
        ? `  rescan every ${config.scanIntervalS}s`
        : "  rescan disabled",
    );
    watcher.start();
  });

  const close = (): void => {
    watcher.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

start();
