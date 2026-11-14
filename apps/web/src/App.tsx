import { useEffect, useMemo, useState } from "react";
import { CREDITS_NOTICE, RULES, dist } from "@vice/contracts";
import type { CharacterView, MissionView } from "@vice/contracts";
import "./styles.css";
import { CityView, has3D } from "./scene";
import { JoinRoom } from "./components/JoinRoom";
import { MarketPanel } from "./components/MarketPanel";
import { AgentInspector } from "./components/AgentInspector";
import { EventTimeline } from "./components/EventTimeline";
import { DemoDirector } from "./components/DemoDirector";
import TickerTape from "./components/wow/TickerTape";
import DecisionSpotlight from "./components/wow/DecisionSpotlight";
import CrashCinematic from "./components/wow/CrashCinematic";
import SwarmGraph from "./components/wow/SwarmGraph";
import { getPose, isLive, selectMyCharacter, useGame, useMyCharacter } from "./state/gameStore";
import { leaveRoom, newId, send, sendNoAck } from "./net/socketClient";
import { vd } from "./lib/format";

function nearestMission(me: CharacterView, missions: MissionView[]): MissionView | null {
  const p = getPose(me.id) ?? me;
  let best: MissionView | null = null, bd = Infinity;
  for (const m of missions) {
    if (m.status !== "AVAILABLE") continue;
    const d = dist(p, m);
    if (d < bd) { bd = d; best = m; }
  }
  return best && bd <= RULES.missionInteractRadius ? best : null;
}
function nearestWanted(me: CharacterView, chars: CharacterView[]): CharacterView | null {
  const p = getPose(me.id) ?? me;
  let best: CharacterView | null = null, bd = Infinity;
  for (const c of chars) {
    if (c.id === me.id || c.status !== "WANTED") continue;
    const d = dist(p, getPose(c.id) ?? c);
    if (d < bd) { bd = d; best = c; }
  }
  return best && bd <= RULES.captureRadius ? best : null;
}

/** Keyboard: WASD/arrows = move intent, E = interact/capture, R = respawn. The server decides every outcome. */
function useControls(): void {
  useEffect(() => {
    const down = new Set<string>();
    let lastX = 0, lastZ = 0;
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    const pushMove = () => {
      const st = useGame.getState();
      const me = selectMyCharacter(st);
      if (!me || !isLive(me)) return;
      const x = (down.has("d") || down.has("arrowright") ? 1 : 0) - (down.has("a") || down.has("arrowleft") ? 1 : 0);
      const z = (down.has("s") || down.has("arrowdown") ? 1 : 0) - (down.has("w") || down.has("arrowup") ? 1 : 0);
      if (x === lastX && z === lastZ) return;
      lastX = x; lastZ = z;
      sendNoAck({ type: "player.move", dirX: x, dirZ: z, lastSeenTick: st.tick });
    };
    const act = async () => {
      const st = useGame.getState();
      const me = selectMyCharacter(st);
      if (!me || !st.session) return;
      if (!isLive(me)) { st.toast("You are captured. Press R to respawn with a new ticker.", "bad"); return; }
      if (me.role === "HUNTER") {
        const target = nearestWanted(me, Object.values(st.characters));
        if (!target) { st.toast("No wanted target within 2.5 m.", "info"); return; }
        const ack = await send({ type: "capture.attempt", targetCharacterId: target.id, commandId: newId() });
        if (!ack.ok) st.toast(`Capture rejected: ${(ack.error?.reason ?? ack.error?.message ?? "").toLowerCase().replace(/_/g, " ")}`, "bad");
        return;
      }
      const m = nearestMission(me, Object.values(st.missions));
      if (!m) { st.toast("Nothing to interact with here. Reach the job marker.", "info"); return; }
      const ack = await send({ type: "mission.interact", missionId: m.id, commandId: newId() });
      if (!ack.ok) st.toast(`Job failed: ${ack.error?.message ?? "rejected"}`, "bad");
      else st.toast("Job done. Notoriety up — and someone may have seen you.", "good");
    };
    const respawn = async () => {
      const st = useGame.getState();
      const me = selectMyCharacter(st);
      if (!me || isLive(me)) return;
      const ack = await send({ type: "character.respawn", commandId: newId() });
      if (!ack.ok) st.toast(`Respawn failed: ${ack.error?.message ?? "rejected"}`, "bad");
      else st.toast("New life, new ticker. Your old record stays on the board.", "good");
    };
    const onDown = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        e.preventDefault(); down.add(k); pushMove();
      } else if (k === "e" && !e.repeat) { void act(); }
      else if (k === "r" && !e.repeat) { void respawn(); }
    };
    const onUp = (e: KeyboardEvent) => { down.delete(e.key.toLowerCase()); pushMove(); };
    const onBlur = () => { down.clear(); pushMove(); };
    // Re-assert the current intent periodically so a dropped packet cannot leave the avatar stuck.
    const keepAlive = setInterval(() => { if (down.size) { lastX = NaN; pushMove(); } }, 1000);
    window.addEventListener("keydown", onDown); window.addEventListener("keyup", onUp); window.addEventListener("blur", onBlur);
    return () => { clearInterval(keepAlive); window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); window.removeEventListener("blur", onBlur); };
  }, []);
}

