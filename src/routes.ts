import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { search } from "./search.ts";
import { extToMime } from "./mime.ts";
import type { Db, Track } from "./db.ts";
import type { Config } from "./config.ts";

export function makeRouter(deps: {
  db: Db;
  config: Config;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { db, config } = deps;
  return (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x"}`);
      // Health is unauthenticated so docker/lb probes don't need the secret.
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { success: true, data: { ok: true } });
        return;
      }
      if (!authOk(req, config.secret)) {
        sendJson(res, 401, { success: false, error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/get-music") {
        handleSearch(res, url, db);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stream-music") {
        handleStream(req, res, url, db);
        return;
      }
      sendJson(res, 404, { success: false, error: "not found" });
    } catch (e) {
      console.error(`[route] ${(e as Error).stack ?? String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { success: false, error: "server error" });
      else res.end();
    }
  };
}

/** Constant-time Bearer-token compare. */
function authOk(req: IncomingMessage, expected: string): boolean {
  const hdr = req.headers.authorization;
  if (typeof hdr !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(hdr);
  if (match === null) return false;
  const got = match[1] ?? "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function handleSearch(res: ServerResponse, url: URL, db: Db): void {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "") {
    sendJson(res, 400, { success: false, error: "missing q" });
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
    },
  });
}

function toApiTrack(t: Track): Record<string, unknown> {
  return {
    id: t.id,
    title:
      t.title ?? path.basename(t.rel_path, path.extname(t.rel_path)),
    version: null,
    duration: t.duration_sec,
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
    sendJson(res, 404, { success: false, error: "not found" });
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
  const range = parseRange(req.headers.range, stat.size);
  if (range !== null) {
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": range.end - range.start + 1,
    });
    fs.createReadStream(row.abs_path, { start: range.start, end: range.end })
      .on("error", (e) => {
        console.warn(`[stream] ${row.abs_path}: ${e.message}`);
        res.end();
      })
      .pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(row.abs_path)
    .on("error", (e) => {
      console.warn(`[stream] ${row.abs_path}: ${e.message}`);
      res.end();
    })
    .pipe(res);
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (m === null) return null;
  const startStr = m[1] ?? "";
  const endStr = m[2] ?? "";
  if (startStr === "" && endStr === "") return null;
  let start: number;
  let end: number;
  if (startStr === "") {
    // suffix-length: last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }
  if (start < 0) start = 0;
  if (end >= size) end = size - 1;
  if (start > end) return null;
  return { start, end };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}
