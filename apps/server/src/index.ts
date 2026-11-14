// PLACEHOLDER entry point created by the scaffold. Replace with the real server wiring.
import { createServer } from "node:http";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { config, publicConfigSummary } from "./config";

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...publicConfigSummary() });
});

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: { origin: [config.webOrigin] },
});

io.on("connection", (socket) => {
  socket.emit("server.hello", { ok: true });
});

httpServer.listen(config.port, "0.0.0.0", () => {
  const { drexConfigured, metaConfigured } = publicConfigSummary();
  console.log(
    `[vice-exchange] server listening on http://0.0.0.0:${config.port} ` +
      `(drexConfigured=${drexConfigured}, metaConfigured=${metaConfigured})`,
  );
});
