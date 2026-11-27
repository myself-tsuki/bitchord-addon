import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handle,
  toTracks,
  parseDuration,
  parseFlacStreamInfo,
  sealToken,
  openToken,
  formatsForQuality,
  secondsUntilUtcMidnight,
  CDN_INSTANCES,
  _clearCaches,
} from "../src/addon.mjs";

const KEY = "muzo_live_" + "ab".repeat(24);
const ENV = { MEDIA_SECRET: "test-secret-please-change" };
const BASE = "https://addon.example.com";

function flacHeader(sampleRate = 96000, bitDepth = 24, channels = 2) {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]); // fLaC + last STREAMINFO block, len 34
  const o = 18;
  b[o] = (sampleRate >> 12) & 0xff;
  b[o + 1] = (sampleRate >> 4) & 0xff;
  b[o + 2] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 7) << 1) | (((bitDepth - 1) >> 4) & 1);
  b[o + 3] = ((bitDepth - 1) & 0x0f) << 4;
  return b;
}

/** Fake upstream: records every call and answers from a router function. */
function fakeFetch(router) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    calls.push({ url, headers, method: init.method || "GET" });
    return router(url, headers, init);
  };
  fn.calls = calls;
  return fn;
}

const call = (path, fetchImpl, env = ENV, init) => {
  const waits = [];
  return handle(new Request(BASE + path, init), env, {
    fetch: fetchImpl,
    waitUntil: (p) => waits.push(p),
  }).then(async (res) => {
    await Promise.all(waits);
    return res;
  });
};

beforeEach(() => _clearCaches());

test("landing page and health need no key", async () => {
  const f = fakeFetch(() => new Response("nope", { status: 500 }));
  const home = await call("/", f);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Muzo Data addon for BitChord/);
  const health = await call("/health", f);
  assert.deepEqual(await health.json(), { ok: true, version: "1.0.0" });
  assert.equal(f.calls.length, 0);
});

test("manifest is served under the key prefix, at root and /manifest.json", async () => {
  const f = fakeFetch(() => new Response(null, { status: 500 }));
  for (const p of [`/${KEY}/manifest.json`, `/${KEY}`, `/${KEY}/`]) {
    const res = await call(p, f);
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.id, "in.kouzu.muzo-data.bitchord");
    assert.deepEqual(m.resources, ["search", "stream"]);
    assert.equal(m.settings[0].key, "quality");
    assert.equal(m.settings[0].options[0].value, "lossless"); // best first
    assert.equal(m.bitchordAuth, undefined);
  }
  assert.equal(f.calls.length, 0, "manifest must not spend quota");
});

test("a URL without a valid key is a 404 with a hint", async () => {
  const res = await call("/notakey/manifest.json", fakeFetch(() => null));
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /API key/);
});

test("search calls ytm/search with the listener's key and maps rows", async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.startsWith("https://data.kouzu.in/api/v1/ytm/search?"));
    return Response.json({
      items: [
        {
          type: "song",
          videoId: "R-hYM3BqTbA",
          title: "Self Aware",
          artists: [{ name: "Temper City", id: "UC1" }],
          album: { name: "Self Aware - Single" },
          duration: "3:34",
          thumbnails: [
            { url: "https://lh3.googleusercontent.com/x=w60-h60-l90-rj", width: 60 },
            { url: "https://lh3.googleusercontent.com/x=w120-h120-l90-rj", width: 120 },
          ],
        },
        { type: "artist", id: "UCxxxxxxxxxxxxxxxx", title: "Someone" },
        { type: "song", videoId: "bad", title: "Invalid id" },
      ],
    });
  });
  const res = await call(`/${KEY}/search?q=self%20aware&quality=lossless`, f);
  assert.equal(res.status, 200);
  const { tracks } = await res.json();
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0], {
    id: "R-hYM3BqTbA",
    title: "Self Aware",
    artist: "Temper City",
    album: "Self Aware - Single",
    format: "flac",
    audioQuality: "LOSSLESS",
    duration: 214,
    artworkURL: "https://lh3.googleusercontent.com/x=w544-h544-l90-rj",
  });
  const sent = f.calls[0];
  assert.equal(sent.headers.get("x-api-key"), KEY);
  const u = new URL(sent.url);
  assert.equal(u.searchParams.get("q"), "self aware");
  assert.equal(u.searchParams.get("filter"), "songs");

  // Same query again is served from cache: no second quota spend.
  await call(`/${KEY}/search?q=Self%20Aware&quality=high`, f);
  assert.equal(f.calls.length, 1);
});

