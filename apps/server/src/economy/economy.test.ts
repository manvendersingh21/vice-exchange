import { describe, expect, it } from "vitest";
import { RULES } from "@vice/contracts";
import type { CharacterState, OrderRequest, RoomState } from "../domain";
import { createEconomy, referenceValue, sentimentFactor, survivalFactor } from "./index";

const T0 = 1_000_000;
const eco = createEconomy();

function room(): RoomState {
  return {
    id: "room_1", code: "VICE-42", runId: "run_1", seed: 42, tick: 0, ruleVersion: "t", mode: "scripted",
    createdAtMs: T0, runStartedAtMs: T0, lastEventSequence: 0,
    players: {}, characters: {}, npcs: {}, listings: {}, wallets: {}, missions: {}, messages: [], trades: [], counters: {},
  };
}
function outlaw(over: Partial<CharacterState> = {}): CharacterState {
  return {
    id: "chr_1", playerId: "ply_1", nickname: "Ace", role: "OUTLAW", ticker: "ACE-01", status: "ACTIVE", x: 0, z: 0,
    notorietyPoints: 0, completedMissions: 0, heat: 0, successfulEscapes: 0, spawnTimeMs: T0, captureTimeMs: null,
    capturedBy: null, lastHeatGainAtMs: 0, lastPoliceSightingAtMs: 0, ...over,
  };
}
function setup(over: Partial<CharacterState> = {}, balance: number = RULES.trade.startingWalletHuman) {
  const state = room();
  const c = outlaw(over);
  state.characters[c.id] = c;
  eco.openListing(state, c, T0);
  eco.openWallet(state, { id: "w_a", ownerId: "ply_a", ownerKind: "HUMAN", ownerName: "A", balance });
  return { state, c };
}
let n = 0;
function order(side: "BUY" | "SELL", over: Partial<OrderRequest> = {}): OrderRequest {
  n++;
  return { walletId: "w_a", actorId: "ply_a", actorName: "A", actorKind: "HUMAN", ticker: "ACE-01", side, qty: 1, commandId: `cmd_${n}`, tradeId: `trd_${n}`, ...over };
}
const snap = (s: RoomState) => JSON.stringify(s);

