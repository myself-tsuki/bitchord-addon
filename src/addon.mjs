// Muzo Data addon for BitChord.
//
// One Fetch-API handler that runs unchanged on Cloudflare Workers, Deno, Bun
// and Node 20+ (see server.mjs). Every listener brings their own Muzo Data API
// key inside the addon URL:
//
//   https://<your-host>/<muzo_live_...>/manifest.json
//
// so each listener only ever spends their own quota. Nothing is stored.
//
// Routes (all GET; HEAD is accepted where it makes sense):
//   /                               landing page that builds the addon URL
//   /health                         liveness check, no key
//   /<key>  /<key>/manifest.json    BitChord manifest
//   /<key>/search?q=&quality=       BitChord search  (Muzo /api/v1/ytm/search, 0.25 credit)
//   /<key>/stream/<videoId>         BitChord stream  (Muzo /api/v1/stream, not counted)
//   /<key>/usage                    the key's Muzo quota (free)
//
// /stream returns the direct CDN URL Muzo Data gives, unchanged. Audio never
// passes through this addon.

import { landingPage } from "./landing.mjs";

export const MUZO_API = "https://data.kouzu.in";

const ADDON_VERSION = "1.0.0";
const KEY_RE = /^muzo_[A-Za-z0-9_]{8,200}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SEARCH_LIMIT = 20;

