import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../dist/app.js";

export const FAST_TIMING = {
  startTimeoutMs: 20_000,
  stopTimeoutMs: 5_000,
  killGraceMs: 500,
};

/** In-memory stand-in for Docker: tests decide which containers each model owns. */
export class FakeRuntime {
  containers = new Map();
  killed = [];
  inspectError = null;

  set(displayName, containers) {
    this.containers.set(displayName, containers);
  }

  async inspect(workspaces) {
    if (this.inspectError) throw new Error(this.inspectError);
    return new Map(
      workspaces.map((workspace) => [
        workspace.displayName,
        structuredClone(this.containers.get(workspace.displayName) ?? []),
      ]),
    );
  }

  async kill(ids) {
    this.killed.push(...ids);
  }
}

export function container(id, overrides = {}) {
  return {
    id,
    name: id,
    running: true,
    restarting: false,
    status: "running",
    exitCode: null,
    oomKilled: false,
    restartCount: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

/**
 * Creates one workspace per model. `scripts` maps a display name to
 * `{ start?, stop? }` shell bodies (default `exit 0`); `null` omits the script.
 */
export async function createFixture(scripts, registryExtras = {}) {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-lifecycle-test-"));
  const workspaces = {};
  const registry = {};
  for (const [displayName, bodies] of Object.entries(scripts)) {
    const workspace = join(directory, displayName.toLowerCase().replaceAll(" ", "-"));
    await mkdir(workspace);
    for (const name of ["start", "stop"]) {
      const body = bodies[name] === undefined ? "exit 0" : bodies[name];
      if (body !== null) {
        await writeExecutable(join(workspace, `${name}.sh`), `#!/bin/sh\n${body}\n`);
      }
    }
    workspaces[displayName] = workspace;
    registry[displayName] = {
      workspaceDirectory: workspace,
      ...registryExtras[displayName],
    };
  }
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(registry));
  return {
    directory,
    registryPath,
    workspaces,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function withApi(options, run) {
  const runtime = options.lifecycle?.runtime ?? new FakeRuntime();
  const app = createApp({
    logger: false,
    ...options,
    lifecycle: { timing: FAST_TIMING, ...options.lifecycle, runtime },
  });
  const lifecycle = app.locals.lifecycle;
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, { app, runtime, lifecycle });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await lifecycle.close();
  }
}

export function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json() };
}

export function modelUrl(baseUrl, displayName, suffix) {
  return `${baseUrl}/models/${encodeURIComponent(displayName)}/${suffix}`;
}

/** Polls `read` until `predicate` holds; never sleeps for a fixed time. */
export async function waitUntil(read, predicate, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForOperation(baseUrl, operationId, statuses = ["succeeded", "failed"]) {
  const { body } = await waitUntil(
    () => getJson(`${baseUrl}/operations/${operationId}`),
    ({ body }) => statuses.includes(body.operation?.status),
  );
  return body.operation;
}

export async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