describe("price formula", () => {
  it("opens at the documented value", () => {
    const { state } = setup();
    const q = eco.quote(state, "ACE-01", T0)!;
    expect(q.referenceValue).toBe(100);
    expect(q.spotPrice).toBe(95); // round(100 * 0.95 * 1)
    expect(q.ask).toBe(95);
    expect(q.bid).toBe(92); // floor(95 * 0.97)
    expect(state.listings["ACE-01"]!.history).toEqual([{ t: T0, spot: 95, reference: 100 }]);
  });

  it("matches fixed inputs: notoriety, missions, survival, heat, escapes", () => {
    const { state } = setup({ notorietyPoints: 4, completedMissions: 2, heat: 42, successfulEscapes: 1 });
    const now = T0 + 63_000; // 63 s -> 12 survival steps
    const q = eco.quote(state, "ACE-01", now)!;
    expect(q.survivalSeconds).toBe(63);
    expect(q.referenceValue).toBe(100 + 15 * 4 + 60 * 2 + 2 * 12); // 304
    expect(q.survivalFactor).toBeCloseTo(0.95 - 0.007 * 42 + 0.02, 10); // 0.676
    expect(q.spotPrice).toBe(Math.round(304 * 0.676)); // 206
  });

  it("a mission raises reference; heat lowers spot but not reference", () => {
    const { state, c } = setup();
    c.notorietyPoints += RULES.notoriety.perMission;
    c.completedMissions += 1;
    const ch = eco.reprice(state, "ACE-01", T0, "MISSION")!;
    expect(ch.referenceValue).toBe(190);
    expect(ch.previousSpotPrice).toBe(95);
    expect(ch.spotPrice).toBe(Math.round(190 * 0.95));
    c.heat = 42;
    const ch2 = eco.reprice(state, "ACE-01", T0, "HEAT")!;
    expect(ch2.referenceValue).toBe(190);
    expect(ch2.spotPrice).toBeLessThan(ch.spotPrice);
    expect(ch2.heat).toBe(42);
    expect(eco.reprice(state, "ACE-01", T0, "HEAT")).toBeNull(); // nothing moved
  });

  it("clamps survival factor and sentiment", () => {
    expect(survivalFactor(outlaw({ heat: 1000 }))).toBe(0.15);
    expect(survivalFactor(outlaw({ heat: 0, successfulEscapes: 50 }))).toBe(0.98);
    expect(sentimentFactor(100)).toBe(1.25);
    expect(sentimentFactor(-100)).toBe(0.75);
    expect(sentimentFactor(2)).toBeCloseTo(1.06, 10);
  });

  it("spot never drops below 1 while active", () => {
    const { state } = setup({ heat: 100 });
    state.listings["ACE-01"]!.demand.push({ atMs: T0, units: -50 });
    expect(eco.quote(state, "ACE-01", T0)!.spotPrice).toBeGreaterThanOrEqual(1);
  });

  it("the longer you live, the more you're worth", () => {
    const c = outlaw();
    let prev = referenceValue(c, T0);
    for (let s = 5; s <= 300; s += 5) {
      const r = referenceValue(c, T0 + s * 1000);
      expect(r).toBe(prev + RULES.price.perSurvivalStep);
      prev = r;
    }
    expect(referenceValue(c, T0 + 4_999)).toBe(100);
    expect(referenceValue(c, T0 + 60_000)).toBe(124);
  });

  it("reprice on survival tick pushes history, capped", () => {
    const { state } = setup();
    for (let i = 1; i <= RULES.price.historyMaxPoints + 20; i++) eco.reprice(state, "ACE-01", T0 + i * 5000, "SURVIVAL_TICK");
    expect(state.listings["ACE-01"]!.history.length).toBe(RULES.price.historyMaxPoints);
  });

  it("sentiment decays as demand leaves the window", () => {
    const { state } = setup();
    expect(eco.executeOrder(state, order("BUY"), T0).ok).toBe(true);
    expect(eco.quote(state, "ACE-01", T0 + 1000)!.netBuyUnits).toBe(1);
    const later = T0 + RULES.price.sentiment.windowMs + 1;
    expect(eco.quote(state, "ACE-01", later)!.netBuyUnits).toBe(0);
    expect(state.listings["ACE-01"]!.demand).toEqual([]); // pruned by quote
  });

  it("unknown ticker", () => {
    const { state } = setup();
    expect(eco.quote(state, "NOPE-99", T0)).toBeNull();
    expect(eco.reprice(state, "NOPE-99", T0, "HEAT")).toBeNull();
    expect(eco.listingView(state, "NOPE-99", T0)).toBeNull();
    expect(eco.walletView(state, "nope")).toBeNull();
  });
});

