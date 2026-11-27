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
//   /<key>/stream/<videoId>         BitChord stream  (probes the Muzo CDN, 0 credits)
//   /<key>/usage                    the key's Muzo quota (free)
//   /m/<token>                      short-lived, encrypted media proxy to the Muzo CDN
//
// Why a media proxy: the Muzo CDN only accepts the key in an Authorization
// header, and BitChord's player fetches the stream URL without custom headers.

import { landingPage } from "./landing.mjs";

export const MUZO_API = "https://data.kouzu.in";
export const CDN_INSTANCES = [
  "https://broken-sunset-356a.veltrix620.workers.dev",
  "https://calm-bread-1e03.muzom4andlossless.workers.dev",
  "https://odd-frog-5512.antig9469.workers.dev",
];

const ADDON_VERSION = "1.0.0";
const KEY_RE = /^muzo_[A-Za-z0-9_]{8,200}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_MEDIA_TTL = 30 * 60; // seconds; BitChord docs ask for 15-30 min
const SEARCH_LIMIT = 20;

export const FORMATS = {
  flac: { path: "/muzo/cdn/flac/lossless/", type: "audio/flac" },
  m4a: { path: "/muzo/cdn/m4a/stream/", type: "audio/mp4" },
};

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

// ------------------------------------------------------ FLAC header parse

/** Reads STREAMINFO from the first 42 bytes of a FLAC file. */
export function parseFlacStreamInfo(bytes) {
  if (!bytes || bytes.length < 42) return null;
  if (bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) return null;
  if ((bytes[4] & 0x7f) !== 0) return null; // first block must be STREAMINFO
  const o = 8 + 10; // after "fLaC", block header and min/max block+frame sizes
  const sampleRate = (bytes[o] << 12) | (bytes[o + 1] << 4) | (bytes[o + 2] >> 4);
  const channels = ((bytes[o + 2] >> 1) & 0x07) + 1;
  const bitDepth = (((bytes[o + 2] & 0x01) << 4) | (bytes[o + 3] >> 4)) + 1;
  if (!sampleRate) return null;
  return { sampleRate, channels, bitDepth };
}

// ------------------------------------------------ encrypted media tokens

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map();

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret) {
  if (!keyCache.has(secret)) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode("muzo-bitchord:" + secret));
    keyCache.set(
      secret,
      crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]),
    );
  }
  return keyCache.get(secret);
}

/** The listener's key never appears in plain text in a media URL, and the URL expires. */
export async function sealToken(secret, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(payload));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), data),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return b64urlEncode(out);
}

export async function openToken(secret, token, now = Date.now()) {
  try {
    const raw = b64urlDecode(token);
    if (raw.length < 13 + 16) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) },
      await aesKey(secret),
      raw.slice(12),
    );
    const payload = JSON.parse(dec.decode(plain));
    if (!payload || typeof payload.e !== "number" || payload.e * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
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
 * Ask a CDN node for the first 42 bytes. Costs no quota. Returns
 *   { ok: true, cdn, info } | { ok: false, status }
 */
async function probe(ctx, key, format, id) {
  let last = 502;
  for (let i = 0; i < CDN_INSTANCES.length; i++) {
    const cdn = CDN_INSTANCES[i];
    let res;
    try {
      res = await ctx.fetch(cdn + FORMATS[format].path + encodeURIComponent(id), {
        headers: { authorization: `Bearer ${key}`, range: "bytes=0-41" },
      });
    } catch {
      continue; // network error: try the next node
    }
    if (res.status === 200 || res.status === 206) {
      let info = null;
      if (format === "flac") {
        // Read just the header; cancel the rest if the node ignored Range.
        const reader = res.body?.getReader();
        const chunks = [];
        let got = 0;
        while (reader && got < 42) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
        }
        reader?.cancel().catch(() => {});
        const buf = new Uint8Array(got);
        let off = 0;
        for (const c of chunks) {
          buf.set(c, off);
          off += c.length;
        }
        info = parseFlacStreamInfo(buf);
      } else {
        res.body?.cancel().catch(() => {});
      }
      return { ok: true, cdn: i, info };
    }
    res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 429) {
      return { ok: false, status: res.status }; // same answer on every node
    }
    last = res.status;
  }
  return { ok: false, status: last };
}