test("search with an empty query returns no tracks and spends nothing", async () => {
  const f = fakeFetch(() => assert.fail("should not call upstream"));
  const res = await call(`/${KEY}/search?q=`, f);
  assert.deepEqual(await res.json(), { tracks: [] });
});

test("search maps Muzo 401 and 429 for BitChord", async () => {
  const r401 = await call(`/${KEY}/search?q=a`, fakeFetch(() => Response.json({ error: "x" }, { status: 401 })));
  assert.equal(r401.status, 401);
  const r429 = await call(`/${KEY}/search?q=b`, fakeFetch(() => Response.json({ error: "x" }, { status: 429 })));
  assert.equal(r429.status, 429);
  assert.ok(Number(r429.headers.get("retry-after")) > 0);
});

test("stream probes the CDN (no quota), reads FLAC info and returns a sealed media URL", async () => {
  const f = fakeFetch((url, headers) => {
    assert.ok(url.startsWith(CDN_INSTANCES[0] + "/muzo/cdn/flac/lossless/R-hYM3BqTbA"));
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(headers.get("range"), "bytes=0-41");
    return new Response(flacHeader(96000, 24), { status: 206 });
  });
  const res = await call(`/${KEY}/stream/R-hYM3BqTbA?quality=lossless`, f);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.codec, "flac");
  assert.equal(body.manifest, "none");
  assert.equal(body.encrypted, false);
  assert.equal(body.sampleRate, 96000);
  assert.equal(body.bitDepth, 24);
  assert.equal(body.quality, "Lossless · 24-bit / 96 kHz");
  assert.ok(body.url.startsWith(BASE + "/m/"));
  assert.ok(!body.url.includes(KEY), "raw key must not appear in the media URL");
  assert.ok(f.calls.every((c) => !c.url.startsWith("https://data.kouzu.in/api/v1/stream?")));
});

test("stream falls back to AAC when FLAC is missing, and high quality asks AAC only", async () => {
  const f = fakeFetch((url) =>
    url.includes("/flac/") ? new Response("{}", { status: 404 }) : new Response(new Uint8Array(42), { status: 206 }),
  );
  const res = await call(`/${KEY}/stream/R-hYM3BqTbA?quality=lossless`, f);
  const body = await res.json();
  assert.equal(body.codec, "aac");
  assert.equal(body.container, "mp4");

  const g = fakeFetch((url) => {
    assert.ok(url.includes("/m4a/stream/"));
    return new Response(new Uint8Array(1), { status: 206 });
  });
  assert.equal((await call(`/${KEY}/stream/R-hYM3BqTbA?quality=HIGH`, g)).status, 200);
});

test("stream of an uncatalogued track is 404 and queues it via /stream/add", async () => {
  const f = fakeFetch((url) =>
    url.includes("/api/v1/stream/add") ? Response.json({ queued: ["dQw4w9WgXcQ"] }) : new Response("{}", { status: 404 }),
  );
  const res = await call(`/${KEY}/stream/dQw4w9WgXcQ`, f);
  assert.equal(res.status, 404);
  const add = f.calls.find((c) => c.url.includes("/api/v1/stream/add"));
  assert.ok(add);
  assert.equal(add.headers.get("x-api-key"), null, "stream/add needs no key");
});

test("stream tries the next CDN node on network errors", async () => {
  let n = 0;
  const f = fakeFetch(() => {
    if (n++ === 0) throw new TypeError("network down");
    return new Response(flacHeader(44100, 16), { status: 206 });
  });
  const body = await (await call(`/${KEY}/stream/R-hYM3BqTbA`, f)).json();
  assert.equal(body.bitDepth, 16);
  assert.ok(f.calls[1].url.startsWith(CDN_INSTANCES[1]));
});

