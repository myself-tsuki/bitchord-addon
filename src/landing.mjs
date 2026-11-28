// The page at "/": the listener pastes their own Muzo Data key (BYOK) and
// copies the addon URL. The URL is built in the browser; the key only reaches
// this server if the listener presses "Check key" (to read their quota).

export function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>Muzo Data addon for BitChord</title>
<style>
  :root {
    --surface: #0e0f13;
    --surface-raised: #161820;
    --surface-sunken: #0a0b0e;
    --line: #2a2d38;
    --line-strong: #4a4f60;
    --text: #eceef4;
    --text-muted: #a3a8b8;
    --accent: #7cc4ff;
    --on-accent: #06121d;
    --ok: #7ee2a8;
    --bad: #ff9b9b;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --step-0: 0.875rem; --step-1: 1rem; --step-2: 1.125rem; --step-3: clamp(1.75rem, 1.4rem + 1.4vw, 2.25rem);
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px;
    --r-sm: 6px; --r-md: 10px; --r-lg: 14px;
    --ease: cubic-bezier(.2,.7,.2,1); --dur: 160ms;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: var(--step-1)/1.55 var(--sans); background: var(--surface); color: var(--text); }
  a { color: var(--accent); text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wrap { max-width: 680px; margin: 0 auto; padding-inline: var(--s4); }
  @media (min-width: 640px) { .wrap { padding-inline: var(--s5); } }

  header { padding-block: var(--s7) var(--s6); }
  .mark { display: flex; align-items: center; gap: var(--s2); color: var(--text-muted); font-size: var(--step-0); margin: 0 0 var(--s4); }
  .mark svg { flex: none; }
  h1 { font-size: var(--step-3); line-height: 1.15; letter-spacing: -0.02em; margin: 0 0 var(--s3); font-weight: 650; text-wrap: balance; }
  .lede { color: var(--text-muted); margin: 0; max-width: 60ch; text-wrap: pretty; }
  .specs { display: flex; flex-wrap: wrap; gap: var(--s2); list-style: none; padding: 0; margin: var(--s5) 0 0; }
  .specs li { font: var(--step-0)/1.3 var(--mono); color: var(--text); border: 1px solid var(--line); border-radius: var(--r-sm); padding: var(--s1) var(--s2); }

  main { padding-bottom: var(--s7); }
  .steps { list-style: none; margin: 0; padding: 0; }
  .step { display: grid; grid-template-columns: 32px 1fr; column-gap: var(--s4); position: relative; padding-bottom: var(--s6); }
  .step:last-child { padding-bottom: 0; }
  .step::before { content: ""; position: absolute; left: 15px; top: 36px; bottom: 4px; width: 2px; background: var(--line); }
  .step:last-child::before { display: none; }
  .num { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font: 600 var(--step-0)/1 var(--mono); border: 2px solid var(--line-strong); color: var(--text-muted); background: var(--surface); transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
  .step.done .num { border-color: var(--ok); color: var(--ok); }
  .step.live .num { border-color: var(--accent); color: var(--accent); }
  h2 { font-size: var(--step-2); line-height: 1.3; margin: 3px 0 var(--s3); font-weight: 600; }
  .hint { color: var(--text-muted); margin: var(--s3) 0 0; max-width: 62ch; text-wrap: pretty; }

  .field { display: flex; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface-sunken); transition: border-color var(--dur) var(--ease); }
  .field:focus-within { border-color: var(--accent); }
  .field.invalid { border-color: var(--bad); }
  .field input { flex: 1; min-width: 0; font: var(--step-1)/1.4 var(--mono); color: var(--text); background: transparent; border: 0; padding: var(--s3); border-radius: var(--r-md) 0 0 var(--r-md); }
  .field input::placeholder { color: #8a90a2; }
  .field input:focus-visible { outline: none; } /* the .field ring above replaces it */
  .field:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .reveal { flex: none; min-width: 64px; border: 0; border-left: 1px solid var(--line); background: transparent; color: var(--text-muted); font: 600 var(--step-0)/1 var(--sans); cursor: pointer; border-radius: 0 var(--r-md) var(--r-md) 0; }
  .reveal:hover { color: var(--text); }
  #key-msg { font-size: var(--step-0); margin: var(--s2) 0 0; color: var(--text-muted); }
  #key-msg:empty, #status:empty { display: none; }
  #key-msg.bad { color: var(--bad); }

  .url { display: grid; grid-template-columns: 1fr auto; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface-raised); overflow: hidden; }
  .url output { font: var(--step-0)/1.5 var(--mono); padding: var(--s3); word-break: break-all; color: var(--text); min-height: 48px; }
  .url output.empty { color: var(--text-muted); font-family: var(--sans); }
  @media (max-width: 479px) { .url { grid-template-columns: 1fr; } .url button { border-radius: 0; } }

  button { font: 600 var(--step-1)/1 var(--sans); min-height: 44px; padding: 0 var(--s4); border-radius: var(--r-sm); cursor: pointer; transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease); }
  .primary { background: var(--accent); color: var(--on-accent); border: 0; border-radius: 0; }
  .primary:hover { background: color-mix(in oklab, var(--accent), white 18%); }
  .primary:disabled { background: var(--line); color: var(--text-muted); cursor: not-allowed; }
  .secondary { background: transparent; color: var(--text); border: 1px solid var(--line-strong); }
  .secondary:hover { background: var(--surface-raised); }
  .secondary[aria-busy="true"] { color: var(--text-muted); }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin-top: var(--s3); }

  #status { margin: var(--s3) 0 0; }
  #status.ok { color: var(--ok); } #status.bad { color: var(--bad); }
  .meter { margin-top: var(--s3); max-width: 360px; }
  .meter[hidden] { display: none; }
  .meter-bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .meter-fill { height: 100%; width: 0; background: var(--ok); transition: width 400ms var(--ease); }
  .meter-fill.low { background: var(--bad); }
  .meter-text { display: flex; justify-content: space-between; font: var(--step-0)/1.4 var(--sans); color: var(--text-muted); margin-top: var(--s2); font-variant-numeric: tabular-nums; }

  .install { margin: 0; padding-left: 1.2em; color: var(--text-muted); }
  .install li { margin-bottom: var(--s2); }
  .install strong { color: var(--text); font-weight: 600; }
  kbd { font: var(--step-0) var(--mono); color: var(--text); }

  footer { border-top: 1px solid var(--line); padding-block: var(--s5) var(--s6); color: var(--text-muted); font-size: var(--step-0); }
  footer p { margin: 0 0 var(--s2); max-width: 64ch; }

  @media (prefers-reduced-motion: reduce) { *, *::before { transition-duration: 1ms !important; } }
