// Composition root: wires the swarm's modules into a RoomEngine.
import type { DecisionMode, ExperimentResult } from "@vice/contracts";
import type { Clock, MetricsPort, PersistencePort, PolicyPort, SchedulerPort } from "../domain";
import { createBrains, createMemoryStore } from "../agents";
import { createScheduler } from "../decisions";
import { createEconomy } from "../economy";
import { createMetrics } from "../metrics";
import { RoomEngine } from "./RoomEngine";
import { systemClock } from "./util";

export interface ProviderConfig { naceApiKey: string; naceModel: string; metaApiKey: string; metaBaseUrl: string; metaModel: string; concurrency: number; maxCallsPerMinute: number }
export interface RoomFactoryDeps {
  persistence: PersistencePort; providers: ProviderConfig; clock?: Clock; policy?: PolicyPort | null;
  experiments?: () => ExperimentResult[];
  onRunExperiment?: (engine: RoomEngine, durationSec: number) => ExperimentResult | null;
}
export interface BuiltRoom { engine: RoomEngine; scheduler: SchedulerPort; metrics: MetricsPort }
export interface RoomBuildOpts { roomId: string; code: string; seed: number; mode: DecisionMode; concurrency?: number; scheduler?: SchedulerPort; clock?: Clock }

export function createRoomFactory(deps: RoomFactoryDeps): (o: RoomBuildOpts) => BuiltRoom {
  return (o) => {
    const clock = o.clock ?? deps.clock ?? systemClock;
    const memory = createMemoryStore();
    const metrics = createMetrics();
    const scheduler = o.scheduler ?? createScheduler({ roomId: o.roomId, mode: o.mode, clock, ...deps.providers, concurrency: o.concurrency ?? deps.providers.concurrency });
    const engine = new RoomEngine({
      clock, economy: createEconomy(), memory, scheduler, persistence: deps.persistence, metrics, policy: deps.policy ?? null,
      createBrains: (world, onTrace) => createBrains({ world, memory, scheduler, policy: deps.policy ?? null, onTrace }),
      experiments: deps.experiments, onRunExperiment: deps.onRunExperiment,
    }, { roomId: o.roomId, code: o.code, seed: o.seed, mode: o.mode });
    return { engine, scheduler, metrics };
  };
}
