// End-to-end tests over HTTP against a temp music folder. The "audio"
// files are dummy bytes: ffprobe (if installed) can't read them, so
// metadata comes from the filenames, which keeps the tests deterministic.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { Db, trackIdFor } from "../src/db.ts";
import { normalize } from "../src/normalize.ts";
import { parseRange } from "../src/routes.ts";
import type { Config } from "../src/config.ts";

const SECRET = "s3cret-for-tests";
let tmp: string;
let base: string;
let app: ReturnType<typeof createApp>;

function put(rel: string, bytes = 1000): void {
  const full = path.join(tmp, "music", rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, rel.length));
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptr-test-"));
  put("Beyoncé - Halo.mp3");
  put("AC-DC/Back in Black/01 - Hells Bells.flac");
  put("ÉDITH PIAF - LA VIE EN ROSE.mp3");
  put("Guns N' Roses - Sweet Child O' Mine.mp3");
  put("Halo Collective - Something Else.mp3");
  put("Various - Halo (Remix).mp3", 5000);
  // A symlinked folder (e.g. a second disk linked into the library).
  fs.mkdirSync(path.join(tmp, "elsewhere"));
  fs.writeFileSync(path.join(tmp, "elsewhere", "Linked Artist - Linked Song.mp3"), "x");
  fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(tmp, "music", "linked"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    musicDir: path.join(tmp, "music"),
    dbPath: path.join(tmp, "data", "library.db"),
    secret: SECRET,
    scanIntervalS: 0,
  };
  app = createApp(config);
  await app.scanner.scan();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(() => {
  app.server.close();
  app.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${SECRET}` };

async function searchTitles(q: string): Promise<string[]> {
  const res = await fetch(`${base}/api/get-music?q=${encodeURIComponent(q)}`, { headers: auth });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { tracks: { items: Array<{ title: string }> } };
  };
  return body.data.tracks.items.map((t) => t.title);
}

test("normalize folds accents, case and punctuation", () => {
  assert.equal(normalize("Beyoncé"), "beyonce");
  assert.equal(normalize("ÉDITH PIAF"), "edith piaf");
  assert.equal(normalize("AC/DC"), "ac dc");
  assert.equal(normalize("Guns N' Roses"), "guns n roses");
});

test("health needs no secret and reports the version", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { ok: boolean; version: string } };
  assert.equal(body.data.ok, true);
  assert.match(body.data.version, /^\d+\.\d+\.\d+/);
});

test("auth errors say what is wrong", async () => {
  const none = await fetch(`${base}/api/get-music?q=halo`);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="pass-the-remote"');
  assert.match(((await none.json()) as { error: string }).error, /no secret sent/);

  const wrong = await fetch(`${base}/api/get-music?q=halo`, {
    headers: { Authorization: "Bearer nope" },
  });
  assert.equal(wrong.status, 401);
  assert.match(((await wrong.json()) as { error: string }).error, /wrong secret/);

  const basic = await fetch(`${base}/api/get-music?q=halo`, {
    headers: { Authorization: `Basic ${SECRET}` },
  });
  assert.match(((await basic.json()) as { error: string }).error, /must be `Bearer/);
});

test("a secret with stray whitespace still works", async () => {
  const res = await fetch(`${base}/api/status`, {
    headers: { Authorization: `Bearer  ${SECRET} ` },
  });
  assert.equal(res.status, 200);
});

test("status reports tracks and scan state", async () => {
  const res = await fetch(`${base}/api/status`, { headers: auth });
  const body = (await res.json()) as {
    data: { tracks: number; scanning: boolean; lastScanAt: number; lastError: string | null };
  };
  assert.equal(body.data.tracks, 7);
  assert.equal(body.data.scanning, false);
  assert.ok(body.data.lastScanAt > 0);
  assert.equal(body.data.lastError, null);
});

test("search is accent-, case- and punctuation-insensitive", async () => {
  assert.deepEqual(await searchTitles("beyonce"), ["Halo"]);
  assert.deepEqual(await searchTitles("edith piaf"), ["LA VIE EN ROSE"]);
  assert.deepEqual(await searchTitles("guns n roses"), ["Sweet Child O' Mine"]);
  assert.deepEqual(await searchTitles("acdc"), ["Hells Bells"]);
  assert.deepEqual(await searchTitles("ac dc"), ["Hells Bells"]);
});

test("search ranks the exact title first", async () => {
  const titles = await searchTitles("halo");
  assert.equal(titles[0], "Halo");
  assert.equal(titles.length, 3);
});

test("symlinked folders are indexed", async () => {
  assert.deepEqual(await searchTitles("linked song"), ["Linked Song"]);
});

test("search responses carry the library state", async () => {
  const res = await fetch(`${base}/api/get-music?q=halo`, { headers: auth });
  const body = (await res.json()) as { data: { library: { tracks: number; scanning: boolean } } };
  assert.deepEqual(body.data.library, { tracks: 7, scanning: false });
});

async function idOf(q: string): Promise<string> {
  const res = await fetch(`${base}/api/get-music?q=${encodeURIComponent(q)}`, { headers: auth });
  const body = (await res.json()) as { data: { tracks: { items: Array<{ id: string }> } } };
  return body.data.tracks.items[0]!.id;
}

