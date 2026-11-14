import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { CREDITS_NOTICE, DEFAULT_ROOM_CODE } from "@vice/contracts";
import { config, publicConfigSummary } from "./config";
import { ExperimentRunner } from "./demo/experiment";
import { createRoomFactory } from "./engine/compose";
import { createPersistence } from "./persistence";
import { verifyReplay } from "./replay";
import { RoomManager } from "./rooms/RoomManager";
import { attachTransport } from "./transport/socket";

if (config.databaseUrl !== ":memory:") mkdirSync(path.dirname(config.databaseUrl), { recursive: true });
const persistence = createPersistence(config.databaseUrl);

const providers = {
  naceApiKey: config.naceApiKey, naceModel: config.naceModel, metaApiKey: config.metaApiKey, metaBaseUrl: config.metaBaseUrl, metaModel: config.metaModel,
  concurrency: config.decisionConcurrency, maxCallsPerMinute: config.maxDecisionCallsPerMin,
};
let runner: ExperimentRunner | null = null;
const build = createRoomFactory({
  persistence, providers,
  experiments: () => runner?.list() ?? [],
  onRunExperiment: (engine, durationSec) => runner?.start(engine.state.seed, durationSec) ?? null,
});
// The live room starts on Drex when a key is configured; otherwise it is honestly scripted.
const rooms = new RoomManager(build, { directorSecret: config.demoDirectorSecret, defaultMode: config.naceApiKey ? "drex" : "scripted", tickHz: config.tickHz });

const app = express();
app.use(express.json({ limit: "64kb" }));
const httpServer = createServer(app);
// Browsers normally reach us through the Vite proxy (same origin); direct LAN origins are allowed for the second laptop.
const io = new SocketIOServer(httpServer, { cors: { origin: true }, maxHttpBufferSize: 64 * 1024 });
const transport = attachTransport(io, rooms);
runner = new ExperimentRunner(build, persistence, (r) => transport.experiment(r), config.tickHz);
transport.wire(rooms.ensureDefault());

app.get("/health", (_req, res) => {
  const room = rooms.get(DEFAULT_ROOM_CODE);
  res.json({ ok: true, ...publicConfigSummary(), rooms: rooms.rooms.size, defaultRoom: DEFAULT_ROOM_CODE, mode: room?.engine.state.mode ?? null, badge: room?.scheduler.status().badge ?? null, credits: CREDITS_NOTICE });
});
const room = (code: unknown) => rooms.get(String(code ?? ""));
app.get("/api/rooms/:code/snapshot", (req, res) => { const r = room(req.params.code); return r ? res.json(r.engine.snapshot()) : res.status(404).json({ error: "ROOM_NOT_FOUND" }); });
app.get("/api/rooms/:code/events", (req, res) => {
  const r = room(req.params.code); if (!r) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  const after = Number(req.query.after ?? 0) || 0;
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500) || 500));
  const events = r.engine.events.filter((e) => e.serverSequence > after).slice(0, limit);
  return res.json({ roomCode: r.code, runId: r.engine.state.runId, lastEventSequence: r.engine.state.lastEventSequence, events });
});
app.get("/api/rooms/:code/agents/:id/trace", (req, res) => {
  const r = room(req.params.code); if (!r) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!r.engine.state.npcs[req.params.id]) return res.status(404).json({ error: "AGENT_NOT_FOUND" });
  const agent = r.engine.agentView(req.params.id);
  return res.json({ agent, decisions: r.engine.brains.traces().filter((t) => t.agentId === req.params.id), messages: r.engine.state.messages.filter((m) => m.senderId === req.params.id || m.recipientId === req.params.id) });
});
/** Folds the persisted event log (no model calls) and compares it with live wallets, listings and characters. */
app.get("/api/rooms/:code/replay/verify", (req, res) => {
  const r = room(req.params.code); if (!r) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  const s = r.engine.state;
  let events = r.engine.events; let source = "memory";
  try { const stored = persistence.loadEvents(s.id, s.runId); if (stored.length) { events = stored; source = "sqlite"; } } catch { /* fall back to memory */ }
  const v = verifyReplay(events, s);
  return res.json({ ok: v.ok, source, runId: s.runId, eventCount: events.length, mismatches: v.mismatches, projection: v.projection });
});
app.get("/api/experiments", (_req, res) => res.json(runner?.list() ?? []));

httpServer.listen(config.port, "0.0.0.0", () => {
  const { drexConfigured, metaConfigured } = publicConfigSummary();
  console.log(`[vice-exchange] server listening on http://0.0.0.0:${config.port} (drexConfigured=${drexConfigured}, metaConfigured=${metaConfigured}, room=${DEFAULT_ROOM_CODE})`);
});

const shutdown = () => { rooms.stop(); try { persistence.close(); } catch { /* already closed */ } httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
