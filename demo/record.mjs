// Records a real run of VICE EXCHANGE in the 3D city view: headless Chrome driven in real time over the Chrome DevTools
// Protocol against a real server with real Drex decisions. Frames come from Page.startScreencast (every frame, acked),
// one page at a time wherever possible so motion stays smooth.
// Usage: OUT=<take dir> BASE=http://localhost:5781 API=http://localhost:3781 node demo/record.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.OUT, BASE = process.env.BASE, API = process.env.API;
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: Date.now(), ...extra }); console.log("MARK", name, JSON.stringify(extra)); };
const kids = [];
const save = (extra = {}) => writeFileSync(`${OUT}/marks.json`, JSON.stringify({ marks, ...extra }, null, 0));

async function browser(port, tag) {
  mkdirSync(`${OUT}/${tag}`, { recursive: true });
  const p = spawn(CH, ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1600,900", "--hide-scrollbars", "--use-angle=metal",
    "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${OUT}/profile-${tag}`, "about:blank"], { stdio: "ignore" });
  kids.push(p);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(250); }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const frames = []; let seq = 0; let casting = false; const logs = []; let lastFrame = 0; let shotMode = false; let restarts = 0;
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === "Page.screencastFrame") {
      send("Page.screencastFrameAck", { sessionId: d.params.sessionId });
      if (!casting) return;
      const f = `${tag}/${String(++seq).padStart(6, "0")}.jpg`;
      writeFileSync(`${OUT}/${f}`, Buffer.from(d.params.data, "base64"));
      frames.push({ f, t: Date.now() }); lastFrame = Date.now();
    }
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 200));
  };
  // Watchdog: headless Chrome sometimes stops delivering screencast frames. Restart the screencast, and if it stalls
  // again fall back to a screenshot loop for this page so the take is never lost.
  const shotLoop = async () => { while (casting && shotMode) { const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 }); if (!casting || !r.result?.data) continue; const f = `${tag}/${String(++seq).padStart(6, "0")}.jpg`; writeFileSync(`${OUT}/${f}`, Buffer.from(r.result.data, "base64")); frames.push({ f, t: Date.now() }); lastFrame = Date.now(); } };
  setInterval(async () => {
    if (!casting || shotMode || Date.now() - lastFrame < 700) return;
    restarts++; console.log("WATCHDOG", tag, "screencast stalled, restart", restarts);
    if (restarts > 2) { shotMode = true; send("Page.stopScreencast"); shotLoop(); return; }
    lastFrame = Date.now();
    await send("Page.stopScreencast"); await send("Page.bringToFront"); await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
  }, 400).unref();
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const key = (type, k) => send("Input.dispatchKeyEvent", { type, key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  return {
    tag, frames, logs, send, proc: p,
    nav: (url) => send("Page.navigate", { url }),
    async cast(on) {
      if (on && !casting) { casting = true; lastFrame = Date.now(); if (shotMode) { shotLoop(); return; } await send("Page.bringToFront"); await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 }); }
      else if (!on && casting) { casting = false; await send("Page.stopScreencast"); }
    },
    async hold(k, ms) { await key("rawKeyDown", k); await sleep(ms); await key("keyUp", k); },
    async press(k) { await key("rawKeyDown", k); await sleep(70); await key("keyUp", k); },
    /** Left-drag on the 3D canvas: orbits the camera. */
    async drag(x0, y0, x1, y1, ms = 900) {
      await mouse("mouseMoved", x0, y0, { buttons: 0 }); await mouse("mousePressed", x0, y0);
      const n = Math.max(6, Math.round(ms / 30));
      for (let i = 1; i <= n; i++) { await mouse("mouseMoved", x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); await sleep(ms / n); }
      await mouse("mouseReleased", x1, y1);
    },
    wheel: (x, y, dy) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }),
    async js(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; },
    clickText: function (re, sel = "button") { return this.js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>${re}.test(x.textContent||""));if(!b)return false;b.click();return (b.textContent||"").trim().slice(0,60)})()`); },
    close() { try { p.kill(); } catch {} },
  };
}
const snap = async () => (await fetch(`${API}/api/rooms/VICE-42/snapshot`)).json();
const live = (s, nick) => s.characters.find((c) => c.nickname === nick && !["CAPTURED", "ARCHIVED"].includes(c.status));
/** Walks with the chase camera at its default yaw, where W is north (-z) and D is east (+x). */
async function walkTo(P, nick, tx, tz, maxSteps = 90) {
  for (let i = 0; i < maxSteps; i++) {
    const c = live(await snap(), nick); if (!c) return false;
    const dx = tx - c.x, dz = tz - c.z; if (Math.hypot(dx, dz) < 1.5) return true;
    const k = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "d" : "a") : (dz > 0 ? "s" : "w");
    await P.hold(k, Math.min(500, Math.max(70, (Math.max(Math.abs(dx), Math.abs(dz)) / 9) * 800)));
  }
  return false;
}

let A, B, C;
try {
  A = await browser(9441, "A");
  await A.nav(`${BASE}/?nick=Ace&role=OUTLAW&room=VICE-42&auto=1&view=3d`);
  await sleep(6000);
  C = await browser(9443, "C");
  await C.nav(`${BASE}/?nick=Judge&role=SPECTATOR&room=VICE-42&auto=1&view=3d`);
  await sleep(6000);
  // Shot: the whole city from the spectator's orbit camera (many labelled NPCs in frame).
  await C.cast(true);
  mark("city");
  await C.drag(500, 300, 760, 330, 5000);
  await sleep(1500);
  await C.cast(false);
  // Shot: two players. The hunter joins; both pages are recorded only for this shot.
  B = await browser(9442, "B");
  await B.nav(`${BASE}/?nick=Rio&role=HUNTER&room=VICE-42&auto=1&view=3d`);
  await sleep(6500);
  await A.cast(true); await B.cast(true);
  mark("two");
  await Promise.all([
    (async () => { await A.hold("d", 900); await sleep(400); await A.hold("a", 900); await sleep(400); await A.hold("w", 600); })(),
    (async () => { await B.hold("s", 1300); await sleep(400); await B.hold("a", 1100); await sleep(300); await B.hold("d", 1100); })(),
  ]);
  await sleep(1500);
  await B.cast(false);
  B.close();
  await sleep(800);
  // Shot: the job, from the outlaw's own page, chase camera.
  let s = await snap();
  const m = s.missions.find((x) => x.status === "AVAILABLE");
  mark("job", { mission: [m.x, m.z], priceBefore: s.listings.find((l) => l.status === "ACTIVE")?.spotPrice });
  const reached = await walkTo(A, "Ace", m.x, m.z);
  await A.press("e");
  mark("jobdone", { reached });
  const alive = async (P, label) => { const r = await Promise.race([P.js("1+1"), sleep(4000).then(() => "TIMEOUT")]); console.log("ALIVE", label, r, "frames", P.frames.length, "logs", JSON.stringify(P.logs.slice(-3))); return r === 2; };
  await sleep(1500); await alive(A, "after job");
  if (process.env.PROBE) { await sleep(3000); await alive(A, "after job +4.5s"); await alive(C, "spectator"); throw new Error("probe end"); }
  save({ framesA: A.frames, framesB: B.frames, framesC: C.frames });
  await sleep(2500);
  // Camera work while the swarm reacts: orbit, then the high-angle preset so more of the street is in frame.
  await A.drag(520, 330, 700, 300, 1800);
  await sleep(2500);
  await A.press("c");
  mark("chain");
  await sleep(8500);
  // Inspector on the SPECTATOR page (never on the outlaw page before capture).
  await C.cast(true);
  const chip = await C.clickText("/Duarte/", "button.chip");
  mark("inspect", { chip });
  await sleep(4500);
  await C.js(`(()=>{const el=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+40&&getComputedStyle(e).overflowY!=='visible'&&e.closest('.inspector, [class*=inspect], [class*=agent]'));const t=el[el.length-1];if(t){t.scrollBy({top:260,behavior:'smooth'});return t.className}return null})()`);
  await sleep(5000);
  mark("inspectend");
  await C.cast(false);
  // Pursuit and capture, outlaw page. Cinematic preset for the approach.
  await A.press("c"); await sleep(300); await A.press("c");
  mark("pursuit");
  let captured = false; const t0 = Date.now();
  while (Date.now() - t0 < 80000) {
    s = await snap();
    const ace = s.characters.find((c) => c.nickname === "Ace");
    if (ace && ace.status === "CAPTURED") { captured = true; break; }
    await sleep(300);
  }
  s = await snap();
  mark("crash", { captured, listing: s.listings.map((l) => [l.ticker, l.status, l.spotPrice]), by: s.recentEvents.filter((e) => e.type === "CAPTURE_SUCCEEDED").map((e) => [e.payload.captorName, e.payload.bounty, e.payload.survivalSeconds]) });
  save({ framesA: A.frames, framesB: B.frames, framesC: C.frames });
  await sleep(7500);
  mark("halted");
  // A buy on the halted ticker, sent over the page's own socket: the server must reject it.
  const rej = await A.clickText("/BUY 1/");
  mark("rejected", { clicked: rej });
  await sleep(3000);
  mark("respawn");
  await A.press("r");
  await sleep(1500);
  await A.press("v");
  await A.hold("w", 900); await sleep(300); await A.hold("d", 900);
  await sleep(3500);
  s = await snap();
  mark("proof", { listings: s.listings.map((l) => [l.ticker, l.status, l.spotPrice]), metrics: s.metrics.decisions, latency: s.metrics.latency, shadow: s.metrics.shadow, trades: s.trades.map((t) => [t.actorName, t.side, t.ticker, t.executionPrice]) });
  await A.clickText("/DEMO DIRECTOR/");
  await sleep(2500);
  const exp = await A.clickText("/Run scripted/");
  console.log("experiment button:", exp);
  const t1 = Date.now(); let done = null;
  while (exp && Date.now() - t1 < 75000) {
    const xs = await (await fetch(`${API}/api/experiments`)).json();
    done = xs.find((x) => x.status === "DONE"); if (done) break;
    await sleep(700);
  }
  mark("expdone", { rows: done?.rows?.map((r) => ({ mode: r.mode, calls: r.realProviderCalls, p50: r.latencyP50Ms, p95: r.latencyP95Ms, trades: r.npcTrades, captured: r.captured })) });
  await sleep(1500);
  await A.js(`(()=>{const el=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+30&&getComputedStyle(e).overflowY!=='visible'&&e.querySelector('.exp-head'));const t=el[el.length-1];if(t){const h=t.querySelector('.exp-head');h.scrollIntoView({block:'start',behavior:'smooth'});return t.className}return null})()`);
  await sleep(6000);
  mark("proofend");
  await A.cast(false);
  const evs = await (await fetch(`${API}/api/rooms/VICE-42/events?limit=1000`)).json();
  // Replay verify, shown as the raw server response (large type).
  await C.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 450, deviceScaleFactor: 2, mobile: false });
  await C.nav(`${API}/api/rooms/VICE-42/replay/verify`);
  await sleep(1500);
  const r = await C.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/verify.png`, Buffer.from(r.result.data, "base64"));
  const v = await (await fetch(`${API}/api/rooms/VICE-42/replay/verify`)).json();
  mark("verify", { ok: v.ok, source: v.source, events: v.eventCount, mismatches: v.mismatches.length });
  save({ framesA: A.frames, framesB: B.frames, framesC: C.frames, events: evs.events.map((e) => ({ type: e.type, t: Date.parse(e.time), actor: e.actorId, p: e.type === "DECISION_RESOLVED" ? { src: e.payload.decisionSource, role: e.payload.role, action: e.payload.chosenAction, ms: e.payload.latencyMs } : e.type === "TRADE_REJECTED" ? { reason: e.payload.reason } : undefined })), logsA: A.logs, logsC: C.logs });
  const fps = (fr) => (fr.length > 1 ? (fr.length / ((fr[fr.length - 1].t - fr[0].t) / 1000)).toFixed(1) : "0");
  console.log("frames A", A.frames.length, "fps", fps(A.frames), "B", B.frames.length, "C", C.frames.length, "logs", A.logs.slice(0, 5));
} catch (e) { console.error("DRIVER ERROR", e); try { save({ framesA: A?.frames ?? [], framesB: B?.frames ?? [], framesC: C?.frames ?? [] }); } catch {} } finally { for (const k of kids) { try { k.kill(); } catch {} } }
