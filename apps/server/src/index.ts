import { DEFAULT_ROOM_CODE } from "@vice/contracts";
import { config, publicConfigSummary } from "./config";
import { createApp } from "./transport/app";

const app = createApp({
  port: config.port, databaseUrl: config.databaseUrl, directorSecret: config.demoDirectorSecret, tickHz: config.tickHz, webOrigin: config.webOrigin,
  providers: {
    naceApiKey: config.naceApiKey, naceModel: config.naceModel, metaApiKey: config.metaApiKey, metaBaseUrl: config.metaBaseUrl, metaModel: config.metaModel,
    concurrency: config.decisionConcurrency, maxCallsPerMinute: config.maxDecisionCallsPerMin,
  },
});

app.listen().then((port) => {
  const { drexConfigured, metaConfigured } = publicConfigSummary(); // booleans only, never key material
  console.log(`[vice-exchange] server listening on http://0.0.0.0:${port} (drexConfigured=${drexConfigured}, metaConfigured=${metaConfigured}, room=${DEFAULT_ROOM_CODE})`);
}).catch((err: unknown) => {
  console.error("[vice-exchange] failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 800).unref();
  void app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