async function handleStream(url, key, rawId, ctx, env) {
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return errorJson(400, "Bad track id");
  }
  if (!VIDEO_ID_RE.test(id)) return errorJson(404, "Not a Muzo track id");
  const secret = env.MEDIA_SECRET;
  if (!secret) return errorJson(500, "Server is missing MEDIA_SECRET.");

  const formats = formatsForQuality(url.searchParams.get("quality"));
  let lastStatus = 404;
  for (const format of formats) {
    const p = await probe(ctx, key, format, id);
    if (p.ok) {
      const ttl = Number(env.MEDIA_TTL_SECONDS) > 300 ? Number(env.MEDIA_TTL_SECONDS) : DEFAULT_MEDIA_TTL;
      const token = await sealToken(secret, {
        k: key,
        i: id,
        f: format,
        c: p.cdn,
        e: Math.floor(Date.now() / 1000) + ttl,
      });
      const mediaUrl = `${url.origin}/m/${token}.${format}`;
      if (format === "flac") {
        const out = {
          url: mediaUrl,
          format: "flac",
          codec: "flac",
          container: "flac",
          manifest: "none",
          encrypted: false,
          quality: "Lossless",
        };
        if (p.info) {
          out.sampleRate = p.info.sampleRate;
          out.bitDepth = p.info.bitDepth;
          out.quality = `Lossless · ${p.info.bitDepth}-bit / ${+(p.info.sampleRate / 1000).toFixed(1)} kHz`;
        }
        return json(out);
      }
      return json({
        url: mediaUrl,
        format: "aac",
        codec: "aac",
        container: "mp4",
        manifest: "none",
        encrypted: false,
        quality: "AAC",
      });
    }
    lastStatus = p.status;
    if (p.status === 401 || p.status === 403 || p.status === 429) break;
  }

  if (lastStatus === 404) {
    // Not in the catalog yet: queue it (free, no key) so it streams next time.
    const queue = ctx
      .fetch(`${MUZO_API}/api/v1/stream/add?id=${encodeURIComponent(id)}`)
      .then((r) => r.body?.cancel())
      .catch(() => {});
    ctx.waitUntil(queue);
  }
  return upstreamError(lastStatus, "This track is not in the Muzo catalog yet; it has been queued.");
}

async function handleMedia(request, token, ctx, env) {
  if (!env.MEDIA_SECRET) return errorJson(500, "Server is missing MEDIA_SECRET.");
  const payload = await openToken(env.MEDIA_SECRET, token.replace(/\.(flac|m4a)$/, ""));
  if (!payload || !FORMATS[payload.f] || !VIDEO_ID_RE.test(payload.i)) {
    return errorJson(403, "This media link has expired. Play the track again.");
  }
  const headers = { authorization: `Bearer ${payload.k}` };
  for (const h of ["range", "if-range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const start = Number.isInteger(payload.c) ? payload.c : 0;
  let res;
  for (let n = 0; n < CDN_INSTANCES.length; n++) {
    const cdn = CDN_INSTANCES[(start + n) % CDN_INSTANCES.length];
    try {
      res = await ctx.fetch(cdn + FORMATS[payload.f].path + encodeURIComponent(payload.i), {
        method: request.method === "HEAD" ? "HEAD" : "GET",
        headers,
        signal: request.signal,
      });
    } catch {
      res = undefined;
      continue;
    }
    if (res.status < 500) break;
  }
  if (!res) return errorJson(502, "Could not reach the Muzo CDN.");

  const out = new Headers({
    "cache-control": "private, max-age=600",
    "access-control-allow-origin": "*",
    "accept-ranges": "bytes",
  });
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has("content-type") || out.get("content-type").startsWith("application/octet")) {
    if (res.ok) out.set("content-type", FORMATS[payload.f].type);
  }
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
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
 * @param {{ MEDIA_SECRET?: string, MEDIA_TTL_SECONDS?: string }} env
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
  if (parts[0] === "m" && parts.length === 2) return handleMedia(request, parts[1], ctx, env);

  const key = parts[0];
  if (!KEY_RE.test(key)) {
    return errorJson(404, "Put your Muzo Data API key in the URL: /<muzo_live_...>/manifest.json");
  }
  const rest = parts.slice(1);

  if (rest.length === 0 || (rest.length === 1 && rest[0] === "manifest.json")) {
    return json(buildManifest(), 200, { "cache-control": "public, max-age=600" });
  }
  if (rest.length === 1 && rest[0] === "search") return handleSearch(url, key, ctx);
  if (rest.length === 2 && rest[0] === "stream") return handleStream(url, key, rest[1], ctx, env);
  if (rest.length === 1 && rest[0] === "usage") return handleUsage(key, ctx);
  return errorJson(404, "Not found");
}
