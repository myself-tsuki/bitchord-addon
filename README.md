# Muzo Data addon for BitChord

A [BitChord](https://bitchord.kushagrasingh.in/docs) addon that searches and streams lossless FLAC / AAC from
[Muzo Data](https://data.kouzu.in). **Each listener brings their own Muzo Data API key**, so they only ever spend
their own quota. The server stores nothing: no database, no accounts, no logins.

## How listeners use it

1. Create a free key in the [Muzo Data console](https://data.kouzu.in/console) (`muzo_live_…`).
2. Open your deployed addon (e.g. `https://muzo-bitchord-addon.<you>.workers.dev/`), paste the key and press **Copy addon URL**
   (optionally **Check key and quota**). The URL has the form:

   ```
   https://<your-host>/<muzo_live_...>/manifest.json
   ```
3. In BitChord: **Settings → Sources → Add an addon**, paste that URL, and save. Under the addon's name, choose **Lossless** (FLAC) or **High** (AAC).

The key travels in the URL path because BitChord addon settings can't take user input (only `quality` gets a picker).
Keep the URL private. If it leaks, roll the key in the Muzo console.

## What it costs the listener (Muzo quota)

| Action in BitChord | Muzo call | Credits |
| --- | --- | --- |
| Search | `/api/v1/ytm/search` (cached 10 min per key+query) | 0.25 |
| Play / download | CDN probe + byte stream | 0 |
| Track not in catalog | `/api/v1/stream/add` (queues it, no key) | 0 |

The `/api/v1/stream` resolver isn't used: the addon builds the CDN URL directly, so playback is free.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Key entry page that builds the addon URL (runs in the browser) |
| `GET /health` | Liveness |
| `GET /<key>/manifest.json` | BitChord manifest (`search`, `stream`, quality picker) |
| `GET /<key>/search?q=&quality=` | BitChord search |
| `GET /<key>/stream/<videoId>?quality=` | BitChord stream: FLAC first (with real sample rate and bit depth read from the file header), AAC fallback |
| `GET /<key>/usage` | The key's quota (numbers only) |
| `GET /m/<token>` | Media proxy (see below) |

**Why there is a media proxy:** the Muzo CDN only accepts the key in an `Authorization: Bearer` header, and BitChord's
player fetches stream URLs without custom headers. `/stream` therefore returns `/m/<token>`, where the token is
AES-GCM-encrypted with `MEDIA_SECRET` (so the raw key never appears in the media URL) and expires after
`MEDIA_TTL_SECONDS` (default 30 min, as BitChord's docs recommend). The proxy adds the header, forwards `Range` for
seeking and streams the bytes through.

## Where to host it: serverless or a full server?

Serverless works, **but it has to be a platform that streams long responses**, because every song's audio passes
through the media proxy.

| Platform | Verdict | Why |
| --- | --- | --- |
| **Cloudflare Workers** | ✅ **Recommended** | Free plan: 100k requests/day. Streamed bodies don't count against CPU time, there's no wall-clock cap while the player is connected, egress is free, and it starts instantly. The Muzo CDN itself runs on Workers. |
| Render / Railway / Fly.io / Koyeb / VPS (Node) | ✅ Works | Uses `server.mjs`. Render's free plan sleeps after 15 idle minutes (the first request then takes ~1 minute, so BitChord's health check may time out) and caps bandwidth, so use a paid plan or keep it awake. |
| Deno Deploy / Bun | ✅ Works | `src/worker.mjs` exports a standard `fetch` handler. |
| Vercel / Netlify functions | ⚠️ Not recommended | Node functions cap response bodies at a few MB (FLAC files are 20–100 MB). Edge functions stream, but their duration limits cut long, slow playback reads, and bandwidth is billed. |

### Deploy to Cloudflare Workers (recommended)

```bash
npm i -g wrangler          # or use npx
wrangler login
wrangler secret put MEDIA_SECRET   # paste a long random string, e.g. from: openssl rand -hex 32
wrangler deploy
```

Your addon is at `https://muzo-bitchord-addon.<your-subdomain>.workers.dev/`. A custom domain can be added in the dashboard.

### Run with Docker (any VPS or container host)

```bash
docker build -t muzo-bitchord-addon .
docker run -d --name muzo-addon --restart unless-stopped -p 8787:8787 \
  -e MEDIA_SECRET="$(openssl rand -hex 32)" muzo-bitchord-addon
```

Or with Compose: `cp .env.example .env`, set `MEDIA_SECRET`, then `docker compose up -d`.

- The image is `node:20-alpine` with no npm packages. It runs as the non-root `node` user, has a `/health` `HEALTHCHECK` and listens on `PORT` (default 8787).
- BitChord needs **HTTPS**, so put the container behind a TLS reverse proxy (Caddy, Nginx, Traefik or a Cloudflare Tunnel) and give listeners that `https://` address. The proxy must pass `Host` (or `X-Forwarded-Host`/`X-Forwarded-Proto`): the addon builds its media links from it.
- Keep `MEDIA_SECRET` the same across restarts, or media links issued before the restart stop working (players simply fetch a new one).
- Container platforms such as Google Cloud Run, Fly.io, Koyeb, Railway and Render (Docker runtime) can deploy this Dockerfile directly. On Cloud Run, raise the request timeout (default 5 min, max 60 min) so long audio streams aren't cut.

### Deploy to Render

Push this repo, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets the start command,
the `/health` check and a generated `MEDIA_SECRET`. Any other Node host: `MEDIA_SECRET=... PORT=8080 npm start`.

## Develop

```bash
MEDIA_SECRET=dev npm start     # http://localhost:8787
npm test                       # node:test, upstream mocked, no key needed
npm run check                  # syntax check + tests
```

No dependencies; Node 20+.

## Notes

- **BitChord addon auth (`bitchordAuth`) isn't enabled.** Access is already limited by each listener's own Muzo key,
  so BitChord shows a small "Outdated addon" note under the source. Playback isn't affected. If you later want to
  restrict the addon to the official Android app, follow the "Addon auth" section of the BitChord docs.
- Track ids are YouTube video ids. Searches use `filter=songs`, so they return album (ATV) audio.