test("streaming: full, range, suffix, unsatisfiable, HEAD", async () => {
  const id = await idOf("various halo");
  const url = `${base}/api/stream-music?track_id=${id}`;

  const full = await fetch(url, { headers: auth });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/mpeg");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal((await full.arrayBuffer()).byteLength, 5000);

  const part = await fetch(url, { headers: { ...auth, Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 100-199/5000");
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  const tail = await fetch(url, { headers: { ...auth, Range: "bytes=-10" } });
  assert.equal(tail.headers.get("content-range"), "bytes 4990-4999/5000");
  await tail.arrayBuffer();

  const beyond = await fetch(url, { headers: { ...auth, Range: "bytes=6000-" } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), "bytes */5000");
  await beyond.arrayBuffer();

  const head = await fetch(url, { method: "HEAD", headers: auth });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "5000");
});

test("unknown track id explains itself", async () => {
  const res = await fetch(`${base}/api/stream-music?track_id=nope`, { headers: auth });
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /search again/);
});

test("parseRange edge cases", () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange("bytes=0-1,4-5", 10), null); // multi-range: whole file
  assert.equal(parseRange("bytes=5-2", 10), null); // invalid: ignored
  assert.deepEqual(parseRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=0-99", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
});

test("rescan skips unchanged files and picks up new ones", async () => {
  const first = await app.scanner.scan();
  assert.equal(first.probed, 0);
  assert.equal(first.seen, 7);
  put("New Artist - Brand New.mp3");
  const second = await app.scanner.scan();
  assert.equal(second.probed, 1);
  assert.deepEqual(await searchTitles("brand new"), ["Brand New"]);
});

test("a scan requested during a scan runs once more afterwards", async () => {
  const a = app.scanner.scan();
  put("Late Artist - Late Song.mp3");
  const b = app.scanner.scan();
  await Promise.all([a, b]);
  assert.deepEqual(await searchTitles("late song"), ["Late Song"]);
});

test("an empty music folder does not wipe the index", async () => {
  const music = path.join(tmp, "music");
  const moved = path.join(tmp, "music-away");
  fs.renameSync(music, moved);
  fs.mkdirSync(music); // empty mount point
  const r = await app.scanner.scan();
  assert.equal(r.removed, 0);
  assert.ok(app.db.count() > 0);
  fs.rmSync(music, { recursive: true });
  fs.renameSync(moved, music);
});

test("upgrading an old database fills search_text", () => {
  const dbPath = path.join(tmp, "old.db");
  const old = new Db(dbPath);
  old.handle.exec("DROP TABLE tracks");
  old.handle.exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, abs_path TEXT NOT NULL UNIQUE,
    rel_path TEXT NOT NULL, title TEXT, artist TEXT, album TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER, ext TEXT NOT NULL,
    indexed_at INTEGER NOT NULL)`);
  old.handle.exec(`INSERT INTO tracks VALUES ('1', '/x/a.mp3', 'a.mp3', 'Café', 'Zoë', NULL, 0, 1, 'mp3', 1)`);
  old.close();
  const upgraded = new Db(dbPath);
  const row = upgraded.getById("1");
  assert.ok(row?.search_text?.includes("cafe"));
  assert.equal(row?.mtime_ms, null);
  // The id moved to the relative-path scheme; the old one still resolves.
  assert.equal(row?.id, trackIdFor("a.mp3"));
  assert.equal(row?.legacy_id, "1");
  upgraded.close();
});

test("parseFilename: filename artist beats a single folder, id folders ignored", async () => {
  const { parseFilename } = await import("../src/scanner.ts");
  const uid = "2fc00d32199148debff8d494cb36333b";
  assert.deepEqual(parseFilename(`${uid}/Justin Timberlake - Cry Me a River.mp3`), {
    title: "Cry Me a River", artist: "Justin Timberlake", album: null,
  });
  assert.deepEqual(parseFilename("Party mix/Queen - Innuendo.mp3"), {
    title: "Innuendo", artist: "Queen", album: null,
  });
  assert.deepEqual(parseFilename("Daft Punk/Discovery/01 - One More Time.mp3"), {
    title: "One More Time", artist: "Daft Punk", album: "Discovery",
  });
  assert.deepEqual(parseFilename("Daft Punk/Discovery/Daft Punk - Aerodynamic.mp3"), {
    title: "Aerodynamic", artist: "Daft Punk", album: "Discovery",
  });
  assert.deepEqual(parseFilename("Daft Punk/Discovery/Digital Love - Live.mp3"), {
    title: "Digital Love - Live", artist: "Daft Punk", album: "Discovery",
  });
  assert.deepEqual(parseFilename("03 - Moby - Porcelain.mp3"), {
    title: "Porcelain", artist: "Moby", album: null,
  });
  assert.deepEqual(parseFilename("Radiohead/Creep.mp3"), {
    title: "Creep", artist: "Radiohead", album: null,
  });
});

test("track ids survive moving the music folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptr-move-"));
  const before = path.join(root, "native-music");
  const after = path.join(root, "docker-music");
  fs.mkdirSync(path.join(before, "Artist"), { recursive: true });
  fs.writeFileSync(path.join(before, "Artist", "Artist - Song.mp3"), Buffer.alloc(300, 1));
  const cfg = (musicDir: string): Config => ({
    host: "127.0.0.1", port: 0, musicDir, dbPath: path.join(root, "library.db"),
    secret: SECRET, scanIntervalS: 0,
  });
  const a = createApp(cfg(before));
  await a.scanner.scan();
  const id = trackIdFor(path.join("Artist", "Artist - Song.mp3"));
  assert.equal(a.db.getById(id)?.abs_path, path.join(before, "Artist", "Artist - Song.mp3"));
  a.db.close();

  fs.renameSync(before, after);
  const b = createApp(cfg(after));
  const r = await b.scanner.scan();
  assert.equal(r.probed, 0); // unchanged files aren't re-read after a move
  assert.equal(r.removed, 0);
  assert.equal(b.db.count(), 1);
  assert.equal(b.db.getById(id)?.abs_path, path.join(after, "Artist", "Artist - Song.mp3"));
  b.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
