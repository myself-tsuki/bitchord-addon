// Node 20+ entry point for full-server hosts (Render, Railway, Fly.io, Koyeb, a VPS).
//   MEDIA_SECRET=... PORT=8787 node server.mjs
import http from "node:http";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { handle } from "./src/addon.mjs";

const env = { ...process.env };
if (!env.MEDIA_SECRET) {
  env.MEDIA_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn(
    "MEDIA_SECRET is not set: using a random one. Media links will stop working after a restart; set MEDIA_SECRET to a long random string.",
  );
}

const port = Number(process.env.PORT) || 8787;

const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }

  try {
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers,
      signal: controller.signal,
    });
    const pending = [];
    const response = await handle(request, env, { waitUntil: (p) => pending.push(p) });
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (response.body && req.method !== "HEAD") {
      Readable.fromWeb(response.body)
        .on("error", () => res.destroy())
        .pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Internal error" }));
    } else {
      res.destroy();
    }
    // Never log the URL: it contains the listener's API key.
    console.error("request failed:", err && err.name);
  }
});

server.listen(port, () => console.log(`Muzo Data BitChord addon listening on :${port}`));