function Header() {
  const roomCode = useGame((s) => s.roomCode);
  const players = useGame((s) => s.players);
  const npcCount = useGame((s) => Object.keys(s.npcs).length);
  const ps = useGame((s) => s.providerStatus);
  const mode = useGame((s) => s.mode);
  const conn = useGame((s) => s.conn);
  const session = useGame((s) => s.session);
  const viewMode = useGame((s) => s.viewMode);
  const online = Object.values(players).filter((p) => p.connected && !p.isBot).length;
  const badge = ps?.badge ?? (mode === "scripted" ? "SCRIPTED" : "CONNECTING");
  const pending = ps?.pending ?? 0;
  const cls = /LIVE/.test(badge) ? (badge.startsWith("META") ? "badge meta" : "badge live") : /FALLBACK|DOWN/.test(badge) ? "badge warn" : "badge scripted";
  return (
    <header className="hdr">
      <div className="brand"><span className="brand-a">VICE</span><span className="brand-b">EXCHANGE</span></div>
      <div className="hdr-item">ROOM <b>{roomCode || "—"}</b></div>
      <div className="hdr-item"><b>{online}</b> player{online === 1 ? "" : "s"}</div>
      <div className="hdr-item"><b>{npcCount}</b> agents</div>
      <div className={cls} title="Which engine is making NPC decisions right now">{badge}</div>
      {pending > 0 && <div className="badge pending">PENDING {pending}</div>}
      <div className="hdr-item dim">mode <b>{mode.toUpperCase()}</b></div>
      <div className="spacer" />
      {conn !== "connected" && <div className="badge warn">{conn.toUpperCase()}</div>}
      <div className="seg" role="group" aria-label="City renderer">
        <button className={viewMode === "2d" ? "on" : ""} onClick={() => useGame.setState({ viewMode: "2d" })}>2D</button>
        <button className={viewMode === "3d" ? "on" : ""} disabled={!has3D} title={has3D ? "3D city" : "3D view is not available in this build"} onClick={() => useGame.setState({ viewMode: "3d" })}>3D</button>
      </div>
      <div className="hdr-item">{session?.nickname} · <b>{session?.role}</b>{session?.isDirector ? " · DIRECTOR" : ""}</div>
      <button className="ghost" onClick={leaveRoom}>Leave</button>
    </header>
  );
}

function CityHost() {
  const map = useGame((s) => s.map);
  const characters = useGame((s) => s.characters);
  const npcs = useGame((s) => s.npcs);
  const missions = useGame((s) => s.missions);
  const listings = useGame((s) => s.listings);
  const tick = useGame((s) => s.lastTick);
  const events = useGame((s) => s.events);
  const selectedId = useGame((s) => s.selectedAgentId);
  const viewMode = useGame((s) => s.viewMode);
  const me = useMyCharacter();
  const chars = useMemo(() => Object.values(characters), [characters]);
  const npcList = useMemo(() => Object.values(npcs), [npcs]);
  const missionList = useMemo(() => Object.values(missions), [missions]);
  const listingList = useMemo(() => Object.values(listings), [listings]);
  return (
    <CityView renderer={viewMode} map={map} characters={chars} npcs={npcList} missions={missionList} listings={listingList}
      tick={tick} events={events} youCharacterId={me?.id ?? null} selectedId={selectedId}
      onSelect={(id, kind) => { if (kind === "npc" || id === null) useGame.getState().selectAgent(id); }} />
  );
}

