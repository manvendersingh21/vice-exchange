// World bridge: a plain-WebSocket door for external 3D world clients (the Godot city).
// OWNER: GODOT. It is a second transport onto the SAME authoritative command path as Socket.IO:
// every message is validated with clientCommandSchema and dispatched through RoomEngine.dispatch,
// so a bridge client can do nothing a browser client cannot. It never mutates room state itself.
//
// Wire protocol (JSON text frames)
//   client -> server  { t: "cmd", n: <number>, cmd: <ClientCommand> }
//   server -> client  { t: "ack", n, ack: CommandAck }            (room.join/create acks carry a slim JoinResult, no snapshot)
//                     { t: "tick", tick, serverTimeMs, characters[], npcs[] }   10 Hz
//                     { t: "state", ... }                           2 Hz and right after join / mutating commands
//                     { t: "event", e: GameEvent }                  every authoritative event, in order
//                     { t: "bye", reason }
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { clientCommandSchema } from "@vice/contracts";
import type { CommandAck, GameEvent, JoinResult, RoomSnapshot, WalletView } from "@vice/contracts";
import type { Room, RoomManager } from "../rooms/RoomManager";

export const BRIDGE_PATH = "/bridge";
const TICK_MS = 100;
const STATE_EVERY_TICKS = 5;
const RATE = { perSecond: 60, burst: 120 };
const MAX_FRAME_BYTES = 8 * 1024;

interface Session {
  id: number;
  ws: WebSocket;
  roomCode: string | null;
  sessionToken: string | null;
  playerId: string | null;
  offEvent: (() => void) | null;
  tokens: number;
  last: number;
  ticks: number;
}

export interface WorldBridge {
  /** Number of connected bridge clients (for /health and the dashboard). */
  clients(): number;
  close(): void;
}

/** Slim, renderer-oriented view of the room for one bridge player. */
export function bridgeState(snap: RoomSnapshot, you: { playerId: string | null; wallet: WalletView | null }) {
  const me = snap.players.find((p) => p.id === you.playerId) ?? null;
  return {
    t: "state" as const,
    roomCode: snap.roomCode, runId: snap.runId, mode: snap.mode, badge: snap.providerStatus.badge,
    serverTimeMs: snap.serverTimeMs, map: { name: snap.map.name, width: snap.map.width, height: snap.map.height },
    you: me ? { playerId: me.id, characterId: me.characterId, role: me.role, nickname: me.nickname } : null,
    wallet: you.wallet,
    players: snap.players,
    characters: snap.characters,
    npcs: snap.npcs.map((n) => ({
      id: n.id, name: n.name, role: n.role, x: n.x, z: n.z, activity: n.activity,
      targetCharacterId: n.targetCharacterId, pending: n.pendingDecisionId !== null,
      lastAction: n.lastDecision?.chosenAction ?? null, lastSource: n.lastDecision?.decisionSource ?? null,
    })),
    missions: snap.missions,
    listings: snap.listings.map((l) => ({
      ticker: l.ticker, characterId: l.characterId, nickname: l.nickname, status: l.status,
      spotPrice: l.spotPrice, referenceValue: l.referenceValue, bid: l.bid, ask: l.ask, currentBounty: l.currentBounty,
    })),
  };
}

