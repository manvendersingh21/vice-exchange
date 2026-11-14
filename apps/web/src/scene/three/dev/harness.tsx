// Dev-only visual harness for the 3D city (not imported by the app). Open /src/scene/three/dev/index.html?spectate=1
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CITY_MAP, MISSION_SPOTS } from "@vice/contracts";
import type { AgentView, CharacterView, GameEvent, ListingView, MissionView } from "@vice/contracts";
import ThreeCity from "../ThreeCity";

const npc = (id: string, name: string, role: AgentView["role"], x: number, z: number, activity: AgentView["activity"] = "IDLE", pending = false): AgentView => ({
  id, name, role, goal: "", persona: "", x, z, activity, targetCharacterId: null, walletCredits: null, holdings: {}, contacts: [], memories: [],
  pendingDecisionId: pending ? "dec_1" : null, lastDecision: null, recentDecisions: [],
});
const npcs: AgentView[] = [
  npc("npc_w1", "Marisol Vega", "WITNESS", 40, 64, "IDLE", true), npc("npc_w2", "Otis Brandt", "WITNESS", 55, 45),
  npc("npc_i1", "Lena Okoye", "INFORMANT", 33, 52), npc("npc_i2", "Dex Marlowe", "INFORMANT", 62, 30),
  npc("npc_t1", "Priya Castellan", "TRADER", 17, 31), npc("npc_t2", "Rook Halvorsen", "TRADER", 30, 41),
  npc("npc_p1", "Sgt. Imani Duarte", "POLICE", 50, 56, "PURSUE"), npc("npc_p2", "Ofc. Cole Renner", "POLICE", 92, 40, "PATROL"),
];
const ch = (id: string, nickname: string, role: CharacterView["role"], x: number, z: number, heat: number, status: CharacterView["status"]): CharacterView => ({
  id, playerId: "p_" + id, nickname, role, ticker: role === "OUTLAW" ? nickname.slice(0, 3).toUpperCase() + "-01" : null, status, x, z, heat,
  wantedLevel: Math.floor(heat / 20), wanted: status === "WANTED", notorietyPoints: 2, completedMissions: 1, successfulEscapes: 0, spawnTimeMs: 0, captureTimeMs: null, capturedBy: null,
});
const missions: MissionView[] = MISSION_SPOTS.slice(1, 2).map((m, i) => ({ id: "m" + i, x: m.x, z: m.z, label: m.label, status: "AVAILABLE", completedByCharacterId: null }));
const listings = [{ ticker: "ACE-01", spotPrice: 187 }] as unknown as ListingView[];
const ev = (seq: number, type: string, payload: unknown): GameEvent => ({ schemaVersion: 1, eventId: "e" + seq, roomId: "r", runId: "r", serverSequence: seq, time: "", simTimeMs: 0, type, actorId: "x", causationId: null, correlationId: "c", payload } as unknown as GameEvent);

function Harness() {
  const spectate = new URLSearchParams(location.search).has("spectate");
  const [t, setT] = useState(0);
  const [events, setEvents] = useState<GameEvent[]>([ev(1, "ROOM_CREATED", {})]);
  useEffect(() => { const i = setInterval(() => setT((v) => v + 0.1), 100); return () => clearInterval(i); }, []);
  useEffect(() => {
    let seq = 1;
    const i = setInterval(() => {
      seq += 3;
      setEvents((e) => [...e,
        ev(seq, "AGENT_MESSAGE_SENT", { messageId: "m" + seq, senderId: "npc_w1", recipientId: "npc_i1", kind: "GOSSIP" }),
        ev(seq + 1, "AGENT_MESSAGE_SENT", { messageId: "n" + seq, senderId: "npc_i1", recipientId: "npc_t2", kind: "RELAY" }),
        ev(seq + 2, "AGENT_MESSAGE_SENT", { messageId: "o" + seq, senderId: "npc_w2", recipientId: "npc_p1", kind: "REPORT" }),
        ...(seq % 4 === 0 ? [ev(seq + 2.5, "CAPTURE_SUCCEEDED", { captureId: "c" + seq, characterId: "c_hunt" })] : []),
      ]);
    }, 1800);
    return () => clearInterval(i);
  }, []);
  const characters = [
    ch("c_you", "Ace", "OUTLAW", 47 + Math.cos(t * 0.5) * 6, 62 + Math.sin(t * 0.5) * 4, 55, "WANTED"),
    ch("c_hunt", "Vex", "HUNTER", 70, 54, 0, "ACTIVE"),
  ];
  const [sel, setSel] = useState<string | null>("npc_w1");
  return <ThreeCity map={CITY_MAP} characters={characters} npcs={npcs} missions={missions} listings={listings} tick={null} events={events}
    youCharacterId={spectate ? null : "c_you"} selectedId={sel} onSelect={(id) => setSel(id)} />;
}
createRoot(document.getElementById("root")!).render(<Harness />);