function Hud() {
  const me = useMyCharacter();
  const listing = useGame((s) => (me?.ticker ? s.listings[me.ticker] ?? null : null));
  const session = useGame((s) => s.session);
  if (!session) return null;
  if (session.role === "SPECTATOR") return <div className="hud"><span className="hud-chip">SPECTATOR — click any NPC to inspect what it knows</span></div>;
  if (!me) return null;
  const live = isLive(me);
  return (
    <div className="hud">
      {me.ticker && <span className="hud-chip strong">{me.ticker} {listing ? vd(listing.spotPrice) : ""}</span>}
      <span className={`hud-chip ${me.wanted ? "bad" : ""}`}>{me.wanted ? "WANTED" : "HEAT"} {me.wantedLevel}/5
        <span className="heatbar" aria-hidden><i style={{ width: `${Math.min(100, me.heat)}%` }} /></span>
      </span>
      {me.role === "OUTLAW" && <span className="hud-chip">jobs {me.completedMissions} · notoriety {me.notorietyPoints} · escapes {me.successfulEscapes}</span>}
      {listing && live && <span className="hud-chip">bounty on you {vd(listing.currentBounty)}</span>}
      <span className="hud-chip dim">{live ? (me.role === "HUNTER" ? "WASD move · E capture a WANTED target within 2.5 m" : "WASD move · E do the job at the marker") : "CAPTURED — press R to respawn"}</span>
    </div>
  );
}

function CrashOverlay() {
  const crash = useGame((s) => s.crash);
  useEffect(() => {
    if (!crash) return;
    const t = setTimeout(() => useGame.setState({ crash: null }), 5200);
    return () => clearTimeout(t);
  }, [crash]);
  if (!crash) return null;
  return (
    <div className="crash" role="alert" onClick={() => useGame.setState({ crash: null })}>
      <div className="crash-ticker">{crash.ticker}</div>
      <div className="crash-line">CAPTURED · LISTING HALTED</div>
      <div className="crash-price"><s>{vd(crash.from)}</s> → <b>V$0</b></div>
      <div className="crash-sub">Every share of {crash.nickname || crash.ticker} is now worth nothing. History is kept.</div>
    </div>
  );
}

function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>;
}

export function App() {
  const session = useGame((s) => s.session);
  const [tab, setTab] = useState<"timeline" | "swarm" | "director">("timeline");
  const [expanded, setExpanded] = useState(false);
  const running = useGame((s) => s.experiments.some((x) => x.status === "RUNNING"));
  useEffect(() => { if (running) { setTab("director"); setExpanded(true); } }, [running]);
  useControls();
  if (!session) return <JoinRoom />;
  return (
    <div className="app">
      <Header />
      <TickerTape />
      <main className={`grid ${expanded ? "xl" : tab !== "timeline" ? "tall" : ""}`}>
        <section className="city">
          <CityHost />
          <DecisionSpotlight dock="top-right" />
          <Hud />
        </section>
        <aside className="side">
          <MarketPanel />
          <AgentInspector />
        </aside>
        <section className="bottom">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "timeline"} className={tab === "timeline" ? "on" : ""} onClick={() => setTab("timeline")}>EVENT TIMELINE</button>
            <button role="tab" aria-selected={tab === "swarm"} className={tab === "swarm" ? "on" : ""} onClick={() => setTab("swarm")}>SWARM GRAPH</button>
            <button role="tab" aria-selected={tab === "director"} className={tab === "director" ? "on" : ""} onClick={() => setTab("director")}>DEMO DIRECTOR · METRICS</button>
            <span className="notice">{CREDITS_NOTICE}</span>
            <button className="ghost small" aria-pressed={expanded} title="Make this panel taller or shorter" onClick={() => setExpanded((v) => !v)}>{expanded ? "▼ smaller" : "▲ larger"}</button>
          </div>
          {tab === "timeline" ? <EventTimeline /> : tab === "swarm" ? <div className="swarm-host"><SwarmGraph /></div> : <DemoDirector />}
        </section>
      </main>
      <Toasts />
      <CrashCinematic />
    </div>
  );
}
