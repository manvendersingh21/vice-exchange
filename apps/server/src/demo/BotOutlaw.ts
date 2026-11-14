import { RULES, dist } from "@vice/contracts";
import type { Vec2 } from "@vice/contracts";
import type { RoomEngine } from "../engine/RoomEngine";
import { findPath } from "../engine/pathfinding";

/** After the mission the bot walks this fixed loop of road intersections. */
const LOOP: Vec2[] = [{ x: 47, z: 54 }, { x: 62, z: 54 }, { x: 62, z: 28 }, { x: 32, z: 28 }, { x: 32, z: 54 }];
/** Walks at 40% of player speed so police can realistically catch up. The same handicap applies in every mode. */
const PACE = 0.4;

/**
 * Scripted human stand-in for baseline experiments. It issues exactly the commands a browser would
 * (player.move intents and one mission.interact), so it is subject to the same server validation.
 */
export class BotOutlaw {
  readonly playerId: string;
  private path: Vec2[] = []; private goal: Vec2 | null = null; private loopIndex = 0; private n = 0; private didMission = false;
  constructor(private engine: RoomEngine, nickname = "Ace") {
    this.playerId = engine.addPlayer({ nickname, role: "OUTLAW", isBot: true, sessionToken: `bot_${engine.opts.roomId}` }).id;
  }
  /** Call once per engine tick, before engine.tick(). */
  step(): void {
    const e = this.engine; const p = e.state.players[this.playerId]; const c = p?.characterId ? e.state.characters[p.characterId] : undefined;
    if (!p || !c || (c.status !== "ACTIVE" && c.status !== "WANTED")) return;
    const mission = this.didMission ? undefined : Object.values(e.state.missions).find((x) => x.status === "AVAILABLE");
    if (mission && dist(c, mission) <= RULES.missionInteractRadius - 0.5) {
      this.didMission = true; this.goal = null;
      e.dispatch(this.playerId, { type: "mission.interact", missionId: mission.id, commandId: `bot-mission-${++this.n}` });
    }
    let target: Vec2 = mission && !this.didMission ? { x: mission.x, z: mission.z } : LOOP[this.loopIndex % LOOP.length]!;
    if (this.didMission && dist(c, target) < 1.2) { this.loopIndex++; target = LOOP[this.loopIndex % LOOP.length]!; }
    if (!this.goal || this.goal.x !== target.x || this.goal.z !== target.z || !this.path.length) {
      this.goal = target; this.path = findPath(c, target, 0.75) ?? [target];
    }
    while (this.path.length > 1 && dist(c, this.path[0]!) < 0.7) this.path.shift();
    const to = this.path[0] ?? target; const d = dist(c, to);
    if (d < 0.05) { e.dispatch(this.playerId, { type: "player.move", dirX: 0, dirZ: 0 }); return; }
    e.dispatch(this.playerId, { type: "player.move", dirX: ((to.x - c.x) / d) * PACE, dirZ: ((to.z - c.z) / d) * PACE });
  }
}