describe("trading", () => {
  it("buy moves credits and shares together at the ask, then reprices", () => {
    const { state } = setup();
    const r = eco.executeOrder(state, order("BUY"), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.executionPrice).toBe(95);
    expect(r.balanceAfter).toBe(2000 - 95);
    expect(r.sharesAfter).toBe(1);
    expect(state.wallets["w_a"]!.holdings["ACE-01"]).toEqual({ shares: 1, costBasis: 95 });
    expect(r.priceChange!.spotPrice).toBe(Math.round(100 * 0.95 * 1.03)); // 98
    expect(r.priceChange!.reason).toBe("TRADE");
    expect(state.trades).toHaveLength(1);
    expect(state.listings["ACE-01"]!.volume).toBe(1);
  });

  it("sell fills at the bid and removes an emptied holding", () => {
    const { state } = setup();
    eco.executeOrder(state, order("BUY"), T0);
    const t1 = T0 + RULES.trade.cooldownMs;
    const bid = eco.quote(state, "ACE-01", t1)!.bid;
    const r = eco.executeOrder(state, order("SELL"), t1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.executionPrice).toBe(bid);
    expect(r.sharesAfter).toBe(0);
    expect(r.balanceAfter).toBe(2000 - 95 + bid);
    expect(state.wallets["w_a"]!.holdings["ACE-01"]).toBeUndefined();
    expect(eco.quote(state, "ACE-01", t1)!.netBuyUnits).toBe(0);
  });

  it("every rejection leaves state byte-identical", () => {
    const { state } = setup();
    eco.openWallet(state, { id: "w_poor", ownerId: "ply_p", ownerKind: "HUMAN", ownerName: "P", balance: 10 });
    const cases: Array<[OrderRequest, number, string]> = [
      [order("BUY", { ticker: "NOPE-99" }), T0, "UNKNOWN_TICKER"],
      [order("BUY", { walletId: "missing" }), T0, "ACTOR_NOT_ALLOWED"],
      [order("BUY", { actorId: "someone_else" }), T0, "ACTOR_NOT_ALLOWED"],
      [order("BUY", { qty: 2 }), T0, "INVALID_QTY"],
      [order("BUY", { qty: 0 }), T0, "INVALID_QTY"],
      [order("BUY", { qty: 0.5 }), T0, "INVALID_QTY"],
      [order("SELL"), T0, "INSUFFICIENT_SHARES"],
      [order("BUY", { walletId: "w_poor", actorId: "ply_p" }), T0, "INSUFFICIENT_FUNDS"],
    ];
    for (const [o, at, reason] of cases) {
      const before = snap(state);
      const r = eco.executeOrder(state, o, at);
      expect(r).toMatchObject({ ok: false, reason });
      expect(snap(state)).toBe(before);
    }
    // cooldown
    expect(eco.executeOrder(state, order("BUY"), T0).ok).toBe(true);
    const before = snap(state);
    expect(eco.executeOrder(state, order("BUY"), T0 + RULES.trade.cooldownMs - 1)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(snap(state)).toBe(before);
    expect(eco.executeOrder(state, order("BUY"), T0 + RULES.trade.cooldownMs).ok).toBe(true);
  });

  it("enforces the position cap", () => {
    const { state } = setup({}, 100_000);
    let t = T0;
    for (let i = 0; i < RULES.trade.maxSharesPerTicker; i++) {
      expect(eco.executeOrder(state, order("BUY"), t).ok).toBe(true);
      t += RULES.trade.cooldownMs;
    }
    const before = snap(state);
    expect(eco.executeOrder(state, order("BUY"), t)).toMatchObject({ ok: false, reason: "POSITION_LIMIT" });
    expect(snap(state)).toBe(before);
    expect(state.wallets["w_a"]!.holdings["ACE-01"]!.shares).toBe(10);
  });

  it("wallet never goes negative and balances stay integers", () => {
    const { state } = setup({}, 300);
    let t = T0;
    for (let i = 0; i < 12; i++) {
      eco.executeOrder(state, order("BUY"), t);
      t += RULES.trade.cooldownMs;
      const w = state.wallets["w_a"]!;
      expect(w.balanceCredits).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(w.balanceCredits)).toBe(true);
    }
    expect(state.wallets["w_a"]!.holdings["ACE-01"]!.shares).toBe(3); // 95 + 98 + 101 = 294; a fourth is unaffordable
  });

  it("a buy/sell round trip cannot profit from its own price impact", () => {
    for (let k = 1; k <= RULES.trade.maxSharesPerTicker; k++) {
      const { state } = setup({ notorietyPoints: 6, completedMissions: 3 }, 100_000);
      const c = state.characters["chr_1"]!;
      c.spawnTimeMs = T0; // freeze survival growth out of the comparison
      let t = T0;
      const step = RULES.trade.cooldownMs;
      const frozen = () => { c.spawnTimeMs = t; };
      for (let i = 0; i < k; i++) { frozen(); expect(eco.executeOrder(state, order("BUY"), t).ok).toBe(true); t += step; }
      for (let i = 0; i < k; i++) { frozen(); expect(eco.executeOrder(state, order("SELL"), t).ok).toBe(true); t += step; }
      expect(state.wallets["w_a"]!.balanceCredits).toBeLessThanOrEqual(100_000);
      expect(state.wallets["w_a"]!.holdings["ACE-01"]).toBeUndefined();
    }
  });

  it("NPC wallets go through the same checks", () => {
    const { state } = setup();
    eco.openWallet(state, { id: "w_t", ownerId: "npc_t1", ownerKind: "NPC", ownerName: "Priya", balance: 0 });
    expect(eco.executeOrder(state, order("BUY", { walletId: "w_t", actorId: "npc_t1", actorKind: "NPC" }), T0)).toMatchObject({ ok: false, reason: "INSUFFICIENT_FUNDS" });
  });

  it("wallet and listing views", () => {
    const { state } = setup();
    eco.executeOrder(state, order("BUY"), T0);
    const w = eco.walletView(state, "w_a")!;
    expect(w.balanceCredits).toBe(1905);
    expect(w.holdings).toEqual([{ ticker: "ACE-01", shares: 1, costBasis: 95, marketValue: 98 }]);
    expect(w.netWorth).toBe(1905 + 98);
    const l = eco.listingView(state, "ACE-01", T0)!;
    expect(l).toMatchObject({ status: "ACTIVE", spotPrice: 98, ask: 98, bid: 95, netBuyUnits: 1, volume: 1, currentBounty: 50 });
  });

  it("openWallet is idempotent and credit validates", () => {
    const { state } = setup();
    const again = eco.openWallet(state, { id: "w_a", ownerId: "ply_a", ownerKind: "HUMAN", ownerName: "A", balance: 5 });
    expect(again.balanceCredits).toBe(2000);
    expect(eco.credit(state, "w_a", 75)).toBe(2075);
    expect(() => eco.credit(state, "w_a", 1.5)).toThrow();
    expect(() => eco.credit(state, "nope", 1)).toThrow();
    expect(() => eco.credit(state, "w_a", -99999)).toThrow();
  });
});

