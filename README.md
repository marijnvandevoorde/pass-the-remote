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

If both run in Docker, the base URL is the container name on a shared
network (`http://pass-the-remote:3000`), not `localhost`: inside the
Pass the Aux container, `localhost` is Pass the Aux itself.

### Check it works

```bash
curl http://localhost:3000/api/health                     # no secret needed
curl -H "Authorization: Bearer $REMOTE_SECRET" http://localhost:3000/api/status
```

`/api/status` shows how many tracks are indexed and whether a scan is
running. The first scan reads every file's tags (about 25 files a second);
later scans only read new or changed files.

### Troubleshooting: what Pass the Aux shows

| Pass the Aux says | Meaning | Fix |
|---|---|---|
| `wrong secret: it must match REMOTE_SECRET …` | The secret in Settings differs from the server's | Copy `REMOTE_SECRET` again (surrounding spaces are ignored) |
| `no secret sent …` | The store has no secret | Fill in the secret in Settings |
| `request failed: fetch failed` | The server can't be reached | Check the base URL; from a container use the container name, not `localhost`; check the server logs |
| No or few results right after setup | The first scan is still running | Wait; `/api/status` shows `scanning: true` and the progress |
| `track not found (… search again)` | The library was rescanned and the file moved | Search again |
| `file missing on disk` | The file was deleted after the last scan | It disappears from search after the next scan |

The server logs one line per rejected secret (per client, at most once a
minute), so `docker compose logs pass-the-remote` shows wrong-secret
attempts.

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

Returns up to 10 tracks matching `query`: every word must appear in the
artist, title, album or filename. Case, accents and punctuation don't
matter (`beyonce` finds "Beyoncé", `acdc` and `ac dc` find "AC/DC"). The
exact title comes first, then whole-phrase matches, then words that start
a word in the title or artist.

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
    },
    "library": { "tracks": 1234, "scanning": false }
  }
}
```

`library.scanning` is true while a scan runs (results may be incomplete).

### `GET /api/stream-music?track_id=<id>`

Streams the audio bytes with the correct `Content-Type` and
`Accept-Ranges: bytes`. Honours single `Range` requests (`206`, or `416`
when the range starts past the end) and `HEAD`.

### `GET /api/status`

Authenticated. Index and scan state, for a "test connection" button:

```json
{ "success": true, "data": {
  "version": "0.2.0", "tracks": 1234, "scanning": false, "progress": 1234,
  "lastScanAt": 1792504852, "lastScanSeconds": 1.6, "lastSeen": 1234,
  "lastError": null } }
```

`lastError` says when the music folder is missing, unreadable or empty.

### `GET /api/health`

Unauthenticated probe — returns `{ success: true, data: { ok: true, version } }`.

### Errors

Every error is JSON, `{ "success": false, "error": "<message>" }`, with a
message written to be shown to the user as is. `401` responses say whether
the secret is missing, malformed or wrong.

## How the index works

On boot, every file under `MUSIC_DIR` with a known audio extension
(mp3, flac, m4a, mp4, aac, ogg, opus, wav) is hashed
(`md5(absolute_path)`) and inserted into a SQLite table. Symlinked files
and folders are followed. Title, artist, album and duration come from the
file's tags (read with `ffprobe`); for files without tags they are parsed
from the path: `Artist/Album/01 - Title.mp3`, or `Artist - Title.mp3` in
any folder.

Two triggers keep the index fresh:

- **Live watch** — `fs.watch` on `MUSIC_DIR` (recursive). Any add/remove/
  rename schedules a re-scan ~3 seconds after the last event (debounced
  so a folder copy fires one scan, not hundreds).
- **Periodic rescan** — every `SCAN_INTERVAL_S` seconds (default 5 min)
  as a safety net for environments where `fs.watch` silently misses
  events (some Docker bind-mounts on macOS/Windows).

Only new or changed files (by size and modification time) are read again.
Every scan also prunes rows whose files have disappeared, except when a
folder couldn't be read or the music folder is empty while the index
isn't (an unmounted share), so a hiccup doesn't empty the library.
A change during a scan triggers one more scan right after it.

## License

Same as [Pass the Aux](https://github.com/marijnvandevoorde/pass-the-aux).