export function attachWorldBridge(httpServer: HttpServer, rooms: RoomManager): WorldBridge {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sessions = new Map<WebSocket, Session>();
  let nextId = 1;

  const send = (s: Session, msg: unknown): void => {
    if (s.ws.readyState !== s.ws.OPEN) return;
    try { s.ws.send(JSON.stringify(msg)); } catch { /* socket is going away */ }
  };
  const roomOf = (s: Session): Room | undefined => (s.roomCode ? rooms.get(s.roomCode) : undefined);
  /** Player ids change on demo.reset; the opaque session token does not. */
  const playerOf = (s: Session, room: Room) => {
    const players = room.engine.state.players;
    const direct = s.playerId ? players[s.playerId] : undefined;
    if (direct && direct.sessionToken === s.sessionToken) return direct;
    const found = Object.values(players).find((p) => p.sessionToken === s.sessionToken);
    if (found) s.playerId = found.id;
    return found;
  };
  const sendState = (s: Session): void => {
    const room = roomOf(s); if (!room) return;
    const p = playerOf(s, room);
    send(s, bridgeState(room.engine.snapshot(), { playerId: p?.id ?? null, wallet: room.engine.walletView(p?.walletId ?? null) }));
  };
  const leave = (s: Session): void => {
    s.offEvent?.(); s.offEvent = null;
    const room = roomOf(s);
    if (room) {
      const p = playerOf(s, room);
      // Only mark the player gone if this bridge socket still owns the session.
      if (p && p.socketId === `bridge:${s.id}`) room.engine.disconnect(p.id);
    }
    s.roomCode = null; s.playerId = null; s.sessionToken = null;
  };

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = "";
    try { pathname = new URL(req.url ?? "", "http://localhost").pathname; } catch { return; }
    if (pathname !== BRIDGE_PATH) return; // not ours: Socket.IO (or nothing) handles it
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }
  httpServer.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const s: Session = { id: nextId++, ws, roomCode: null, sessionToken: null, playerId: null, offEvent: null, tokens: RATE.burst, last: Date.now(), ticks: 0 };
    sessions.set(ws, s);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: { t?: unknown; n?: unknown; cmd?: unknown };
      try { msg = JSON.parse(String(data)) as typeof msg; } catch { return send(s, { t: "ack", n: null, ack: { ok: false, id: "", error: { code: "INVALID_COMMAND", message: "Not JSON" } } }); }
      const n = typeof msg.n === "number" ? msg.n : null;
      const reply = (ack: CommandAck): void => send(s, { t: "ack", n, ack });
      const raw = msg.cmd;
      const rawId = raw && typeof raw === "object" ? ((raw as Record<string, unknown>).commandId ?? (raw as Record<string, unknown>).requestId) : "";
      const id = typeof rawId === "string" ? rawId.slice(0, 64) : "";
      if (msg.t !== "cmd") return reply({ ok: false, id, error: { code: "INVALID_COMMAND", message: "Expected { t: 'cmd', n, cmd }" } });

      const now = Date.now();
      s.tokens = Math.min(RATE.burst, s.tokens + ((now - s.last) / 1000) * RATE.perSecond); s.last = now;
      if (s.tokens < 1) return reply({ ok: false, id, error: { code: "RATE_LIMITED", message: "Too many commands" } });
      s.tokens -= 1;

      const parsed = clientCommandSchema.safeParse(raw);
      if (!parsed.success) return reply({ ok: false, id, error: { code: "INVALID_COMMAND", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) } });
      const cmd = parsed.data;
      try {
        if (cmd.type === "room.create" || cmd.type === "room.join") {
          leave(s);
          const r = rooms.join(cmd, `bridge:${s.id}`);
          if (!r.ok || !r.room || !r.playerId) return reply({ ok: false, id: r.id, error: r.error });
          const room = r.room;
          const full = rooms.result(room, r.playerId);
          s.roomCode = room.code; s.playerId = r.playerId; s.sessionToken = full.sessionToken;
          s.offEvent = room.engine.onEvent((e: GameEvent) => send(s, { t: "event", e }));
          // The full snapshot is large and browser-oriented; bridge clients get the slim state instead.
          const { snapshot: _omit, ...slim } = full as JoinResult;
          reply({ ok: true, id: r.id, result: slim });
          sendState(s);
          return;
        }
        const room = roomOf(s);
        const p = room ? playerOf(s, room) : undefined;
        if (!room || !p) return reply({ ok: false, id, error: { code: "NOT_JOINED", message: "Join a room first" } });
        reply(room.engine.dispatch(p.id, cmd));
        if (cmd.type !== "player.move" && cmd.type !== "player.pose") sendState(s);
      } catch (err) {
        console.error("[bridge] command failed", cmd.type, err);
        reply({ ok: false, id, error: { code: "INTERNAL", message: "Server error" } });
      }
    });
    ws.on("close", () => { leave(s); sessions.delete(ws); });
    ws.on("error", () => { /* close follows */ });
  });

  const timer = setInterval(() => {
    for (const s of sessions.values()) {
      const room = roomOf(s); if (!room) continue;
      try {
        send(s, { t: "tick", ...room.engine.worldTick() });
        if (++s.ticks % STATE_EVERY_TICKS === 0) sendState(s);
      } catch (err) { console.error("[bridge] tick failed", err); }
    }
  }, TICK_MS);
  timer.unref?.();

  return {
    clients: () => sessions.size,
    close: () => {
      clearInterval(timer);
      httpServer.off("upgrade", onUpgrade);
      for (const s of sessions.values()) { send(s, { t: "bye", reason: "server closing" }); leave(s); try { s.ws.close(); } catch { /* already closed */ } }
      sessions.clear(); wss.close();
    },
  };
}