</style>
</head>
<body>
<header class="wrap">
  <p class="mark">
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 9h2M6 5v8M9 2v14M12 6v6M15 8v2" stroke="#7cc4ff" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
    BitChord addon
  </p>
  <h1>Muzo Data addon for BitChord</h1>
  <p class="lede">Search and play lossless FLAC and AAC from <a href="https://data.kouzu.in" rel="noreferrer">Muzo Data</a> inside BitChord, with your own API key. Searches use your own quota (0.25 credit each); playback streams straight from the Muzo CDN and costs nothing.</p>
  <ul class="specs" aria-label="What you get">
    <li>FLAC up to 24-bit</li>
    <li>AAC 256 kbps</li>
    <li>Your own key</li>
  </ul>
</header>

<main class="wrap">
  <ol class="steps">
    <li class="step live" id="s1">
      <span class="num" aria-hidden="true">1</span>
      <div>
        <h2><label for="key">Paste your Muzo Data API key</label></h2>
        <div class="field" id="field">
          <input id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="muzo_live_…" aria-describedby="key-msg key-help">
          <button class="reveal" id="reveal" type="button" aria-controls="key" aria-pressed="false">Show</button>
        </div>
        <p id="key-msg" aria-live="polite"></p>
        <div class="actions">
          <button class="secondary" id="check" type="button">Check key and quota</button>
        </div>
        <p id="status" role="status" aria-live="polite"></p>
        <div class="meter" id="meter" hidden>
          <div class="meter-bar"><div class="meter-fill" id="meter-fill"></div></div>
          <div class="meter-text"><span id="meter-left"></span><span id="meter-tier"></span></div>
        </div>
        <p class="hint" id="key-help">No key yet? Create one free in the <a href="https://data.kouzu.in/console" rel="noreferrer">Muzo Data console</a>. Your key is not saved anywhere, on this page or on the server.</p>
      </div>
    </li>

    <li class="step" id="s2">
      <span class="num" aria-hidden="true">2</span>
      <div>
        <h2 id="url-label">Copy your addon URL</h2>
        <div class="url">
          <output id="out" class="empty" for="key" aria-labelledby="url-label">Appears here once your key is in.</output>
          <button class="primary" id="copy" type="button" disabled>Copy URL</button>
        </div>
        <p class="hint">It contains your key, so keep it private. If it leaks, roll the key in the Muzo console and copy a new URL.</p>
      </div>
    </li>

    <li class="step" id="s3">
      <span class="num" aria-hidden="true">3</span>
      <div>
        <h2>Add it in BitChord</h2>
        <ol class="install">
          <li>Open <strong>Settings → Sources → Add an addon</strong>.</li>
          <li>Paste the URL and save. BitChord checks the addon.</li>
          <li>Under the addon's name, pick <strong>Lossless</strong> (FLAC) or <strong>High</strong> (AAC).</li>
        </ol>
      </div>
    </li>
  </ol>
