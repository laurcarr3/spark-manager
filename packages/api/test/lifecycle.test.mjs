import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  container,
  createFixture,
  FakeRuntime,
  getJson,
  modelUrl,
  postJson,
  waitForOperation,
  waitUntil,
  withApi,
} from "./helpers.mjs";

/** A start.sh body that blocks until the test creates `release` in the workspace. */
const WAIT_FOR_RELEASE = "while [ ! -f release ]; do sleep 0.02; done";

test("start returns 202 at once and the operation runs in the background", async () => {
  const fixture = await createFixture({ "Test Model": { start: `: > launched\n${WAIT_FOR_RELEASE}` } });
  const workspace = fixture.workspaces["Test Model"];
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl, { runtime }) => {
      const response = await postJson(modelUrl(baseUrl, "Test Model", "start"), {});
      assert.equal(response.status, 202);
      const accepted = await response.json();
      assert.match(accepted.operationId, /^op_[a-f0-9]{32}$/);
      assert.equal(response.headers.get("location"), `/operations/${accepted.operationId}`);
      assert.deepEqual(accepted, {
        operationId: accepted.operationId,
        kind: "start",
        model: "Test Model",
        desiredState: "running",
        lifecycleState: "queued",
        operationStatus: "queued",
        statusUrl: `/operations/${accepted.operationId}`,
        modelStatusUrl: "/models/Test%20Model/status",
      });

      const running = await waitForOperation(baseUrl, accepted.operationId, ["running"]);
      assert.equal(running.startedAt !== null, true);
      await waitUntil(() => readFile(join(workspace, "launched")).catch(() => null), Boolean);
      const { body: starting } = await getJson(modelUrl(baseUrl, "Test Model", "status"));
      assert.equal(starting.model.lifecycleState, "starting");
      assert.equal(starting.model.desiredState, "running");
      assert.deepEqual(starting.model.activeOperation, {
        operationId: accepted.operationId,
        kind: "start",
        status: "running",
      });

      runtime.set("Test Model", [container("c1")]);
      await writeFile(join(workspace, "release"), "");
      const operation = await waitForOperation(baseUrl, accepted.operationId);
      assert.equal(operation.status, "succeeded");
      assert.deepEqual(operation.command, { exitCode: 0, signal: null });
      assert.equal(operation.error, null);
      assert.deepEqual(operation.options, { switchRunning: false });

      const { body: status } = await getJson(`${baseUrl}/models/status`);
      const [model] = status.models;
      assert.equal(model.lifecycleState, "running");
      assert.equal(model.activeOperation, null);
      assert.deepEqual(model.lastOperation, {
        operationId: accepted.operationId,
        kind: "start",
        status: "succeeded",
      });
      assert.equal(model.lastError, null);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a failing start records START_COMMAND_FAILED and the model's lastError", async () => {
  const fixture = await createFixture({ "Test Model": { start: "exit 3" } });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const { operationId } = await (await postJson(modelUrl(baseUrl, "Test Model", "start"), {})).json();
      const operation = await waitForOperation(baseUrl, operationId);
      assert.equal(operation.status, "failed");
      assert.equal(operation.error.code, "START_COMMAND_FAILED");
      assert.equal(operation.error.exitCode, 3);
      assert.equal(operation.error.signal, null);
      assert.equal(operation.error.retrySafe, false);
      assert.deepEqual(operation.error.logTail, []);

      const { body } = await getJson(modelUrl(baseUrl, "Test Model", "status"));
      assert.equal(body.model.lifecycleState, "failed");
      assert.deepEqual(body.model.lastError, operation.error);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a missing start.sh gives START_COMMAND_UNAVAILABLE", async () => {
  const fixture = await createFixture({ "Test Model": { start: null } });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const { operationId } = await (await postJson(modelUrl(baseUrl, "Test Model", "start"), {})).json();
      const operation = await waitForOperation(baseUrl, operationId);
      assert.equal(operation.error.code, "START_COMMAND_UNAVAILABLE");
      assert.equal(operation.error.retrySafe, true);
      assert.equal(operation.command, null);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a start that outlives its timeout is terminated with STARTUP_TIMEOUT", async () => {
  const fixture = await createFixture({ "Test Model": { start: `echo $$ > pid\n${WAIT_FOR_RELEASE}` } });
  try {
    await withApi(
      { registryPath: fixture.registryPath, lifecycle: { timing: { startTimeoutMs: 200, killGraceMs: 200 } } },
      async (baseUrl) => {
        const { operationId } = await (await postJson(modelUrl(baseUrl, "Test Model", "start"), {})).json();
        const operation = await waitForOperation(baseUrl, operationId);
        assert.equal(operation.error.code, "STARTUP_TIMEOUT");
        assert.equal(operation.error.retrySafe, false);
        const pid = Number((await readFile(join(fixture.workspaces["Test Model"], "pid"), "utf8")).trim());
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stop runs stop.sh in the background and reports its failures", async () => {
  const fixture = await createFixture({
    "Clean Stop": { stop: ": > stopped" },
    "Failing Stop": { stop: "exit 4" },
    "No Stop": { stop: null },
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl, { runtime }) => {
      // Stop accepts an empty body.
      const response = await postJson(modelUrl(baseUrl, "Clean Stop", "stop"));
      assert.equal(response.status, 202);
      const accepted = await response.json();
      assert.equal(accepted.kind, "stop");
      assert.equal(accepted.desiredState, "stopped");
      const succeeded = await waitForOperation(baseUrl, accepted.operationId);
      assert.equal(succeeded.status, "succeeded");
      await readFile(join(fixture.workspaces["Clean Stop"], "stopped"));
      const { body: stopped } = await getJson(modelUrl(baseUrl, "Clean Stop", "status"));
      assert.equal(stopped.model.desiredState, "stopped");
      assert.equal(stopped.model.lifecycleState, "stopped");

      runtime.set("Failing Stop", [container("still-up")]);
      const failingId = (await (await postJson(modelUrl(baseUrl, "Failing Stop", "stop"), {})).json()).operationId;
      const failing = await waitForOperation(baseUrl, failingId);
      assert.equal(failing.error.code, "STOP_COMMAND_FAILED");
      assert.equal(failing.error.exitCode, 4);
      assert.equal(failing.error.retrySafe, false, "containers remain");

      runtime.set("Failing Stop", []);
      const goneId = (await (await postJson(modelUrl(baseUrl, "Failing Stop", "stop"), {})).json()).operationId;
      assert.equal((await waitForOperation(baseUrl, goneId)).error.retrySafe, true, "containers are gone");

      const missingId = (await (await postJson(modelUrl(baseUrl, "No Stop", "stop"), {})).json()).operationId;
      const missing = await waitForOperation(baseUrl, missingId);
      assert.equal(missing.error.code, "STOP_COMMAND_UNAVAILABLE");
      assert.equal(missing.error.retrySafe, true);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("only one operation runs at a time", async () => {
  const fixture = await createFixture({
    "First Model": { start: WAIT_FOR_RELEASE },
    "Second Model": {},
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const responses = await Promise.all([
        postJson(modelUrl(baseUrl, "First Model", "start"), {}),
        postJson(modelUrl(baseUrl, "First Model", "start"), {}),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
      const accepted = await responses.find((response) => response.status === 202).json();
      const rejected = await responses.find((response) => response.status === 409).json();
      assert.deepEqual(rejected.error, {
        code: "OPERATION_IN_PROGRESS",
        message: 'A start operation is already in progress for "First Model".',
        activeOperationId: accepted.operationId,
        activeModel: "First Model",
      });

      const busy = await postJson(modelUrl(baseUrl, "Second Model", "stop"), {});
      assert.equal(busy.status, 409);
      const { error } = await busy.json();
      assert.equal(error.code, "LIFECYCLE_BUSY");
      assert.equal(error.activeOperationId, accepted.operationId);

      await writeFile(join(fixture.workspaces["First Model"], "release"), "");
      await waitForOperation(baseUrl, accepted.operationId);
      const after = await postJson(modelUrl(baseUrl, "Second Model", "stop"), {});
      assert.equal(after.status, 202);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("another running model needs switchRunning, which stops it first", async () => {
  const fixture = await createFixture({
    "First Model": { stop: "echo stop-first >> ../order.txt" },
    "Second Model": { start: "echo start-second >> ../order.txt" },
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl, { runtime }) => {
      runtime.set("First Model", [container("first")]);
      const conflict = await postJson(modelUrl(baseUrl, "Second Model", "start"), {});
      assert.equal(conflict.status, 409);
      const { error } = await conflict.json();
      assert.equal(error.code, "MODEL_ALREADY_RUNNING");
      assert.deepEqual(error.runningModels.map((model) => model.displayName), ["First Model"]);

      const { operationId } = await (
        await postJson(modelUrl(baseUrl, "Second Model", "start"), { switchRunning: true })
      ).json();
      const operation = await waitForOperation(baseUrl, operationId);
      assert.equal(operation.status, "succeeded");
      assert.equal(
        await readFile(join(fixture.directory, "order.txt"), "utf8"),
        "stop-first\nstart-second\n",
      );
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a failed conflicting stop fails the start before launching", async () => {
  const fixture = await createFixture({
    "First Model": { stop: "exit 2" },
    "Second Model": { start: ": > started" },
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl, { runtime }) => {
      runtime.set("First Model", [container("first")]);
      const { operationId } = await (
        await postJson(modelUrl(baseUrl, "Second Model", "start"), { switchRunning: true })
      ).json();
      const operation = await waitForOperation(baseUrl, operationId);
      assert.equal(operation.error.code, "CONFLICTING_MODEL_STOP_FAILED");
      assert.match(operation.error.message, /"First Model"/);
      assert.equal(operation.error.retrySafe, true);
      await assert.rejects(readFile(join(fixture.workspaces["Second Model"], "started")));
    });
  } finally {
    await fixture.cleanup();
  }
});

test("start returns 503 when Docker can't be checked for other running models", async () => {
  const fixture = await createFixture({ "First Model": {}, "Second Model": {} });
  try {
    const runtime = new FakeRuntime();
    runtime.inspectError = "daemon unavailable";
    await withApi({ registryPath: fixture.registryPath, lifecycle: { runtime } }, async (baseUrl) => {
      const response = await postJson(modelUrl(baseUrl, "First Model", "start"), {});
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "RUNTIME_INSPECTION_FAILED");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("start returns 409 while the CLI holds the lifecycle lock", async () => {
  const fixture = await createFixture({ "Test Model": {} });
  try {
    const lockDirectory = join(fixture.directory, "lifecycle.lock");
    await mkdir(lockDirectory);
    // Any live PID counts as a holder; this test process stands in for the CLI.
    await writeFile(join(lockDirectory, "pid"), `${process.pid}\n`);
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const response = await postJson(modelUrl(baseUrl, "Test Model", "start"), {});
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "LIFECYCLE_LOCK_HELD");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("the lifecycle lock is held during an operation and released afterwards", async () => {
  const fixture = await createFixture({ "Test Model": { start: WAIT_FOR_RELEASE } });
  const lockPid = join(fixture.directory, "lifecycle.lock", "pid");
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const { operationId } = await (await postJson(modelUrl(baseUrl, "Test Model", "start"), {})).json();
      assert.equal((await readFile(lockPid, "utf8")).trim(), String(process.pid));
      await writeFile(join(fixture.workspaces["Test Model"], "release"), "");
      await waitForOperation(baseUrl, operationId);
      await assert.rejects(readFile(lockPid), { code: "ENOENT" });
    });
  } finally {
    await fixture.cleanup();
  }
});

test("lastError survives a later successful start", async () => {
  const fixture = await createFixture({ "Test Model": { start: "[ ! -f fail ]" } });
  const failMarker = join(fixture.workspaces["Test Model"], "fail");
  await writeFile(failMarker, "");
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const failedId = (await (await postJson(modelUrl(baseUrl, "Test Model", "start"), {})).json()).operationId;
      assert.equal((await waitForOperation(baseUrl, failedId)).status, "failed");

      await rm(failMarker);
      const succeededId = (await (await postJson(modelUrl(baseUrl, "Test Model", "start"), {})).json()).operationId;
      assert.equal((await waitForOperation(baseUrl, succeededId)).status, "succeeded");

      const { body } = await getJson(modelUrl(baseUrl, "Test Model", "status"));
      assert.equal(body.model.lifecycleState, "stopped");
      assert.equal(body.model.lastOperation.operationId, succeededId);
      assert.equal(body.model.lastError.operationId, failedId);
      assert.equal(body.model.lastError.code, "START_COMMAND_FAILED");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("passes launch option selections to start.sh", async () => {
  const fixture = await createFixture(
    { "Test Model": { start: 'printf "%s\\n" "$CONTEXT" > selected.txt' } },
    {
      "Test Model": {
        launchOptions: [{
          id: "context-profile",
          label: "Context profile",
          defaultChoice: "recipe-default",
          choices: [
            { id: "compact", label: "Compact", environment: { CONTEXT: "65536" } },
            { id: "recipe-default", label: "Default", environment: { CONTEXT: "262144" } },
          ],
        }],
      },
    },
  );
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const { operationId } = await (
        await postJson(modelUrl(baseUrl, "Test Model", "start"), {
          launchOptionSelections: { "context-profile": "compact" },
        })
      ).json();
      const operation = await waitForOperation(baseUrl, operationId);
      assert.equal(operation.status, "succeeded");
      assert.deepEqual(operation.options.launchOptionSelections, { "context-profile": "compact" });
      assert.equal(
        await readFile(join(fixture.workspaces["Test Model"], "selected.txt"), "utf8"),
        "65536\n",
      );

      const invalid = await postJson(modelUrl(baseUrl, "Test Model", "start"), {
        launchOptionSelections: { "context-profile": "huge" },
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "INVALID_LAUNCH_OPTIONS");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("validates names, operation IDs and request bodies", async () => {
  const fixture = await createFixture({ "Test Model": {} });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const cases = [
        [() => postJson(modelUrl(baseUrl, "bad\u0001name", "start"), {}), 400, "INVALID_MODEL_NAME"],
        [() => postJson(modelUrl(baseUrl, "x".repeat(257), "stop"), {}), 400, "INVALID_MODEL_NAME"],
        [() => fetch(modelUrl(baseUrl, "bad\nname", "status")), 400, "INVALID_MODEL_NAME"],
        [() => postJson(modelUrl(baseUrl, "Unknown", "start"), {}), 404, "MODEL_NOT_FOUND"],
        [() => postJson(modelUrl(baseUrl, "Unknown", "stop"), {}), 404, "MODEL_NOT_FOUND"],
        [() => postJson(modelUrl(baseUrl, "Test Model", "start"), { extra: 1 }), 400, "INVALID_REQUEST"],
        [() => postJson(modelUrl(baseUrl, "Test Model", "stop"), { allowForceKill: true }), 400, "INVALID_REQUEST"],
        [() => postJson(modelUrl(baseUrl, "Test Model", "stop"), []), 400, "INVALID_REQUEST"],
        [() => postJson(modelUrl(baseUrl, "Test Model", "start"), { switchRunning: "yes" }), 400, "INVALID_REQUEST"],
        [() => postJson(modelUrl(baseUrl, "Test Model", "start"), { launchOptionSelections: [] }), 400, "INVALID_REQUEST"],
        [() => postJson(modelUrl(baseUrl, "Test Model", "start"), { launchOptionSelections: { nope: "x" } }), 400, "INVALID_LAUNCH_OPTIONS"],
        [() => fetch(modelUrl(baseUrl, "Test Model", "stop"), { method: "POST" }), 415, "JSON_REQUIRED"],
        [() => fetch(`${baseUrl}/operations/not-an-id`), 400, "INVALID_OPERATION_ID"],
        [() => fetch(`${baseUrl}/operations/op_${"A".repeat(32)}`), 400, "INVALID_OPERATION_ID"],
        [() => fetch(`${baseUrl}/operations/op_${"0".repeat(32)}`), 404, "OPERATION_NOT_FOUND"],
      ];
      for (const [send, status, code] of cases) {
        const response = await send();
        const body = await response.json();
        assert.equal(response.status, status, `${code}: ${JSON.stringify(body)}`);
        assert.equal(body.error.code, code);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("logs requested and finished operations with IDs but no launch environment", async () => {
  const fixture = await createFixture(
    { "Test Model": {} },
    {
      "Test Model": {
        launchOptions: [{
          id: "auth",
          label: "Auth",
          defaultChoice: "on",
          choices: [{ id: "on", label: "On", environment: { HF_TOKEN: "literal-secret-value" } }],
        }],
      },
    },
  );
  const entries = [];
  const logger = {
    info: (message) => entries.push(JSON.parse(message)),
    warn: (message) => entries.push(JSON.parse(message)),
    error: (message) => entries.push(JSON.parse(message)),
  };
  try {
    await withApi({ registryPath: fixture.registryPath, logger }, async (baseUrl) => {
      const response = await postJson(modelUrl(baseUrl, "Test Model", "start"), {}, { "x-request-id": "req-1" });
      const { operationId } = await response.json();
      await waitForOperation(baseUrl, operationId);
      await waitUntil(() => entries, (all) => all.some((entry) => entry.event === "model.start.finished"));

      const requested = entries.find((entry) => entry.event === "model.start.requested");
      assert.deepEqual(
        [requested.requestId, requested.operationId, requested.displayName],
        ["req-1", operationId, "Test Model"],
      );
      const finished = entries.find((entry) => entry.event === "model.start.finished");
      assert.deepEqual(
        [finished.requestId, finished.operationId, finished.status],
        ["req-1", operationId, "succeeded"],
      );
      assert.equal(JSON.stringify(entries).includes("literal-secret-value"), false);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("every lifecycle route requires the bearer token", async () => {
  const fixture = await createFixture({ "Test Model": { start: ": > started", stop: ": > stopped" } });
  try {
    await withApi({ registryPath: fixture.registryPath, token: "test-secret" }, async (baseUrl) => {
      const requests = [
        () => postJson(modelUrl(baseUrl, "Test Model", "start"), {}),
        () => postJson(modelUrl(baseUrl, "Test Model", "stop"), {}),
        () => fetch(`${baseUrl}/operations/op_${"0".repeat(32)}`),
      ];
      for (const send of requests) {
        assert.equal((await send()).status, 401);
      }
      const workspace = fixture.workspaces["Test Model"];
      await assert.rejects(readFile(join(workspace, "started")));
      await assert.rejects(readFile(join(workspace, "stopped")));

      const authorized = await postJson(
        modelUrl(baseUrl, "Test Model", "start"),
        {},
        { authorization: "Bearer test-secret" },
      );
      assert.equal(authorized.status, 202);
    });
  } finally {
    await fixture.cleanup();
  }
});
