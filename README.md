<p align="center">
  <img src="passtheremote.png" alt="Pass the Remote" width="180" />
</p>

# Pass the Remote

A tiny self-hosted music server — a **companion app to
[Pass the Aux](https://github.com/marijnvandevoorde/pass-the-aux)**.
Point it at a folder of audio files and it exposes a Pass the Aux–compatible
search + stream API, gated by a shared secret.

Each running Pass the Remote instance is a **remote record store** that a
Pass the Aux user adds in **Settings → Remote record stores**.

## Run it

### Docker compose (recommended)

```bash
cp .env.example .env
# edit .env — set REMOTE_SECRET; optionally point MUSIC_HOST_DIR at your library
docker compose up -d
```

The server is now on `http://localhost:3000` (or whatever `PORT` you set).
The SQLite index lives in `./data/`; the music folder is mounted read-only.

### Locally (no Docker)

```bash
cp .env.example .env
# edit .env — set REMOTE_SECRET and MUSIC_DIR
npm start
```

Requires Node 24 or newer (we use `node:sqlite` and runtime type-stripping).

### Hooking it up to Pass the Aux

In your [Pass the Aux](https://github.com/marijnvandevoorde/pass-the-aux)
instance, add a remote record store with:

- **Base URL:** `http://<host>:<PORT>` (where this server is reachable)
- **Secret:** the same value as `REMOTE_SECRET`

Either through **Settings → Remote record stores** in the UI, or by
seeding it in the Pass the Aux `.env` on first boot (see that project's
`.env.example` for the `REMOTE_LIBRARY_BASE` / `REMOTE_LIBRARY_SECRET`
variables).

## Configuration

| Env var          | Default        | Purpose                                              |
|------------------|----------------|------------------------------------------------------|
| `REMOTE_SECRET`  | *(required)*   | Bearer secret. Generate: `openssl rand -hex 32`.     |
| `MUSIC_DIR`      | `./music`      | Folder scanned for audio (recursive). Native only.   |
| `MUSIC_HOST_DIR` | `./music`      | Host path mounted into the container. Docker only.   |
| `DB_PATH`        | `./library.db` | SQLite index location. Native only.                  |
| `HOST`           | `0.0.0.0`      | Bind host. Native only.                              |
| `PORT`           | `3000`         | Bind port (host port under Docker).                  |
| `SCAN_INTERVAL_S`| `300`          | Re-scan interval in seconds. `0` disables rescans.   |

## API

All routes (except `/api/health`) require:

```
Authorization: Bearer <REMOTE_SECRET>
```

### `GET /api/get-music?q=<query>&offset=<n>`

Returns up to 10 tracks matching `query` (tokenised AND across title,
artist, album).

```json
{
  "success": true,
  "data": {
    "tracks": {
      "items": [
        {
          "id": "9a2b…",
          "title": "One More Time",
          "version": null,
          "duration": 320,
          "performer": { "name": "Daft Punk" },
          "album":     { "title": "Discovery", "image": { "thumbnail": null } },
          "streamable": true
        }
      ],
      "total": 1,
      "offset": 0,
      "limit": 10
    }
  }
}
```

### `GET /api/stream-music?track_id=<id>`

Streams the audio bytes with the correct `Content-Type` and
`Accept-Ranges: bytes`. Honours HTTP `Range` requests.

### `GET /api/health`

Unauthenticated probe — returns `{ success: true, data: { ok: true } }`.

## How the index works

On boot, every file under `MUSIC_DIR` with a known audio extension is
hashed (`md5(absolute_path)`) and inserted into a SQLite table. Metadata
is parsed from the path + filename — folder structure first
(`Artist/Album/01 - Title.mp3`), then `Artist - Title.mp3`, then the
filename alone.

Two triggers keep the index fresh:

- **Live watch** — `fs.watch` on `MUSIC_DIR` (recursive). Any add/remove/
  rename schedules a re-scan ~3 seconds after the last event (debounced
  so a folder copy fires one scan, not hundreds).
- **Periodic rescan** — every `SCAN_INTERVAL_S` seconds (default 5 min)
  as a safety net for environments where `fs.watch` silently misses
  events (some Docker bind-mounts on macOS/Windows).

Every scan also prunes rows whose files have disappeared. No tag
reading (yet) — that's a v2 stretch.

## License

Same as [Pass the Aux](https://github.com/marijnvandevoorde/pass-the-aux).
