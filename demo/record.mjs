// Records a real run of VICE EXCHANGE: two headless Chrome instances (Outlaw, Hunter) driven in real time over the
// Chrome DevTools Protocol against a real server with real Drex decisions. Frames come from Page.startScreencast.
// Usage: OUT=<work dir> BASE=http://localhost:5771 API=http://localhost:3771 node demo/record.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.OUT, BASE = process.env.BASE, API = process.env.API;
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: Date.now(), ...extra }); console.log("MARK", name, JSON.stringify(extra)); };
const kids = [];

async function browser(port, tag) {
  mkdirSync(`${OUT}/${tag}`, { recursive: true });
  const p = spawn(CH, ["--headless=new", `--remote-debugging-port=${port}`, "--window-size=1600,900", "--hide-scrollbars", "--use-angle=metal",
    "--ignore-gpu-blocklist", `--user-data-dir=${OUT}/profile-${tag}`, "about:blank"], { stdio: "ignore" });
  kids.push(p);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(250); }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const frames = []; let seq = 0; let casting = false; const logs = [];
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === "Page.screencastFrame") {
      send("Page.screencastFrameAck", { sessionId: d.params.sessionId });
      if (!casting) return;
      const f = `${tag}/${String(++seq).padStart(6, "0")}.jpg`;
      writeFileSync(`${OUT}/${f}`, Buffer.from(d.params.data, "base64"));
      frames.push({ f, t: Date.now() });
    }
    if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 200));
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const key = (type, k) => send("Input.dispatchKeyEvent", { type, key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  return {
    tag, frames, logs, send,
    nav: (url) => send("Page.navigate", { url }),
    async cast(on) {
      if (on && !casting) { casting = true; (async () => { while (casting) { const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 78 }); if (!casting || !r.result?.data) continue; const f = `${tag}/${String(++seq).padStart(6, "0")}.jpg`; writeFileSync(`${OUT}/${f}`, Buffer.from(r.result.data, "base64")); frames.push({ f, t: Date.now() }); } })(); }
      else if (!on) casting = false;
    },
    async hold(k, ms) { await key("rawKeyDown", k); await sleep(ms); await key("keyUp", k); },
    async press(k) { await key("rawKeyDown", k); await sleep(70); await key("keyUp", k); },
    async js(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; },
    clickText: function (re, sel = "button") { return this.js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>${re}.test(x.textContent||""));if(!b)return false;b.click();return (b.textContent||"").trim().slice(0,60)})()`); },
  };
}
const snap = async () => (await fetch(`${API}/api/rooms/VICE-42/snapshot`)).json();
const live = (s, nick) => s.characters.find((c) => c.nickname === nick && !["CAPTURED", "ARCHIVED"].includes(c.status));
async function walkTo(P, nick, tx, tz, maxSteps = 90) {
  for (let i = 0; i < maxSteps; i++) {
    const c = live(await snap(), nick); if (!c) return false;
    const dx = tx - c.x, dz = tz - c.z; if (Math.hypot(dx, dz) < 1.5) return true;
    const k = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "d" : "a") : (dz > 0 ? "s" : "w");
    await P.hold(k, Math.min(500, Math.max(70, (Math.max(Math.abs(dx), Math.abs(dz)) / 9) * 800)));
  }
  return false;
}

try {
  const A = await browser(9341, "A"), B = await browser(9342, "B"), C = await browser(9343, "C");
  await A.nav(`${BASE}/?nick=Ace&role=OUTLAW&room=VICE-42&auto=1&view=2d`);
  await sleep(3500);
  await C.nav(`${BASE}/?nick=Judge&role=SPECTATOR&room=VICE-42&auto=1&view=2d`);
  await sleep(3500);
  await A.cast(true); await C.cast(true);
  mark("city");
  await sleep(4000);
  await B.nav(`${BASE}/?nick=Rio&role=HUNTER&room=VICE-42&auto=1&view=2d`);
  await sleep(5000);
  await B.cast(true);
  mark("two");
  await Promise.all([
    (async () => { await A.hold("d", 900); await sleep(500); await A.hold("a", 900); await sleep(500); await A.hold("w", 700); await sleep(400); await A.hold("s", 700); })(),
    (async () => { await B.hold("s", 1400); await sleep(400); await B.hold("a", 1200); await sleep(400); await B.hold("d", 1200); await B.hold("w", 900); })(),
  ]);
  await sleep(2500);
  await B.cast(false);
  let s = await snap();
  const m = s.missions.find((x) => x.status === "AVAILABLE");
  mark("job", { mission: [m.x, m.z], priceBefore: s.listings.find((l) => l.status === "ACTIVE")?.spotPrice });
  const reached = await walkTo(A, "Ace", m.x, m.z);
  await A.press("e");
  mark("jobdone", { reached });
  await sleep(7000);
  mark("chain");
  await sleep(9000);
  const chip = await A.clickText("/Duarte/", "button.chip");
  mark("inspect", { chip });
  await sleep(4500);
  await A.js(`(()=>{const el=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+40&&getComputedStyle(e).overflowY!=='visible'&&e.closest('.inspector, [class*=inspect], [class*=agent]'));const t=el[el.length-1];if(t){t.scrollBy({top:260,behavior:'smooth'});return t.className}return null})()`);
  await sleep(5000);
  await A.clickText("/Duarte/", "button.chip");
  mark("pursuit");
  let captured = false; const t0 = Date.now();
  while (Date.now() - t0 < 75000) {
    s = await snap();
    const ace = s.characters.find((c) => c.nickname === "Ace");
    if (ace && ace.status === "CAPTURED") { captured = true; break; }
    await sleep(300);
  }
  s = await snap();
  mark("crash", { captured, listing: s.listings.map((l) => [l.ticker, l.status, l.spotPrice]), by: s.recentEvents.filter((e) => e.type === "CAPTURE_SUCCEEDED").map((e) => [e.payload.captorName, e.payload.bounty, e.payload.survivalSeconds]) });
  await sleep(6500);
  mark("halted");
  await sleep(3500);
  mark("respawn");
  await A.press("r");
  await sleep(6500);
  s = await snap();
  mark("proof", { listings: s.listings.map((l) => [l.ticker, l.status, l.spotPrice]), metrics: s.metrics.decisions, latency: s.metrics.latency, shadow: s.metrics.shadow });
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
  await A.cast(false); await C.cast(false);
  const evs = await (await fetch(`${API}/api/rooms/VICE-42/events?limit=1000`)).json();
  // Replay verify, shown as the raw server response (large type).
  await B.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 450, deviceScaleFactor: 2, mobile: false });
  await B.nav(`${API}/api/rooms/VICE-42/replay/verify`);
  await sleep(1500);
  const r = await B.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/verify.png`, Buffer.from(r.result.data, "base64"));
  const v = await (await fetch(`${API}/api/rooms/VICE-42/replay/verify`)).json();
  mark("verify", { ok: v.ok, source: v.source, events: v.eventCount, mismatches: v.mismatches.length });
  writeFileSync(`${OUT}/marks.json`, JSON.stringify({ marks, framesA: A.frames, framesB: B.frames, framesC: C.frames, events: evs.events.map((e) => ({ type: e.type, t: Date.parse(e.time), actor: e.actorId, p: e.type === "DECISION_RESOLVED" ? { src: e.payload.decisionSource, role: e.payload.role, action: e.payload.chosenAction, ms: e.payload.latencyMs } : undefined })), logsA: A.logs, logsB: B.logs }, null, 0));
  console.log("frames A", A.frames.length, "B", B.frames.length, "C", C.frames.length, "logs", A.logs.slice(0, 5));
} catch (e) { console.error("DRIVER ERROR", e); } finally { for (const k of kids) k.kill(); }
