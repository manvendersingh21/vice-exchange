import { randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_ROOM_CODE, DEFAULT_SEED, RULES } from "@vice/contracts";
import type { ClientCommand, CommandAck, DecisionMode, JoinResult } from "@vice/contracts";
import type { BuiltRoom, RoomBuildOpts } from "../engine/compose";
import type { RoomEngine } from "../engine/RoomEngine";

export interface Room extends BuiltRoom { code: string; timer: NodeJS.Timeout | null; hasDirector: boolean }
type JoinCmd = Extract<ClientCommand, { type: "room.create" | "room.join" }>;

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private n = 0;
  constructor(private build: (o: RoomBuildOpts) => BuiltRoom, private opts: { directorSecret: string; defaultMode: DecisionMode; tickHz: number }) {}
  onTick?: (room: Room) => void;

  create(code: string, seed: number, mode: DecisionMode = this.opts.defaultMode): Room {
    const built = this.build({ roomId: code, code, seed, mode });
    const room: Room = { ...built, code, timer: null, hasDirector: false };
    room.timer = setInterval(() => {
      try { room.engine.tick(); this.onTick?.(room); } catch (err) { console.error("[room] tick failed", code, err); }
    }, Math.round(1000 / this.opts.tickHz));
    this.rooms.set(code, room);
    return room;
  }
  ensureDefault(): Room { return this.rooms.get(DEFAULT_ROOM_CODE) ?? this.create(DEFAULT_ROOM_CODE, DEFAULT_SEED); }
  get(code: string): Room | undefined { return this.rooms.get(code.toUpperCase()); }

  private secretOk(given: string | undefined): boolean {
    const want = this.opts.directorSecret;
    if (!want || !given || given.length !== want.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(want));
  }

  /** Handles room.create / room.join. Room code alone never grants director rights. */
  join(cmd: JoinCmd, socketId: string): CommandAck<JoinResult> & { room?: Room; playerId?: string } {
    const id = cmd.requestId;
    let room: Room | undefined; let creator = false;
    if (cmd.type === "room.create") {
      let code: string;
      do { code = `VICE-${10 + ((this.n++ * 37 + Math.floor(Math.random() * 90)) % 90)}`; } while (this.rooms.has(code));
      room = this.create(code, cmd.seed ?? DEFAULT_SEED); creator = true;
    } else {
      room = this.get(cmd.roomCode);
      if (!room) return { ok: false, id, error: { code: "ROOM_NOT_FOUND", message: `No room ${cmd.roomCode}` } };
    }
    const engine = room.engine;
    const players = Object.values(engine.state.players);
    const now = engine.now();
    // Reconnect: same opaque session token, inside the grace window (or still connected from another tab).
    const prior = cmd.type === "room.join" && cmd.sessionToken ? players.find((p) => p.sessionToken === cmd.sessionToken) : undefined;
    if (prior && (prior.connected || now - (prior.disconnectedAtMs ?? now) <= RULES.reconnectGraceMs)) {
      engine.reconnect(prior.id, socketId);
      return { ok: true, id, room, playerId: prior.id, result: this.result(room, prior.id) };
    }
    if (players.filter((p) => p.connected && !p.isBot).length >= RULES.maxPlayersPerRoom) return { ok: false, id, error: { code: "ROOM_FULL", message: "Room is full" } };
    // The creator directs their room. The boot-time default room has no creator, so its first human joiner directs it.
    const isDirector = creator || this.secretOk(cmd.directorSecret) || (!room.hasDirector && room.code === DEFAULT_ROOM_CODE);
    if (isDirector) room.hasDirector = true;
    const p = engine.addPlayer({ nickname: cmd.nickname, role: cmd.role, isDirector, sessionToken: randomBytes(24).toString("hex"), socketId });
    return { ok: true, id, room, playerId: p.id, result: this.result(room, p.id) };
  }

  result(room: Room, playerId: string): JoinResult {
    const e: RoomEngine = room.engine; const p = e.state.players[playerId]!;
    return { roomCode: room.code, playerId: p.id, sessionToken: p.sessionToken, role: p.role, characterId: p.characterId, walletId: p.walletId, isDirector: p.isDirector, snapshot: e.snapshot(), wallet: e.walletView(p.walletId) };
  }
  stop(): void { for (const r of this.rooms.values()) if (r.timer) clearInterval(r.timer); }
}
