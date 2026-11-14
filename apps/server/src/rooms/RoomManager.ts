import { randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_ROOM_CODE, DEFAULT_SEED, RULES } from "@vice/contracts";
import type { ClientCommand, CommandAck, DecisionMode, JoinResult } from "@vice/contracts";
import type { BuiltRoom, RoomBuildOpts } from "../engine/compose";
import type { RoomEngine } from "../engine/RoomEngine";
import type { PlayerState } from "../domain";

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

  /** Nicknames are unique per room: a taken name gets the smallest free numeric suffix (Ace -> Ace2). */
  private uniqueNickname(want: string, players: PlayerState[]): string {
    const taken = new Set(players.map((p) => p.nickname.toLowerCase()));
    if (!taken.has(want.toLowerCase())) return want;
    for (let n = 2; n < 1000; n++) {
      const suffix = String(n); const candidate = want.slice(0, 16 - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return want;
  }

  /**
   * Handles room.create / room.join. Three ways in, in this order:
   *  1. the same opaque session token re-attaches to the same player (refresh, network blip), director flag kept;
   *  2. the nickname + role of a DISCONNECTED player reclaims that player, its character and its ticker with a new
   *     token. A reclaim never carries director rights by itself: only the director secret does;
   *  3. otherwise a fresh player (a taken nickname is suffixed).
   * A room code alone never grants director rights.
   */
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
    const humans = Object.values(engine.state.players).filter((p) => !p.isBot);
    const secret = this.secretOk(cmd.directorSecret);
    const done = (playerId: string) => ({ ok: true as const, id, room, playerId, result: this.result(room!, playerId) });

    if (cmd.type === "room.join") {
      const byToken = cmd.sessionToken ? humans.find((p) => p.sessionToken === cmd.sessionToken) : undefined;
      if (byToken) {
        engine.reattach(byToken.id, socketId, { isDirector: byToken.isDirector || secret });
        return done(byToken.id);
      }
      const name = cmd.nickname.toLowerCase();
      const claim = humans.find((p) => !p.connected && p.role === cmd.role && p.nickname.toLowerCase() === name);
      if (claim) {
        engine.reattach(claim.id, socketId, { sessionToken: randomBytes(24).toString("hex"), isDirector: secret });
        return done(claim.id);
      }
    }
    if (humans.filter((p) => p.connected).length >= RULES.maxPlayersPerRoom) return { ok: false, id, error: { code: "ROOM_FULL", message: "Room is full" } };
    // The creator directs their room. The boot-time default room has no creator, so its first browser joiner directs it
    // (external world-bridge clients never take that slot). The slot is not handed out again once taken.
    const isDirector = creator || secret || (!room.hasDirector && room.code === DEFAULT_ROOM_CODE && !socketId.startsWith("bridge:"));
    if (isDirector) room.hasDirector = true;
    const p = engine.addPlayer({ nickname: this.uniqueNickname(cmd.nickname, humans), role: cmd.role, isDirector, sessionToken: randomBytes(24).toString("hex"), socketId });
    return done(p.id);
  }

  result(room: Room, playerId: string): JoinResult {
    const e: RoomEngine = room.engine; const p = e.state.players[playerId]!;
    return { roomCode: room.code, playerId: p.id, sessionToken: p.sessionToken, role: p.role, characterId: p.characterId, walletId: p.walletId, isDirector: p.isDirector, snapshot: e.snapshot(), wallet: e.walletView(p.walletId) };
  }
  stop(): void { for (const r of this.rooms.values()) if (r.timer) clearInterval(r.timer); }
}
