// Room entry rules: director rights, session-token re-attach, nickname reclaim, unique nicknames, capacity.
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ROOM_CODE, RULES } from "@vice/contracts";
import type { HumanRole } from "@vice/contracts";
import { createRoomFactory } from "../src/engine/compose";
import { createMemoryPersistence } from "../src/engine/fallbacks";
import { FakeClock } from "../src/engine/util";
import { EMPTY_ROOM_TTL_MS, MAX_ROOMS, RoomManager } from "../src/rooms/RoomManager";
import { isLocal } from "../src/transport/socket";

const managers: RoomManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.stop(); });

function setup(directorSecret = "") {
  const clock = new FakeClock();
  const build = createRoomFactory({ persistence: createMemoryPersistence(), clock, providers: { naceApiKey: "", naceModel: "", metaApiKey: "", metaBaseUrl: "", metaModel: "", concurrency: 2, maxCallsPerMinute: 60 } });
  const rooms = new RoomManager(build, { directorSecret, defaultMode: "scripted", tickHz: 10 });
  managers.push(rooms);
  const room = rooms.ensureDefault();
  let n = 0;
  const join = (nickname: string, role: HumanRole = "OUTLAW", extra: { sessionToken?: string; directorSecret?: string; socketId?: string; local?: boolean } = {}) => {
    const { socketId, local, ...rest } = extra;
    const r = rooms.join({ type: "room.join", roomCode: DEFAULT_ROOM_CODE, nickname, role, requestId: `req-${++n}`, ...rest }, socketId ?? `sock-${n}`, local ?? true);
    if (!r.ok || !r.result) throw new Error(`join failed: ${r.error?.code}`);
    return r.result;
  };
  return { rooms, room, clock, join };
}

describe("director rights", () => {
  it("the default room's first browser joiner directs it; later joiners and the room code alone do not", () => {
    const { join } = setup();
    expect(join("Ace").isDirector).toBe(true);
    expect(join("Bo", "HUNTER").isDirector).toBe(false);
    expect(join("Judge", "SPECTATOR").isDirector).toBe(false);
  });
  it("an external world-bridge client never takes the director slot", () => {
    const { join } = setup();
    expect(join("Godot", "OUTLAW", { socketId: "bridge:1" }).isDirector).toBe(false);
    expect(join("Ace").isDirector).toBe(true);
  });
  it("the configured director secret grants rights; a wrong one does not", () => {
    const { join } = setup("s3cret-director-token");
    expect(join("Ace").isDirector).toBe(true); // first joiner
    expect(join("Mallory", "HUNTER", { directorSecret: "nope" }).isDirector).toBe(false);
    expect(join("Judge", "SPECTATOR", { directorSecret: "s3cret-director-token" }).isDirector).toBe(true);
  });
  it("room.create makes a private room directed by its creator", () => {
    const { rooms } = setup();
    const made = rooms.join({ type: "room.create", nickname: "Ace", role: "OUTLAW", requestId: "c1" }, "sock-a");
    expect(made.ok).toBe(true);
    const code = made.result!.roomCode;
    expect(code).not.toBe(DEFAULT_ROOM_CODE);
    expect(made.result!.isDirector).toBe(true);
    const second = rooms.join({ type: "room.join", roomCode: code.toLowerCase(), nickname: "Bo", role: "HUNTER", requestId: "c2" }, "sock-b");
    expect(second.ok).toBe(true);
    expect(second.result!.isDirector).toBe(false);
    expect(second.result!.snapshot.players.map((p) => p.nickname).sort()).toEqual(["Ace", "Bo"]);
    expect(rooms.join({ type: "room.join", roomCode: "NOPE-1", nickname: "Bo", role: "HUNTER", requestId: "c3" }, "sock-c").error?.code).toBe("ROOM_NOT_FOUND");
  });
});

