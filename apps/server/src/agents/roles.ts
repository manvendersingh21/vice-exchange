// Role logic: what an NPC may choose right now, and the state it is allowed to reason over.
// Everything here is built from the NPC's OWN memory, wallet and contacts plus public market data.
import { RULES } from "@vice/contracts";
import type { Citation, MemoryEntry } from "@vice/contracts";
import type { NpcState, PolicyPort, WorldPort } from "../domain";

export const FRESH_SIGHTING_MS = 10_000;

export interface RolePlan {
  question: string;
  options: Record<string, string>;
  scriptedAction: string;
  safeAction: string;
  state: Record<string, unknown>;
  citations: Citation[];
}

/** A direct, recent sighting of the subject by this NPC (required for `pursue`). */
export function freshSighting(memories: MemoryEntry[], subjectId: string | null, nowMs: number): MemoryEntry | undefined {
  if (!subjectId) return undefined;
  return memories.find((m) => m.subjectCharacterId === subjectId && m.sourceKind === "DIRECT"
    && (m.factType === "SIGHTING" || m.factType === "INCIDENT") && nowMs - m.observedAtMs <= FRESH_SIGHTING_MS);
}

function actorLabel(world: WorldPort, id: string, selfId: string): string {
  if (id === selfId) return "myself";
  const n = world.state.npcs[id];
  if (n) return `${n.name} (${n.role.toLowerCase()})`;
  const c = world.state.characters[id];
  return c ? c.nickname : id;
}

function describeMemory(world: WorldPort, npc: NpcState, m: MemoryEntry, nowMs: number): Record<string, unknown> {
  const source = m.sourceKind === "DIRECT" ? "saw it myself"
    : m.sourceKind === "MESSAGE" ? `told by ${actorLabel(world, m.sourceActorId, npc.id)}`
    : m.sourceKind === "BULLETIN" ? "public bulletin" : "official document";
  return {
    fact: m.factType.toLowerCase(), about: m.subjectTicker ?? m.subjectCharacterId ?? "unknown",
    summary: m.summary, source, hops_from_eyewitness: m.hop,
    my_belief: Number(m.confidence.toFixed(2)), seconds_ago: Math.max(0, Math.round((nowMs - m.observedAtMs) / 1000)),
  };
}

export function buildPlan(world: WorldPort, npc: NpcState, memories: MemoryEntry[], trigger: MemoryEntry, policy?: PolicyPort): RolePlan | null {
  const nowMs = world.now();
  const subjectId = trigger.subjectCharacterId;
  const ticker = trigger.subjectTicker ?? (subjectId ? world.state.characters[subjectId]?.ticker ?? null : null);
  const wallet = npc.walletId ? world.state.wallets[npc.walletId] : undefined;
  const base: Record<string, unknown> = {
    role: npc.role.toLowerCase(), name: npc.name, persona: npc.persona, goal: npc.goal,
    what_just_happened: describeMemory(world, npc, trigger, nowMs),
    my_memories: memories.slice(0, 8).map((m) => describeMemory(world, npc, m, nowMs)),
    my_contacts: npc.contacts.map((id) => actorLabel(world, id, npc.id)),
  };
  const citations: Citation[] = [];
  const about = ticker ?? "the person involved";

  if (npc.role === "WITNESS") {
    const options: Record<string, string> = {
      report: "Tell the city police what I know so they can act on it",
      ignore: "Stay out of it and say nothing for now",
    };
    if (npc.contacts.length > 0) options.gossip = "Quietly tell my informant contact instead of the police";
    return { question: `As this witness, what do you do about what you know regarding ${about}? Use only your own knowledge.`,
      options, scriptedAction: "report", safeAction: "ignore", state: base, citations };
  }
  if (npc.role === "INFORMANT") {
    if (npc.contacts.length === 0) return null;
    return { question: `As this informant, do you pass what you know about ${about} on to your trader contacts?`,
      options: { relay: "Pass the tip to my trader contacts now", withhold: "Keep it to myself; it is too weak or too risky to pass on" },
      scriptedAction: "relay", safeAction: "withhold", state: base, citations };
  }
  if (npc.role === "TRADER") {
    if (!ticker || !wallet) return null;
    const market = world.marketSummary(ticker);
    if (!market || market.status !== "ACTIVE") return null;
    const shares = wallet.holdings[ticker]?.shares ?? 0;
    const options: Record<string, string> = { hold: "Do nothing; the information does not justify a trade" };
    if (shares < RULES.trade.maxSharesPerTicker && wallet.balanceCredits >= market.spotPrice) {
      options.buy = `Buy one share of ${ticker}: I expect its value to rise (more notoriety, still free)`;
    }
    if (shares > 0) options.sell = `Sell one share of ${ticker}: I expect capture risk to rise or the price to fall`;
    return { question: `As this trader, what do you do with ${ticker} right now? A captured character's stock goes to zero.`,
      options, scriptedAction: "hold", safeAction: "hold",
      state: { ...base, my_wallet: { credits: wallet.balanceCredits, shares_held: shares, max_shares: RULES.trade.maxSharesPerTicker },
        public_market: { ticker, price: market.spotPrice, reference_value: market.referenceValue, change_pct_60s: market.changePct60s, net_buy_units_60s: market.netBuyUnits } },
      citations };
  }
  // POLICE
  if (!subjectId) return null;
  const sighting = freshSighting(memories, subjectId, nowMs);
  const options: Record<string, string> = {
    investigate: "Go to the last known location and look for the suspect",
    patrol: "Keep to my normal patrol; the information is too weak to act on",
  };
  if (sighting) options.pursue = "Chase the suspect I can see right now and attempt an arrest";
  if (policy) citations.push(...policy.factsFor("POLICE"));
  const state = { ...base, department_policy: citations.map((c) => ({ rule: c.extractedField, text: c.quote, source: c.documentTitle })) };
  return { question: `As this police officer, what do you do about ${about}?`,
    options, scriptedAction: sighting ? "pursue" : "investigate", safeAction: "patrol", state, citations };
}
