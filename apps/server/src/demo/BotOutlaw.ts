import { MISSION_SPOTS, dist } from "@vice/contracts";
import type { Vec2 } from "@vice/contracts";
import type { RoomEngine } from "../engine/RoomEngine";

/** Road waypoints from the first outlaw spawn to the dock mission, then a fixed loop through the city. */
const APPROACH: Vec2[] = [{ x: 60, z: 72 }, { x: MISSION_SPOTS[0]!.x, z: 72 }, { x: MISSION_SPOTS[0]!.x, z: MISSION_SPOTS[0]!.z }];
const LOOP: Vec2[] = [{ x: 47, z: 54 }, { x: 62, z: 54 }, { x: 62, z: 28 }, { x: 32, z: 28 }, { x: 32, z: 54 }];

/** Scripted human stand-in. It issues exactly the commands a browser would (player.move, mission.interact). */
export class BotOutlaw {
  readonly playerId: string;
  private path = [...APPROACH]; private n = 0; private didMission = false;
  constructor(private engine: RoomEngine, nickname = "Ace") {
    this.playerId = engine.addPlayer({ nickname, role: "OUTLAW", isBot: true, sessionToken: `bot_${engine.opts.roomId}` }).id;
  }
  /** Call once per engine tick, before engine.tick(). */
  step(): void {
    const e = this.engine; const p = e.state.players[this.playerId]; const c = p?.characterId ? e.state.characters[p.characterId] : undefined;
    if (!p || !c || (c.status !== "ACTIVE" && c.status !== "WANTED")) return;
    if (!this.didMission) {
      const m = Object.values(e.state.missions).find((x) => x.status === "AVAILABLE");
      if (m && dist(c, m) <= 2) {
        this.didMission = true;
        e.dispatch(this.playerId, { type: "mission.interact", missionId: m.id, commandId: `bot-mission-${++this.n}` });
        this.path = [...LOOP];
      }
    }
    let to = this.path[0];
    if (to && dist(c, to) < 1) { this.path.shift(); if (this.didMission) this.path.push(to); to = this.path[0]; }
    if (!to) { e.dispatch(this.playerId, { type: "player.move", dirX: 0, dirZ: 0 }); return; }
    const d = dist(c, to) || 1;
    // Walks at 40% speed so police can realistically catch up: the same handicap in every mode.
    e.dispatch(this.playerId, { type: "player.move", dirX: ((to.x - c.x) / d) * 0.4, dirZ: ((to.z - c.z) / d) * 0.4 });
  }
}
