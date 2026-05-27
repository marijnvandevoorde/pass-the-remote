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

## Commands

```bash
npm run typecheck   # tsc --noEmit
node src/server.ts  # run directly (Node strips .ts at runtime)
docker compose up -d
```

## API

All routes require `Authorization: Bearer <REMOTE_SECRET>` except `/api/health`.

```
GET /api/get-music?q=<query>&offset=<n>
GET /api/stream-music?track_id=<id>
GET /api/health
```

`get-music` returns
`{ success, data: { tracks: { items, total, offset, limit } } }` with the
same per-track shape the Pass the Aux client adapter expects.
`stream-music` streams the audio bytes with `Content-Type` and
`Accept-Ranges: bytes`.

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
