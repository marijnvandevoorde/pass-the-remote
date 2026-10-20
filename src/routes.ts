import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { search } from "./search.ts";
import { extToMime } from "./mime.ts";
import type { Db, Track } from "./db.ts";
import type { Config } from "./config.ts";
import type { ScanState } from "./scanner.ts";

export interface RouterDeps {
  db: Db;
  config: Config;
  scan: ScanState;
  version: string;
}

/** Error texts a Pass the Aux user sees verbatim in the app. */
const AUTH_ERRORS = {
  missing:
    "no secret sent: add the Authorization header `Bearer <REMOTE_SECRET>`",
  malformed: "the Authorization header must be `Bearer <REMOTE_SECRET>`",
  wrong:
    "wrong secret: it must match REMOTE_SECRET on the Pass the Remote server",
} as const;
type AuthResult = "ok" | keyof typeof AUTH_ERRORS;

export function makeRouter(
  deps: RouterDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { db, config, scan, version } = deps;
  const secretDigest = digest(config.secret);
  const lastAuthLog = new Map<string, number>();
  return (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x"}`);
      const method = req.method === "HEAD" ? "GET" : req.method;
      // Health is unauthenticated so docker/lb probes don't need the secret.
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { success: true, data: { ok: true, version } });
        return;
      }
      const auth = checkAuth(req, secretDigest);
      if (auth !== "ok") {
        // One line per reason and client per minute: enough to answer
        // "why can't my Pass the Aux connect" without flooding the log.
        const key = `${auth}:${req.socket.remoteAddress ?? "?"}`;
        const now = Date.now();
        if ((lastAuthLog.get(key) ?? 0) < now - 60_000) {
          lastAuthLog.set(key, now);
          console.warn(`[auth] 401 ${auth} secret from ${req.socket.remoteAddress ?? "?"} (${req.method} ${url.pathname})`);
        }
        res.setHeader("WWW-Authenticate", 'Bearer realm="pass-the-remote"');
        sendJson(res, 401, { success: false, error: AUTH_ERRORS[auth] });
        return;
      }
      if (method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, {
          success: true,
          data: { version, tracks: db.count(), ...scan },
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/get-music") {
        handleSearch(res, url, db, scan);
        return;
      }
      if (method === "GET" && url.pathname === "/api/stream-music") {
        handleStream(req, res, url, db);
        return;
      }
      sendJson(res, 404, {
        success: false,
        error: `unknown endpoint ${req.method} ${url.pathname}`,
      });
    } catch (e) {
      console.error(`[route] ${(e as Error).stack ?? String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { success: false, error: "server error" });
      else res.end();
    }
  };
}

function digest(s: string): Buffer {
  return crypto.createHash("sha256").update(s).digest();
}

/** Constant-time Bearer-token check. Surrounding whitespace in the token
 *  is ignored (a secret pasted with a trailing newline still works). */
function checkAuth(req: IncomingMessage, expected: Buffer): AuthResult {
  const hdr = req.headers.authorization;
  if (typeof hdr !== "string" || hdr.trim() === "") return "missing";
  const match = /^\s*Bearer\s+(.+)$/i.exec(hdr);
  if (match === null) return "malformed";
  const got = digest((match[1] ?? "").trim());
  return crypto.timingSafeEqual(got, expected) ? "ok" : "wrong";
}

function handleSearch(res: ServerResponse, url: URL, db: Db, scan: ScanState): void {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "") {
    sendJson(res, 400, { success: false, error: "missing search query (q)" });
    return;
  }
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw > 0
      ? Math.min(1000, Math.floor(offsetRaw))
      : 0;
  const { items, total } = search(db, q, offset, 10);
  sendJson(res, 200, {
    success: true,
    data: {
      tracks: {
        items: items.map(toApiTrack),
        total,
        offset,
        limit: 10,
      },
      // While a scan runs, results can be incomplete; clients may say so.
      library: { tracks: db.count(), scanning: scan.scanning },
    },
  });
}

function toApiTrack(t: Track): Record<string, unknown> {
  return {
    id: t.id,
    title:
      t.title ?? path.basename(t.rel_path, path.extname(t.rel_path)),
    version: null,
    duration: Math.round(t.duration_sec),
    performer: { name: t.artist ?? "Unknown Artist" },
    album: {
      title: t.album ?? "",
      image: { thumbnail: null, small: null, large: null },
    },
    streamable: true,
    hires: false,
    parental_warning: false,
  };
}

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: Db,
): void {
  const id = (url.searchParams.get("track_id") ?? "").trim();
  if (id === "") {
    sendJson(res, 400, { success: false, error: "missing track_id" });
    return;
  }
  const row = db.getById(id);
  if (row === null) {
    sendJson(res, 404, {
      success: false,
      error: "track not found (the library was rescanned; search again)",
    });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(row.abs_path);
  } catch {
    sendJson(res, 410, { success: false, error: "file missing on disk" });
    return;
  }
  const mime = extToMime(row.ext);
  const common = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Last-Modified": stat.mtime.toUTCString(),
  };
  const range = parseRange(req.headers.range, stat.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...common, "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: stat.size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...common,
    "Content-Length": Math.max(0, end - start + 1),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  fs.createReadStream(row.abs_path, { start, end })
    .on("error", (e) => {
      console.warn(`[stream] ${row.abs_path}: ${e.message}`);
      res.destroy(e);
    })
    .pipe(res);
}

/** Parses a single-range `Range` header. Null means "send the whole file"
 *  (no header, or one we don't support, like multiple ranges);
 *  "unsatisfiable" means 416. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const startStr = m[1] ?? "";
  const endStr = m[2] ?? "";
  if (startStr === "" && endStr === "") return null;
  let start: number;
  let end: number;
  if (startStr === "") {
    // suffix-length: last N bytes
    const n = Number(endStr);
    if (n <= 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? Infinity : Number(endStr);
    if (end < start) return null; // invalid: ignore the header (RFC 9110)
  }
  if (start >= size) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(res.req?.method === "HEAD" ? undefined : text);
}
