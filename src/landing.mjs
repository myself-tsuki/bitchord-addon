// The page at "/": the listener pastes their Muzo Data key and copies the
// addon URL. Everything happens in the browser; the key is never sent here.

export function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Muzo Data addon for BitChord</title>
<style>
  :root { color-scheme: dark; --bg:#0e0f13; --card:#171920; --line:#2a2d38; --text:#eceef4; --muted:#a3a8b8; --accent:#7cc4ff; --ok:#7ee2a8; --bad:#ff9b9b; }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 640px; margin: 0 auto; padding: 48px 20px 64px; }
  h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 16px; }
  a { color: var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin-top:24px; }
  label { display:block; font-weight:600; margin-bottom:8px; }
  input, output { display:block; width:100%; font: 16px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding:12px; border-radius:8px; border:1px solid var(--line); background:#0b0c10; color:var(--text); word-break: break-all; }
  output { min-height: 48px; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin-top:12px; }
  button { min-height:44px; padding:0 18px; border-radius:8px; border:1px solid var(--line); background:#232633; color:var(--text); font:inherit; font-weight:600; cursor:pointer; }
  button.primary { background:var(--accent); color:#06121d; border-color:var(--accent); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  #status { margin-top:12px; min-height:1.5em; color:var(--muted); }
  #status.ok { color:var(--ok); } #status.bad { color:var(--bad); }
  ol { color:var(--muted); padding-left:20px; margin:0; } li { margin-bottom:6px; }
</style>
</head>
<body>
<main>
  <h1>Muzo Data addon for BitChord</h1>
  <p>Lossless FLAC and AAC from <a href="https://data.kouzu.in" rel="noreferrer">Muzo Data</a> inside BitChord. You bring your own API key, so you only ever use your own quota. Searches cost 0.25 of a credit; playing a track costs nothing.</p>

  <section class="card" aria-labelledby="step-key">
    <label id="step-key" for="key">Your Muzo Data API key</label>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="muzo_live_…">
    <p style="margin:8px 0 0">No key yet? Create one free in the <a href="https://data.kouzu.in/console" rel="noreferrer">Muzo Data console</a>.</p>
    <div class="row">
      <button id="check" type="button">Check key and quota</button>
    </div>
    <div id="status" role="status" aria-live="polite"></div>
  </section>

  <section class="card" aria-labelledby="step-url">
    <label id="step-url" for="out">Addon URL to paste in BitChord</label>
    <output id="out" for="key">Enter your key above.</output>
    <div class="row">
      <button id="copy" class="primary" type="button" disabled>Copy addon URL</button>
    </div>
  </section>

  <section class="card" aria-labelledby="step-install">
    <h2 id="step-install" style="font-size:1.1rem;margin:0 0 10px">Install</h2>
    <ol>
      <li>In BitChord open <strong>Settings → Sources → Add an addon</strong>.</li>
      <li>Paste the addon URL and save. BitChord runs a health check.</li>
      <li>Pick <em>Lossless</em> or <em>High</em> under the addon's name.</li>
    </ol>
    <p style="margin:12px 0 0">Keep the URL private: it contains your key. If it leaks, roll the key in the Muzo console and paste the new URL.</p>
  </section>
</main>
<script>
  const keyEl = document.getElementById("key"), out = document.getElementById("out");
  const copyBtn = document.getElementById("copy"), status = document.getElementById("status");
  const valid = (k) => /^muzo_[A-Za-z0-9_]{8,200}$/.test(k);
  const addonUrl = (k) => location.origin + "/" + k + "/manifest.json";
  function say(text, cls) { status.textContent = text; status.className = cls || ""; }
  function render() {
    const k = keyEl.value.trim();
    if (!k) { out.textContent = "Enter your key above."; copyBtn.disabled = true; return; }
    if (!valid(k)) { out.textContent = "That doesn't look like a Muzo key (it starts with muzo_live_)."; copyBtn.disabled = true; return; }
    out.textContent = addonUrl(k); copyBtn.disabled = false;
  }
  keyEl.addEventListener("input", () => { say(""); render(); });
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(out.textContent); say("Copied.", "ok"); }
    catch { say("Copy failed; select the URL and copy it by hand.", "bad"); }
  });
  document.getElementById("check").addEventListener("click", async () => {
    const k = keyEl.value.trim();
    if (!valid(k)) { say("Enter a valid key first.", "bad"); return; }
    say("Checking…");
    try {
      const r = await fetch("/" + k + "/usage", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { say(d.error || ("Muzo answered " + r.status), "bad"); return; }
      const rem = d.remainingToday, lim = d.dailyLimit;
      say(rem != null && lim != null ? "Key works: " + rem + " of " + lim + " credits left today." : "Key works.", "ok");
    } catch { say("Could not reach the addon server.", "bad"); }
  });
</script>
</body>
</html>`;
}