describe("coming back", () => {
  it("the same session token re-attaches to the same player and character, even after the grace window", () => {
    const { join, room, clock } = setup();
    const a = join("Ace");
    room.engine.disconnect(a.playerId);
    clock.advance(RULES.reconnectGraceMs * 4);
    const back = join("Whatever", "HUNTER", { sessionToken: a.sessionToken }); // the token, not the form fields, identifies the player
    expect(back).toMatchObject({ playerId: a.playerId, characterId: a.characterId, role: "OUTLAW", isDirector: true, sessionToken: a.sessionToken });
    expect(Object.keys(room.engine.state.characters)).toHaveLength(1);
    expect(room.engine.state.players[a.playerId]!.connected).toBe(true);
  });

  it("a disconnected player's nickname and role reclaim the same character and ticker with a new token, without director rights", () => {
    const { join, room } = setup();
    const a = join("Ace");
    const ticker = room.engine.state.characters[a.characterId!]!.ticker;
    room.engine.disconnect(a.playerId);
    const back = join("ace"); // no token: a fresh browser
    expect(back.playerId).toBe(a.playerId);
    expect(back.characterId).toBe(a.characterId);
    expect(room.engine.state.characters[back.characterId!]!.ticker).toBe(ticker);
    expect(back.sessionToken).not.toBe(a.sessionToken);
    expect(back.isDirector).toBe(false); // the original was director, but a nickname is not a credential
    expect(Object.keys(room.engine.state.characters)).toHaveLength(1);
    expect(Object.keys(room.engine.state.listings)).toEqual([ticker]);
    // The old token is dead.
    room.engine.disconnect(back.playerId);
    expect(join("Ace", "OUTLAW", { sessionToken: a.sessionToken }).sessionToken).not.toBe(a.sessionToken);
  });

  it("a reclaim keeps director rights only with the director secret", () => {
    const { join, room } = setup("s3cret-director-token");
    const a = join("Ace");
    room.engine.disconnect(a.playerId);
    expect(join("Ace", "OUTLAW", { directorSecret: "s3cret-director-token" })).toMatchObject({ playerId: a.playerId, isDirector: true });
  });

  it("a connected player's nickname cannot be taken: the newcomer is suffixed and gets its own character", () => {
    const { join, room } = setup();
    const a = join("Ace"); const b = join("Ace"); const c = join("ACE");
    expect(new Set([a.playerId, b.playerId, c.playerId]).size).toBe(3);
    expect(room.engine.state.players[b.playerId]!.nickname).toBe("Ace2");
    expect(room.engine.state.players[c.playerId]!.nickname).toBe("ACE3");
    expect(Object.values(room.engine.state.characters).map((x) => x.ticker).sort()).toEqual(["ACE-01", "ACE-02", "ACE-03"]);
    expect(b.isDirector).toBe(false);
  });

  it("a different role is a different player, not a reclaim", () => {
    const { join, room } = setup();
    const a = join("Ace", "OUTLAW");
    room.engine.disconnect(a.playerId);
    const h = join("Ace", "HUNTER");
    expect(h.playerId).not.toBe(a.playerId);
    expect(room.engine.state.players[h.playerId]!.nickname).toBe("Ace2");
  });

  it("refuses a ninth connected human, and frees the seat when one leaves", () => {
    const { join, rooms, room } = setup();
    const first = join("P1");
    for (let i = 2; i <= RULES.maxPlayersPerRoom; i++) join(`P${i}`, i % 2 ? "OUTLAW" : "HUNTER");
    const full = rooms.join({ type: "room.join", roomCode: DEFAULT_ROOM_CODE, nickname: "Late", role: "SPECTATOR", requestId: "late-1" }, "sock-late");
    expect(full.ok).toBe(false); expect(full.error?.code).toBe("ROOM_FULL");
    room.engine.disconnect(first.playerId);
    expect(join("Late", "SPECTATOR").playerId).toBeTruthy();
  });
});

describe("stored history across server restarts (NFR-005)", () => {
  it("a restarted server's VICE-42 never collides with the earlier one in the same database", async () => {
    const { createPersistence } = await import("../src/persistence");
    const { verifyReplay } = await import("../src/replay");
    const store = createPersistence(":memory:"); // one database shared by two "boots"
    const boot = () => {
      const clock = new FakeClock();
      const build = createRoomFactory({ persistence: store, clock, providers: { naceApiKey: "", naceModel: "", metaApiKey: "", metaBaseUrl: "", metaModel: "", concurrency: 2, maxCallsPerMinute: 60 } });
      const rooms = new RoomManager(build, { directorSecret: "", defaultMode: "scripted", tickHz: 10 });
      managers.push(rooms);
      return rooms.ensureDefault();
    };
    const first = boot();
    const p1 = first.engine.addPlayer({ nickname: "Ace", role: "OUTLAW", sessionToken: "t1" });
    expect(first.engine.dispatch(p1.id, { type: "market.buy", ticker: "ACE-01", qty: 1, commandId: "boot1-buy-0001" }).ok).toBe(true);

    const second = boot(); // same code, same run id, same sequence numbers as the first boot
    expect(second.code).toBe(first.code);
    expect(second.engine.state.id).not.toBe(first.engine.state.id);
    const p2 = second.engine.addPlayer({ nickname: "Zed", role: "OUTLAW", sessionToken: "t2" });
    expect(second.engine.state.runId).toBe(first.engine.state.runId);

    for (const room of [first, second]) {
      const stored = store.loadEvents(room.engine.state.id, room.engine.state.runId);
      expect(stored.map((e) => e.eventId)).toEqual(room.engine.events.map((e) => e.eventId)); // nothing dropped, nothing mixed
      expect(verifyReplay(stored, room.engine.state)).toMatchObject({ ok: true, mismatches: [] });
    }
    expect(store.loadEvents(second.engine.state.id, second.engine.state.runId).some((e) => e.type === "TRADE_EXECUTED")).toBe(false);
    expect(store.findRoomId(DEFAULT_ROOM_CODE)).toBeTruthy();
    expect(p2.id).toBe(p1.id); // per-room ids repeat across boots, which is exactly why the room id must not
    store.close();
  });
});