</main>

<footer class="wrap">
  <p>Audio plays directly from the Muzo Data CDN; this addon only finds the track and hands BitChord its link.</p>
  <p>Not affiliated with BitChord or Muzo Data.</p>
</footer>

<script>
  const $ = (id) => document.getElementById(id);
  const keyEl = $("key"), field = $("field"), msg = $("key-msg"), out = $("out"), copyBtn = $("copy");
  const status = $("status"), checkBtn = $("check"), meter = $("meter");
  const valid = (k) => /^muzo_[A-Za-z0-9_]{8,200}$/.test(k);
  const addonUrl = (k) => location.origin + "/" + k + "/manifest.json";
  const say = (text, cls) => { status.textContent = text; status.className = cls || ""; };

  function render() {
    const k = keyEl.value.trim();
    const ok = valid(k);
    field.classList.toggle("invalid", !!k && !ok);
    keyEl.setAttribute("aria-invalid", String(!!k && !ok));
    msg.className = k && !ok ? "bad" : "";
    msg.textContent = !k ? "" : ok ? "Looks like a Muzo key." : "That doesn't look like a Muzo key. It starts with muzo_live_.";
    out.textContent = ok ? addonUrl(k) : "Appears here once your key is in.";
    out.classList.toggle("empty", !ok);
    copyBtn.disabled = !ok;
    $("s1").className = "step " + (ok ? "done" : "live");
    $("s2").className = "step" + (ok ? " live" : "");
  }

  keyEl.addEventListener("input", () => { say(""); meter.hidden = true; copyBtn.textContent = "Copy URL"; render(); });
  $("reveal").addEventListener("click", (e) => {
    const show = keyEl.type === "password";
    keyEl.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(show));
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(out.textContent);
      copyBtn.textContent = "Copied";
      $("s2").className = "step done"; $("s3").className = "step live";
    } catch {
      const r = document.createRange(); r.selectNodeContents(out);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      say("Couldn't copy automatically. The URL is selected: press Ctrl+C or ⌘C.", "bad");
    }
  });

  checkBtn.addEventListener("click", async () => {
    const k = keyEl.value.trim();
    if (!valid(k)) { say("Paste a valid key first.", "bad"); keyEl.focus(); return; }
    checkBtn.setAttribute("aria-busy", "true"); checkBtn.textContent = "Checking…";
    say(""); meter.hidden = true;
    try {
      const r = await fetch("/" + k + "/usage", { cache: "no-store", referrerPolicy: "no-referrer" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { say(d.error || ("Muzo Data answered " + r.status + "."), "bad"); return; }
      const rem = d.remainingToday, lim = d.dailyLimit;
      if (rem != null && lim) {
        const left = Math.max(0, Number(rem));
        $("meter-fill").style.width = Math.min(100, (left / lim) * 100) + "%";
        $("meter-fill").classList.toggle("low", left / lim < 0.1);
        $("meter-left").textContent = left + " of " + lim + " left today";
        $("meter-tier").textContent = d.tier || "";
        meter.hidden = false;
        say(left > 0 ? "Key works." : "Key works, but today's search quota is used up. It resets at 00:00 UTC; playback keeps working.", left > 0 ? "ok" : "bad");
      } else {
        say("Key works.", "ok");
      }
    } catch {
      say("Couldn't reach the addon server. Try again.", "bad");
    } finally {
      checkBtn.removeAttribute("aria-busy"); checkBtn.textContent = "Check key and quota";
    }
  });
</script>
</body>
</html>`;
}
