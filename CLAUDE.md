# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Pass the Remote** — a companion app to
[Pass the Aux](https://github.com/marijnvandevoorde/pass-the-aux). A
lightweight self-hosted music server: scans a folder of audio files,
indexes them in SQLite, and exposes the Pass the Aux remote record
store wire contract (search + stream), gated by a Bearer secret.

A running Pass the Remote instance is a **remote record store** that a
Pass the Aux user adds via **Settings → Remote record stores**. Pass the
Aux is a thin HTTP client of this service — one instance per remote the
user has configured.

## Stack

- **Node 24+** with native ESM and runtime type-stripping (no build step)
- **`node:sqlite`** (built-in, stable in Node 24) for the index
- **Native `http`** for serving — no framework
- **Zero npm runtime dependencies.** Tooling-only devDeps (TypeScript).
- **`ffprobe`** (system binary, ships with ffmpeg in the Docker image) —
  read by `src/tags.ts` to extract title/artist/album/duration from
  every audio container at scan time. Absent ffprobe ⇒ the scanner
  falls back to filename heuristics gracefully (no crash).

## Commands

```bash
npm run typecheck   # tsc --noEmit (src + test)
npm test            # node:test, end to end over HTTP on a temp folder
node src/server.ts  # run directly (Node strips .ts at runtime)
docker compose up -d
```

## API

All routes require `Authorization: Bearer <REMOTE_SECRET>` except `/api/health`.

```
GET /api/get-music?q=<query>&offset=<n>
GET|HEAD /api/stream-music?track_id=<id>
GET /api/cover?track_id=<id>   # cover thumbnail (ffmpeg), URL in album.image.thumbnail
GET /api/status        # tracks, scan state, last error
GET /api/health        # unauthenticated
```

Error messages are shown verbatim in Pass the Aux, so write them for the
user ("wrong secret: it must match REMOTE_SECRET …"). Additive fields only:
Pass the Aux and other clients parse this contract.

`get-music` returns
`{ success, data: { tracks: { items, total, offset, limit } } }` with the
same per-track shape the Pass the Aux client adapter expects, plus
`data.library: { tracks, scanning }`.
`stream-music` streams the audio bytes with `Content-Type` and
`Accept-Ranges: bytes`.

## Index

`src/scanner.ts` skips files whose size and mtime are unchanged, follows
symlinks, and doesn't prune when a folder was unreadable or the music
folder is empty. Search matches `search_text` (normalised artist, title,
album, filename; `src/normalize.ts`) and ranks in `src/search.ts`. When
what the scanner derives from a file changes, bump `INDEX_VERSION` in
`src/db.ts` so every file is re-read once.

## Code conventions

Inherited from the Pass the Aux project:

- ESM, `.ts` extensions in relative imports (`./foo.ts`)
- TypeScript strict; `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `erasableSyntaxOnly`, `isolatedModules`, `verbatimModuleSyntax`
- No enums / namespaces / parameter properties — type-stripping only
  erases types
- Config is environment-driven (`src/config.ts`, `.env.example`)

## Don'ts

- Don't add npm runtime deps. `node:sqlite` covers persistence; native
  `http` covers serving.
- Don't add a build step. Node strips types at runtime.
- Don't commit `.env`, `*.db`, or anything under `music/` / `data/`.