test("stream rejects ids that are not video ids, and needs MEDIA_SECRET", async () => {
  const f = fakeFetch(() => assert.fail("no upstream"));
  assert.equal((await call(`/${KEY}/stream/abc`, f)).status, 404);
  assert.equal((await call(`/${KEY}/stream/R-hYM3BqTbA`, f, {})).status, 500);
});

test("media proxy adds the bearer header, forwards Range and streams bytes", async () => {
  const probeFetch = fakeFetch(() => new Response(flacHeader(), { status: 206 }));
  const { url } = await (await call(`/${KEY}/stream/R-hYM3BqTbA`, probeFetch)).json();
  const path = new URL(url).pathname;

  const f = fakeFetch((u, headers) => {
    assert.equal(u, CDN_INSTANCES[0] + "/muzo/cdn/flac/lossless/R-hYM3BqTbA");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(headers.get("range"), "bytes=100-199");
    return new Response(new Uint8Array(100), {
      status: 206,
      headers: { "content-type": "audio/flac", "content-range": "bytes 100-199/5000", "content-length": "100" },
    });
  });
  const res = await call(path, f, ENV, { headers: { range: "bytes=100-199" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 100-199/5000");
  assert.equal(res.headers.get("content-type"), "audio/flac");
  assert.equal((await res.arrayBuffer()).byteLength, 100);
});

test("media tokens expire and cannot be forged", async () => {
  const live = await sealToken("s", { k: KEY, i: "R-hYM3BqTbA", f: "flac", c: 0, e: Math.floor(Date.now() / 1000) + 60 });
  assert.equal((await openToken("s", live)).i, "R-hYM3BqTbA");
  assert.equal(await openToken("other-secret", live), null);
  assert.equal(await openToken("s", live, Date.now() + 120_000), null);
  assert.equal(await openToken("s", "garbage"), null);

  const f = fakeFetch(() => assert.fail("no upstream"));
  assert.equal((await call(`/m/${live.slice(0, -2)}xx.flac`, f, { MEDIA_SECRET: "s" })).status, 403);
});

test("usage returns quota numbers only, never account details", async () => {
  const f = fakeFetch((url, headers) => {
    assert.equal(url, "https://data.kouzu.in/api/v1/user/usage");
    assert.equal(headers.get("x-api-key"), KEY);
    return Response.json({ usageToday: 3, dailyLimit: 200, remainingToday: 197, validityLabel: "Free", user: { email: "a@b.c" } });
  });
  const body = await (await call(`/${KEY}/usage`, f)).json();
  assert.deepEqual(body, { ok: true, dailyLimit: 200, usedToday: 3, remainingToday: 197, tier: "Free" });
});

test("helpers", () => {
  assert.equal(parseDuration({ duration: 214 }), 214);
  assert.equal(parseDuration({ duration: "1:02:03" }), 3723);
  assert.equal(parseDuration({ durationSeconds: "180" }), 180);
  assert.equal(parseDuration({ duration: 214000 }), 214);
  assert.equal(parseDuration({}), undefined);
  assert.deepEqual(parseFlacStreamInfo(flacHeader(192000, 24, 2)), { sampleRate: 192000, channels: 2, bitDepth: 24 });
  assert.equal(parseFlacStreamInfo(new Uint8Array(42)), null);
  assert.deepEqual(formatsForQuality("LOSSLESS"), ["flac", "m4a"]);
  assert.deepEqual(formatsForQuality("low"), ["m4a"]);
  assert.equal(secondsUntilUtcMidnight(Date.UTC(2025, 0, 1, 23, 59, 0)), 60);
  assert.equal(toTracks({ results: [{ resultType: "song", videoId: "R-hYM3BqTbA", title: "T", artists: ["A", "B"] }] }, "high")[0].artist, "A, B");
});