export function buildManifest() {
  return {
    id: "in.kouzu.muzo-data.bitchord",
    name: "Muzo Data",
    version: ADDON_VERSION,
    description:
      "Lossless FLAC and AAC from Muzo Data (data.kouzu.in), using your own API key and quota.",
    resources: ["search", "stream"],
    allowDownloads: 1,
    checkValidLossless: 0,
    settings: [
      {
        key: "quality",
        type: "select",
        label: "Audio quality",
        default: "lossless",
        options: [
          { value: "lossless", label: "Lossless (FLAC, up to 24-bit)" },
          { value: "high", label: "High (AAC 256 kbps)" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------- helpers

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

function errorJson(status, message, extra) {
  return json({ error: message }, status, extra);
}

/** Seconds until the next 00:00 UTC, when Muzo quotas reset. */
export function secondsUntilUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** Map a Muzo error status to what BitChord expects. */
function upstreamError(status, fallbackMessage) {
  if (status === 401 || status === 403) {
    return errorJson(401, "Muzo Data rejected this API key. Check the key in your addon URL.");
  }
  if (status === 429) {
    const wait = secondsUntilUtcMidnight();
    return errorJson(429, "Muzo Data daily quota used up; it resets at 00:00 UTC.", {
      "retry-after": String(wait),
    });
  }
  if (status === 404) return errorJson(404, fallbackMessage || "Not found");
  return errorJson(502, `Muzo Data answered ${status}.`);
}

/** Normalise BitChord's quality value into an ordered list of formats to try. */
export function formatsForQuality(quality) {
  const q = String(quality || "lossless").toLowerCase();
  if (q === "high" || q === "low" || q === "aac" || q === "m4a") return ["m4a"];
  return ["flac", "m4a"]; // lossless, max, hires, anything unknown
}

// ------------------------------------------------- search result parsing

function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of ["items", "results", "tracks", "songs", "contents", "data"]) {
    if (Array.isArray(data[k])) return data[k];
    if (data[k] && typeof data[k] === "object") {
      const inner = pickArray(data[k]);
      if (inner.length) return inner;
    }
  }
  return [];
}

function artistText(item) {
  const a = item.artists ?? item.artist ?? item.author ?? item.authors;
  if (typeof a === "string") return a;
  if (Array.isArray(a)) {
    return a
      .map((x) => (typeof x === "string" ? x : x && x.name))
      .filter(Boolean)
      .join(", ");
  }
  if (a && typeof a === "object" && a.name) return a.name;
  return "";
}

function albumText(item) {
  const a = item.album;
  if (typeof a === "string") return a;
  if (a && typeof a === "object") return a.name || a.title || "";
  return "";
}

/** Accepts 214, "214", "3:34" or "1:02:03"; returns seconds or undefined. */
export function parseDuration(item) {
  const raw =
    item.duration ?? item.durationSeconds ?? item.lengthSeconds ?? item.duration_seconds ?? item.length;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw > 36000 ? Math.round(raw / 1000) : raw; // tolerate milliseconds
  }
  if (typeof raw === "string") {
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (/^\d+(:\d{1,2}){1,2}$/.test(raw)) {
      return raw.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
    }
  }
  return undefined;
}

function artwork(item) {
  let list = item.thumbnails ?? item.thumbnail ?? item.artwork;
  if (list && !Array.isArray(list) && Array.isArray(list.thumbnails)) list = list.thumbnails;
  let url;
  if (typeof list === "string") url = list;
  else if (Array.isArray(list) && list.length) {
    const best = [...list].sort((a, b) => (b?.width || 0) - (a?.width || 0))[0];
    url = typeof best === "string" ? best : best?.url;
  }
  if (!url || typeof url !== "string") return undefined;
  if (url.startsWith("//")) url = "https:" + url;
  if (!/^https?:\/\//.test(url)) return undefined;
  // YouTube Music artwork can be requested at a bigger size.
  return url.replace(/=w\d+-h\d+(-[a-z0-9-]+)?$/i, "=w544-h544-l90-rj");
}

/** Turn a Muzo /ytm/search answer into BitChord search rows. */
export function toTracks(data, quality) {
  const formats = formatsForQuality(quality);
  const lossless = formats[0] === "flac";
  const seen = new Set();
  const tracks = [];
  for (const item of pickArray(data)) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || item.resultType || "song").toLowerCase();
    if (!["song", "songs", "video", "videos", "track"].includes(type)) continue;
    const id = item.videoId || item.id;
    const title = item.title || item.name;
    if (typeof id !== "string" || !VIDEO_ID_RE.test(id) || !title || seen.has(id)) continue;
    seen.add(id);
    const row = {
      id,
      title: String(title),
      artist: artistText(item),
      album: albumText(item),
      format: lossless ? "flac" : "aac",
      audioQuality: lossless ? "LOSSLESS" : "HIGH",
    };
    const duration = parseDuration(item);
    if (duration) row.duration = duration;
    const art = artwork(item);
    if (art) row.artworkURL = art;
    if (!row.album) delete row.album;
    tracks.push(row);
  }
  return tracks;
}

// ------------------------------------------------ stream URL from Muzo Data

/** "lossless_24bit" -> 24, anything else -> undefined. */
export function bitDepthFromQuality(q) {
  const m = /(\d{2})\s*-?\s*bit/i.exec(String(q || ""));
  return m ? Number(m[1]) : undefined;
}

// Muzo nodes whose /muzo/cnd/ URLs play without auth (from /api/v1/stream's
// cdnInstances, Nov 2026). Used only when the resolver refuses because the
// listener's daily quota is used up, or can't be reached.
export const OPEN_CDN_NODES = [
  "https://calm-bread-1e03.muzom4andlossless.workers.dev",
  "https://odd-frog-5512.antig9469.workers.dev",
  "https://solitary-sunset-f70c.beifweuhdinwocejwmecinmc.workers.dev",
  "https://velamhere-img.hf.space",
];
const CND_PATHS = { flac: "/muzo/cnd/flac/lossless/", m4a: "/muzo/cnd/m4a/stream/" };

/**
 * Same direct URL the resolver would give, built from the open nodes. A
 * 1-byte request confirms it plays; the URL itself goes to the player.
 */
async function directFallback(ctx, format, id) {
  for (const node of OPEN_CDN_NODES) {
    const u = node + CND_PATHS[format] + encodeURIComponent(id);
    try {
      const r = await ctx.fetch(u, { headers: { range: "bytes=0-0" } });
      r.body?.cancel().catch(() => {});
      if (r.status === 200 || r.status === 206) return u;
      if (r.status === 404) return undefined; // same catalog on every node
    } catch {
      // try the next node
    }
  }
  return undefined;
}

/** First usable http(s) URL among a single field and its list twin. */
function firstUrl(...candidates) {
  for (const c of candidates) {
    for (const u of Array.isArray(c) ? c : [c]) {
      if (typeof u === "string" && /^https?:\/\//.test(u)) return u;
    }
  }
  return undefined;
}

// ------------------------------------------------------------- small cache

const searchCache = new Map(); // per isolate/process; saves the listener's quota
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 500;

function cacheGet(k) {
  const hit = searchCache.get(k);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    searchCache.delete(k);
    return undefined;
  }
  return hit.value;
}

function cacheSet(k, value) {
  if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(k, { value, exp: Date.now() + SEARCH_TTL_MS });
}

export function _clearCaches() {
  searchCache.clear();
}

// ---------------------------------------------------------------- routes

async function handleSearch(url, key, ctx) {
  const q = (url.searchParams.get("q") || "").trim();
  const quality = url.searchParams.get("quality");
  if (!q) return json({ tracks: [] });

  const cacheKey = `${key}\n${q.toLowerCase()}`;
  let data = cacheGet(cacheKey);
  if (data === undefined) {
    const api = new URL("/api/v1/ytm/search", MUZO_API);
    api.searchParams.set("q", q.slice(0, 200));
    api.searchParams.set("filter", "songs");
    api.searchParams.set("limit", String(SEARCH_LIMIT));
    let res;
    try {
      res = await ctx.fetch(api, { headers: { "X-API-Key": key, accept: "application/json" } });
    } catch {
      return errorJson(502, "Could not reach Muzo Data.");
    }
    if (!res.ok) return upstreamError(res.status, "No results");
    data = await res.json().catch(() => null);
    cacheSet(cacheKey, data);
  }
  return json({ tracks: toTracks(data, quality) });
}


/**
 * Ask Muzo Data's stream resolver (GET /api/v1/stream?id=, not counted against
 * the daily quota) and hand BitChord the CDN URL it returns, unchanged. The
 * player fetches audio straight from the Muzo CDN: this addon never proxies it.
 */
async function handleStream(url, key, rawId, ctx) {
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return errorJson(400, "Bad track id");
  }
  if (!VIDEO_ID_RE.test(id)) return errorJson(404, "Not a Muzo track id");

  let res;
  try {
    res = await ctx.fetch(`${MUZO_API}/api/v1/stream?id=${encodeURIComponent(id)}`, {
      headers: { "X-API-Key": key, accept: "application/json" },
    });
  } catch {
    res = undefined; // resolver unreachable: try the direct fallback below
  }
  const wantLossless = formatsForQuality(url.searchParams.get("quality"))[0] === "flac";
  const data = res?.ok ? await res.json().catch(() => null) : null;
  let lossless = data && firstUrl(data.losslessUrl, data.losslessUrls);
  let aac = data && firstUrl(data.m4aUrl, data.m4aUrls);
  const status = res ? res.status : 502;

  // Quota used up (429) or resolver down: audio streaming stays unlimited, so
  // hand out the same direct URL instead of failing playback.
  if (!data && (status === 429 || status >= 500)) {
    if (wantLossless) lossless = await directFallback(ctx, "flac", id);
    if (!lossless) aac = await directFallback(ctx, "m4a", id);
  }

  if (wantLossless && lossless) {
    const out = {
      url: lossless,
      format: "flac",
      codec: "flac",
      container: "flac",
      manifest: "none",
      encrypted: false,
      quality: "Lossless",
    };
    const bitDepth = bitDepthFromQuality(data?.quality);
    if (bitDepth) {
      out.bitDepth = bitDepth;
      out.quality = `Lossless · ${bitDepth}-bit`;
    }
    return json(out);
  }
  if (aac) {
    return json({
      url: aac,
      format: "aac",
      codec: "aac",
      container: "mp4",
      manifest: "none",
      encrypted: false,
      quality: "AAC",
    });
  }

  const failStatus = res?.ok || status === 404 || status === 429 ? 404 : status;
  if (failStatus === 404) {
    // Not in the catalog yet: queue it (free, no key) so it streams next time.
    const queue = ctx
      .fetch(`${MUZO_API}/api/v1/stream/add?id=${encodeURIComponent(id)}`)
      .then((r) => r.body?.cancel())
      .catch(() => {});
    ctx.waitUntil(queue);
  }
  return upstreamError(failStatus, "This track is not in the Muzo catalog yet; it has been queued.");
}


async function handleUsage(key, ctx) {
  let res;
  try {
    res = await ctx.fetch(`${MUZO_API}/api/v1/user/usage`, { headers: { "X-API-Key": key } });
  } catch {
    return errorJson(502, "Could not reach Muzo Data.");
  }
  if (!res.ok) return upstreamError(res.status);
  const d = (await res.json().catch(() => null)) || {};
  // Only quota numbers: never echo account details (name, email) back out.
  return json({
    ok: true,
    dailyLimit: d.dailyLimit ?? d.limit ?? null,
    usedToday: d.usageToday ?? d.used ?? null,
    remainingToday: d.remainingToday ?? d.remaining ?? null,
    tier: d.validityLabel ?? null,
  });
}

/**
 * @param {Request} request
 * @param {Record<string, string>} env
 * @param {{ waitUntil?: (p: Promise<unknown>) => void, fetch?: typeof fetch }} [ctxIn]
 */
export async function handle(request, env = {}, ctxIn = {}) {
  const ctx = {
    fetch: ctxIn.fetch || ((...a) => fetch(...a)),
    waitUntil: ctxIn.waitUntil ? ctxIn.waitUntil.bind(ctxIn) : () => {},
  };
  const url = new URL(request.url);
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "Range, Content-Type",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") return errorJson(405, "Method not allowed");

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return new Response(landingPage(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }
  if (parts.length === 1 && parts[0] === "health") return json({ ok: true, version: ADDON_VERSION });

  const key = parts[0];
  if (!KEY_RE.test(key)) {
    return errorJson(404, "Put your Muzo Data API key in the URL: /<muzo_live_...>/manifest.json");
  }
  const rest = parts.slice(1);

  if (rest.length === 0 || (rest.length === 1 && rest[0] === "manifest.json")) {
    return json(buildManifest(), 200, { "cache-control": "public, max-age=600" });
  }
  if (rest.length === 1 && rest[0] === "search") return handleSearch(url, key, ctx);
  if (rest.length === 2 && rest[0] === "stream") return handleStream(url, key, rest[1], ctx);
  if (rest.length === 1 && rest[0] === "usage") return handleUsage(key, ctx);
  return errorJson(404, "Not found");
}