describe("audit fixes", () => {
  it("a LAN visitor who joins the default room first does not become director; the machine's own browser still does", () => {
    const { join } = setup();
    expect(join("Visitor", "OUTLAW", { local: false }).isDirector).toBe(false);
    expect(join("Host", "HUNTER", { local: true }).isDirector).toBe(true);
    expect(join("Later", "SPECTATOR", { local: true }).isDirector).toBe(false);
  });
  it("a LAN visitor still directs with the secret", () => {
    const { join } = setup("s3cret-director-token");
    expect(join("Visitor", "OUTLAW", { local: false, directorSecret: "s3cret-director-token" }).isDirector).toBe(true);
  });
  it("recognises only this machine's own browser as local", () => {
    const sock = (address: string, headers: Record<string, string> = {}) => ({ handshake: { address, headers } });
    expect(isLocal(sock("127.0.0.1"))).toBe(true);
    expect(isLocal(sock("::ffff:127.0.0.1", { origin: "http://localhost:5173" }))).toBe(true);
    expect(isLocal(sock("192.168.1.20"))).toBe(false);
    expect(isLocal(sock("127.0.0.1", { origin: "http://192.168.1.20:5173" }))).toBe(false); // LAN page through the dev proxy
    expect(isLocal(sock("127.0.0.1", { "x-forwarded-for": "192.168.1.20" }))).toBe(false);
  });
  it("refuses room.create beyond the cap, promptly, and never hangs however many are requested", () => {
    const { rooms } = setup();
    const create = (i: number) => rooms.join({ type: "room.create", nickname: `P${i}`, role: "SPECTATOR", requestId: `mk-${i}` }, `sock-mk-${i}`);
    const started = Date.now();
    const results = Array.from({ length: 200 }, (_, i) => create(i));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_ROOMS - 1); // the default room takes one place
    expect(results[MAX_ROOMS - 1]!.error).toEqual({ code: "ROOM_FULL", message: "Too many rooms" });
    expect(rooms.rooms.size).toBe(MAX_ROOMS);
  });
  it("closes created rooms left empty, never the default room, and frees their place", () => {
    const { rooms } = setup();
    const made = rooms.join({ type: "room.create", nickname: "Ace", role: "OUTLAW", requestId: "mk-a" }, "sock-a");
    const room = made.room!; const code = room.code;
    rooms.sweep(1_000);
    expect(rooms.get(code)).toBeTruthy(); // occupied
    room.engine.disconnect(made.playerId!);
    rooms.sweep(2_000);
    rooms.sweep(2_000 + EMPTY_ROOM_TTL_MS - 1);
    expect(rooms.get(code)).toBeTruthy();
    rooms.sweep(2_000 + EMPTY_ROOM_TTL_MS);
    expect(rooms.get(code)).toBeUndefined();
    expect(room.timer).toBeNull();
    rooms.sweep(10 * EMPTY_ROOM_TTL_MS);
    expect(rooms.get(DEFAULT_ROOM_CODE)).toBeTruthy();
    expect(rooms.join({ type: "room.join", roomCode: code, nickname: "Ace", role: "OUTLAW", requestId: "mk-b" }, "sock-b").error?.code).toBe("ROOM_NOT_FOUND");
  });
  it("a room creator from elsewhere cannot start an experiment; the server's own machine or the secret can", () => {
    const { rooms } = setup("s3cret-director-token");
    const make = (i: number, local: boolean, directorSecret?: string) => {
      const r = rooms.join({ type: "room.create", nickname: `D${i}`, role: "SPECTATOR", requestId: `ex-${i}`, directorSecret }, `sock-ex-${i}`, local);
      expect(r.result!.isDirector).toBe(true);
      return r.room!.engine.dispatch(r.playerId!, { type: "demo.runExperiment", commandId: `exp-cmd-000${i}` });
    };
    expect(make(1, false).error).toMatchObject({ code: "FORBIDDEN" });
    // No runner is attached in this unit setup, so an allowed request gets past the gate and reports that instead.
    expect(make(2, true).error?.code).toBe("INTERNAL");
    expect(make(3, false, "s3cret-director-token").error?.code).toBe("INTERNAL");
  });
});
