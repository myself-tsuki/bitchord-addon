import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  handle,
  toTracks,
  parseDuration,
  bitDepthFromQuality,
  OPEN_CDN_NODES,
  formatsForQuality,
  secondsUntilUtcMidnight,
  _clearCaches,
} from "../src/addon.mjs";

const KEY = "muzo_live_" + "ab".repeat(24);
const ENV = {};
const BASE = "https://addon.example.com";

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

const CDN_A = "https://calm-bread-1e03.muzom4andlossless.workers.dev";
const CDN_B = "https://odd-frog-5512.antig9469.workers.dev";
/** Shape of a real GET /api/v1/stream?id= answer (Nov 2026). */
function streamAnswer(id = "R-hYM3BqTbA", extra = {}) {
  return {
    id,
    name: "Self Aware",
    artist: "Temper City",
    cdnBaseUrl: CDN_A,
    cdnInstances: [CDN_A, CDN_B],
    format: "flac",
    quality: "lossless_24bit",
    losslessUrl: `${CDN_A}/muzo/cnd/flac/lossless/${id}`,
    losslessUrls: [`${CDN_A}/muzo/cnd/flac/lossless/${id}`, `${CDN_B}/muzo/cnd/flac/lossless/${id}`],
    m4aUrl: `${CDN_A}/muzo/cnd/m4a/stream/${id}`,
    m4aUrls: [`${CDN_A}/muzo/cnd/m4a/stream/${id}`, `${CDN_B}/muzo/cnd/m4a/stream/${id}`],
    ...extra,
  };
}

test("stream returns Muzo's direct lossless URL unchanged (no proxy)", async () => {
  const answer = streamAnswer();
  const f = fakeFetch((url, headers) => {
    assert.equal(url, "https://data.kouzu.in/api/v1/stream?id=R-hYM3BqTbA");
    assert.equal(headers.get("x-api-key"), KEY);
    return Response.json(answer);
  });
  const res = await call(`/${KEY}/stream/R-hYM3BqTbA?quality=lossless`, f);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, answer.losslessUrl, "URL must be exactly what Muzo gave");
  assert.ok(!body.url.startsWith(BASE), "must not point back at the addon");
  assert.equal(body.codec, "flac");
  assert.equal(body.container, "flac");
  assert.equal(body.manifest, "none");
  assert.equal(body.encrypted, false);
  assert.equal(body.bitDepth, 24);
  assert.equal(body.quality, "Lossless · 24-bit");
  assert.equal(f.calls.length, 1, "one resolver call, no CDN probing");
});

test("high quality returns the direct AAC URL; lossless falls back to it when FLAC is missing", async () => {
  const answer = streamAnswer();
  const high = await (await call(`/${KEY}/stream/R-hYM3BqTbA?quality=HIGH`, fakeFetch(() => Response.json(answer)))).json();
  assert.equal(high.url, answer.m4aUrl);
  assert.equal(high.codec, "aac");
  assert.equal(high.container, "mp4");

  const noFlac = streamAnswer("R-hYM3BqTbA", { losslessUrl: null, losslessUrls: [] });
  const body = await (await call(`/${KEY}/stream/R-hYM3BqTbA?quality=lossless`, fakeFetch(() => Response.json(noFlac)))).json();
  assert.equal(body.url, noFlac.m4aUrl);
  assert.equal(body.codec, "aac");
});

test("stream uses the first URL of the list when the single field is absent", async () => {
  const answer = streamAnswer("R-hYM3BqTbA", { losslessUrl: undefined });
  const body = await (await call(`/${KEY}/stream/R-hYM3BqTbA`, fakeFetch(() => Response.json(answer)))).json();
  assert.equal(body.url, answer.losslessUrls[0]);
});

test("stream of an uncatalogued track is 404 and queues it via /stream/add", async () => {
  const f = fakeFetch((url) =>
    url.includes("/api/v1/stream/add") ? Response.json({ queued: ["dQw4w9WgXcQ"] }) : Response.json({ error: "not found" }, { status: 404 }),
  );
  const res = await call(`/${KEY}/stream/dQw4w9WgXcQ`, f);
  assert.equal(res.status, 404);
  const add = f.calls.find((c) => c.url.includes("/api/v1/stream/add"));
  assert.ok(add);
  assert.equal(add.headers.get("x-api-key"), null, "stream/add needs no key");
});

test("stream maps Muzo 401 and network errors", async () => {
  assert.equal((await call(`/${KEY}/stream/R-hYM3BqTbA`, fakeFetch(() => Response.json({}, { status: 401 })))).status, 401);
  const down = fakeFetch(() => {
    throw new TypeError("network down");
  });
  assert.equal((await call(`/${KEY}/stream/R-hYM3BqTbA`, down)).status, 502);
});

test("stream rejects ids that are not video ids, needs no server secret, and /m is gone", async () => {
  const f = fakeFetch(() => assert.fail("no upstream"));
  assert.equal((await call(`/${KEY}/stream/abc`, f)).status, 404);
  const ok = await call(`/${KEY}/stream/R-hYM3BqTbA`, fakeFetch(() => Response.json(streamAnswer())), {});
  assert.equal(ok.status, 200);
  assert.equal((await call(`/m/sometoken.flac`, f)).status, 404);
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
  assert.equal(bitDepthFromQuality("lossless_24bit"), 24);
  assert.equal(bitDepthFromQuality("lossless_16bit"), 16);
  assert.equal(bitDepthFromQuality("lossless"), undefined);
  assert.deepEqual(formatsForQuality("LOSSLESS"), ["flac", "m4a"]);
  assert.deepEqual(formatsForQuality("low"), ["m4a"]);
  assert.equal(secondsUntilUtcMidnight(Date.UTC(2025, 0, 1, 23, 59, 0)), 60);
  assert.equal(toTracks({ results: [{ resultType: "song", videoId: "R-hYM3BqTbA", title: "T", artists: ["A", "B"] }] }, "high")[0].artist, "A, B");
});

test("quota used up (429): stream hands out the same direct URL from an open node, never a proxy", async () => {
  const f = fakeFetch((url, headers) => {
    if (url.startsWith("https://data.kouzu.in/api/v1/stream?")) return Response.json({ error: "quota" }, { status: 429 });
    assert.equal(headers.get("authorization"), null, "direct URLs need no auth");
    assert.equal(headers.get("range"), "bytes=0-0", "only a 1-byte check");
    if (url.startsWith(OPEN_CDN_NODES[0])) throw new TypeError("node down");
    return new Response(new Uint8Array(1), { status: 206 });
  });
  const body = await (await call(`/${KEY}/stream/R-hYM3BqTbA?quality=lossless`, f)).json();
  assert.equal(body.url, `${OPEN_CDN_NODES[1]}/muzo/cnd/flac/lossless/R-hYM3BqTbA`);
  assert.equal(body.codec, "flac");
  const high = await (await call(`/${KEY}/stream/R-hYM3BqTbA?quality=high`, f)).json();
  assert.equal(high.url, `${OPEN_CDN_NODES[1]}/muzo/cnd/m4a/stream/R-hYM3BqTbA`);
});

test("quota used up and the track is missing everywhere: 404 and queued", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/api/v1/stream/add")) return Response.json({ queued: [] });
    if (url.includes("/api/v1/stream?")) return Response.json({}, { status: 429 });
    return new Response("{}", { status: 404 });
  });
  assert.equal((await call(`/${KEY}/stream/dQw4w9WgXcQ`, f)).status, 404);
  assert.ok(f.calls.some((c) => c.url.includes("/api/v1/stream/add")));
});
