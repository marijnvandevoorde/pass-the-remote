import { loadConfig } from "./config.ts";
import { createApp, VERSION } from "./app.ts";
import { Watcher } from "./watcher.ts";

function tryLoadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional — env vars may be injected directly.
  }
}

export function start(): void {
  tryLoadEnv();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(`Pass the Remote can't start: ${(e as Error).message}`);
    process.exit(1);
  }
  let app;
  try {
    app = createApp(config);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    const denied = code === "EACCES" || code === "EPERM" || /unable to open|readonly/i.test((e as Error).message);
    console.error(
      denied
        ? `Pass the Remote can't write its index at ${config.dbPath}: ${(e as Error).message}. ` +
          `It runs as uid ${process.getuid?.() ?? "?"}; make the folder writable for that user ` +
          `(e.g. \`sudo chown -R ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} ./data\`) or set PUID/PGID to its owner.`
        : `Pass the Remote can't open its index at ${config.dbPath}: ${(e as Error).message}`,
    );
    process.exit(1);
  }
  const { db, scanner, server } = app;
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

  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `Port ${config.port} is already in use: set PORT to a free one.`
        : `Server error: ${e.message}`,
    );
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(
      `Pass the Remote ${VERSION} listening on ${config.host}:${config.port}`,
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