describe("capture halt and bounty", () => {
  it("halt is one-way and exactly zero; all later orders are rejected", () => {
    const { state, c } = setup({ notorietyPoints: 2, completedMissions: 1 });
    eco.executeOrder(state, order("BUY"), T0);
    const t = T0 + 30_000;
    const spotBefore = eco.quote(state, "ACE-01", t)!.spotPrice;
    c.status = "CAPTURED";
    c.captureTimeMs = t;
    const h = eco.haltListing(state, "ACE-01", t)!;
    expect(h.finalSpotBeforeHalt).toBe(spotBefore);
    expect(h.referenceAtHalt).toBe(100 + 30 + 60 + 12);
    const l = state.listings["ACE-01"]!;
    expect(l.status).toBe("HALTED_CAPTURED");
    expect(l.spotPrice).toBe(0);
    expect(l.history.at(-1)).toMatchObject({ t, spot: 0 });
    expect(eco.haltListing(state, "ACE-01", t + 1)).toBeNull();
    const q = eco.quote(state, "ACE-01", t + 60_000)!;
    expect([q.spotPrice, q.bid, q.ask]).toEqual([0, 0, 0]);
    expect(eco.reprice(state, "ACE-01", t + 60_000, "SURVIVAL_TICK")).toBeNull();
    const before = snap(state);
    for (const side of ["BUY", "SELL"] as const) {
      expect(eco.executeOrder(state, order(side), t + 60_000)).toMatchObject({ ok: false, reason: "LISTING_HALTED" });
    }
    expect(snap(state)).toBe(before);
    const w = eco.walletView(state, "w_a")!;
    expect(w.holdings[0]).toMatchObject({ shares: 1, marketValue: 0 }); // position kept, worth V$0
    expect(eco.listingView(state, "ACE-01", t + 60_000)).toMatchObject({ status: "HALTED_CAPTURED", spotPrice: 0, finalSpotBeforeHalt: spotBefore });
  });

  it("bounty grows with survival time and never falls when heat rises", () => {
    const { state, c } = setup({ notorietyPoints: 2, completedMissions: 1 });
    let prev = 0;
    for (let s = 0; s <= 600; s += 5) {
      c.heat = Math.min(100, s / 4); // heat climbing the whole time
      const b = eco.bountyFor(state, c.id, T0 + s * 1000);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect(eco.bountyFor(state, c.id, T0)).toBe(95); // round(190 * 0.5)
    expect(eco.bountyFor(state, c.id, T0 + 300_000)).toBe(155); // round(310 * 0.5)
    expect(prev).toBeGreaterThan(95);
  });

  it("bounty floor and frozen bounty after halt", () => {
    const { state, c } = setup();
    expect(eco.bountyFor(state, c.id, T0)).toBe(RULES.bounty.min);
    expect(eco.bountyFor(state, "nobody", T0)).toBe(RULES.bounty.min);
    c.completedMissions = 5;
    const t = T0 + 10_000;
    c.captureTimeMs = t;
    eco.haltListing(state, "ACE-01", t);
    expect(eco.bountyFor(state, c.id, t + 999_999)).toBe(Math.round((100 + 300 + 4) * 0.5));
  });

  it("hunters cannot be listed; duplicate listing throws", () => {
    const { state, c } = setup();
    expect(() => eco.openListing(state, outlaw({ id: "chr_h", role: "HUNTER", ticker: null }), T0)).toThrow();
    expect(() => eco.openListing(state, c, T0)).toThrow();
  });
});
