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
| Play / download | `/api/v1/stream?id=` (not counted against the daily quota) | 0 |
| Track not in catalog | `/api/v1/stream/add` (queues it, no key) | 0 |

**No audio proxy.** `/stream` returns the direct CDN URL Muzo Data's `/api/v1/stream` gives (`losslessUrl`, or
`m4aUrl` for AAC), unchanged. BitChord's player fetches the audio straight from the Muzo CDN; no audio bytes pass
through this addon, so hosting needs almost no bandwidth.

If the resolver refuses because the listener's daily quota is used up (429), or can't be reached, the addon still
hands out a direct URL: the same `/muzo/cnd/...` link on one of Muzo's open CDN nodes, confirmed with a 1-byte request.
Audio streaming on the Muzo CDN is unlimited, so playback keeps working; only searches wait for the 00:00 UTC reset.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Key entry page that builds the addon URL (runs in the browser) |
| `GET /health` | Liveness |
| `GET /<key>/manifest.json` | BitChord manifest (`search`, `stream`, quality picker) |
| `GET /<key>/search?q=&quality=` | BitChord search |
| `GET /<key>/stream/<videoId>?quality=` | BitChord stream: Muzo's direct FLAC URL first, AAC fallback |
| `GET /<key>/usage` | The key's quota (numbers only) |

## Where to host it: serverless or a full server?

Any platform works: the addon only answers small JSON requests (search, stream link, manifest), and audio never
passes through it.

| Platform | Verdict | Why |
| --- | --- | --- |
| **Cloudflare Workers** | ✅ **Recommended** | Free plan: 100k requests/day, starts instantly, no server to manage, no secrets to set. |
| Render / Railway / Fly.io / Koyeb / VPS (Node) | ✅ Works | Uses `server.mjs`. Render's free plan sleeps after 15 idle minutes (the first request then takes ~1 minute, so BitChord's health check may time out) so use a paid plan or keep it awake. |
| Deno Deploy / Bun | ✅ Works | `src/worker.mjs` exports a standard `fetch` handler. |
| Vercel / Netlify | ✅ Works | Wrap `handle` from `src/addon.mjs` in a function; responses are small JSON. |

### Deploy to Cloudflare Workers (recommended)

```bash
npm i -g wrangler          # or use npx
wrangler login
wrangler deploy
```

Your addon is at `https://muzo-bitchord-addon.<your-subdomain>.workers.dev/`. A custom domain can be added in the dashboard.

### Run with Docker (any VPS or container host)

```bash
docker build -t muzo-bitchord-addon .
docker run -d --name muzo-addon --restart unless-stopped -p 8787:8787 muzo-bitchord-addon
```

Or with Compose: `docker compose up -d`.

- The image is `node:20-alpine` with no npm packages. It runs as the non-root `node` user, has a `/health` `HEALTHCHECK` and listens on `PORT` (default 8787).
- BitChord needs **HTTPS**, so put the container behind a TLS reverse proxy (Caddy, Nginx, Traefik or a Cloudflare Tunnel) and give listeners that `https://` address.
- Container platforms such as Google Cloud Run, Fly.io, Koyeb, Railway and Render (Docker runtime) can deploy this Dockerfile directly.

### Deploy to Render

Push this repo, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets the start command
and the `/health` check. Any other Node host: `PORT=8080 npm start`.

## Develop

```bash
npm start                      # http://localhost:8787
npm test                       # node:test, upstream mocked, no key needed
npm run check                  # syntax check + tests
```

No dependencies; Node 20+.

## Notes

- **BitChord addon auth (`bitchordAuth`) isn't enabled.** Access is already limited by each listener's own Muzo key,
  so BitChord shows a small "Outdated addon" note under the source. Playback isn't affected. If you later want to
  restrict the addon to the official Android app, follow the "Addon auth" section of the BitChord docs.
- Track ids are YouTube video ids. Searches use `filter=songs`, so they return album (ATV) audio.
