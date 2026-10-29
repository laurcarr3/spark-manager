import type { LifecycleManager } from "@spark-manager/core";

import { createApp } from "./app.js";

const port = Number(process.env.SPARK_MANAGER_API_PORT ?? 3000);
const app = createApp({ token: process.env.SPARK_MANAGER_API_TOKEN });
const lifecycle = app.locals.lifecycle as LifecycleManager;

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`spark-manager API listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
const shutDown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down. Model containers keep running.`);
  server.close();
  server.closeIdleConnections();
  // Terminates running recipe scripts; the containers they launched are left alone.
  await lifecycle.close();
  process.exit(0);
};
process.once("SIGINT", (signal) => void shutDown(signal));
process.once("SIGTERM", (signal) => void shutDown(signal));
