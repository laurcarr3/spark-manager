import assert from "node:assert/strict";
import test from "node:test";

import {
  container,
  createFixture,
  getJson,
  modelUrl,
  postJson,
  waitUntil,
  withApi,
} from "./helpers.mjs";

const API_TOKEN = "api-token-value-123456";
const AUTH = { authorization: `Bearer ${API_TOKEN}` };
const HF_TOKEN_OPTION = {
  launchOptions: [{
    id: "auth",
    label: "Auth",
    defaultChoice: "on",
    choices: [{ id: "on", label: "On", environment: { HF_TOKEN: "literal-secret-value", CONTEXT: "65536" } }],
  }],
};

async function startAndWait(baseUrl, displayName, headers = {}) {
  const response = await postJson(modelUrl(baseUrl, displayName, "start"), {}, headers);
  assert.equal(response.status, 202);
  const { operationId } = await response.json();
  const { body } = await waitUntil(
    () => getJson(`${baseUrl}/operations/${operationId}`, headers),
    ({ body }) => ["succeeded", "failed"].includes(body.operation?.status),
  );
  return body.operation;
}

function logsUrl(baseUrl, displayName, query = "") {
  return `${modelUrl(baseUrl, displayName, "logs")}${query}`;
}

test("logs capture recipe output with secrets redacted", async () => {
  const fixture = await createFixture(
    {
      "Test Model": {
        start: [
          'echo "token is $HF_TOKEN"',
          "echo 'Authorization: Bearer abcdefgh12345678' >&2",
          `echo "api ${API_TOKEN}"`,
          "printf 'progress 1\\rprogress 2\\n'",
          "exit 3",
        ].join("\n"),
      },
    },
    { "Test Model": HF_TOKEN_OPTION },
  );
  try {
    await withApi({ registryPath: fixture.registryPath, token: API_TOKEN }, async (baseUrl) => {
      const operation = await startAndWait(baseUrl, "Test Model", AUTH);
      assert.equal(operation.status, "failed");

      const { status, body } = await getJson(logsUrl(baseUrl, "Test Model"), AUTH);
      assert.equal(status, 200);
      assert.equal(body.displayName, "Test Model");
      assert.equal(body.operationId, operation.operationId);
      assert.equal(body.operationKind, "start");
      assert.equal(body.operationStatus, "failed");
      assert.equal(body.truncated, false);
      assert.equal(body.hasMore, false);
      assert.deepEqual(body.lines.map((line) => line.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
      const textOf = (stream) => body.lines.filter((line) => line.stream === stream).map((line) => line.text);
      assert.deepEqual(textOf("manager"), [
        'Running ./start.sh for "Test Model".',
        "./start.sh exited with status 3.",
        "Start failed (START_COMMAND_FAILED): The start command exited with status 3.",
      ]);
      assert.deepEqual(textOf("stdout"), ["token is [REDACTED]", "api [REDACTED]", "progress 1", "progress 2"]);
      assert.deepEqual(textOf("stderr"), ["Authorization: Bearer [REDACTED]"]);
      assert.equal(body.nextAfter, 8);
      assert.deepEqual(operation.error.logTail, body.lines.map((line) => line.text));

      const { body: modelStatus } = await getJson(modelUrl(baseUrl, "Test Model", "status"), AUTH);
      const everything = JSON.stringify([body, operation, modelStatus]);
      for (const secret of ["literal-secret-value", API_TOKEN, "abcdefgh12345678"]) {
        assert.equal(everything.includes(secret), false, secret);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("logs page with after and limit, and report evicted lines", async () => {
  const fixture = await createFixture({
    "Test Model": { start: "i=1; while [ $i -le 2100 ]; do echo \"line $i\"; i=$((i+1)); done" },
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const first = await startAndWait(baseUrl, "Test Model");
      // 1 manager line + 2100 output lines + 1 manager line, capped at 2000.
      const { body: oldest } = await getJson(logsUrl(baseUrl, "Test Model", "?limit=3"));
      assert.deepEqual(oldest.lines.map((line) => line.seq), [103, 104, 105]);
      assert.equal(oldest.lines[0].text, "line 102");
      assert.equal(oldest.truncated, true);
      assert.equal(oldest.hasMore, true);
      assert.equal(oldest.nextAfter, 105);

      const { body: next } = await getJson(logsUrl(baseUrl, "Test Model", `?after=${oldest.nextAfter}&limit=2`));
      assert.deepEqual(next.lines.map((line) => line.seq), [106, 107]);
      assert.equal(next.truncated, false);

      const { body: retained } = await getJson(logsUrl(baseUrl, "Test Model", "?after=102&limit=1"));
      assert.equal(retained.truncated, false, "nothing after 102 was evicted");

      const { body: end } = await getJson(logsUrl(baseUrl, "Test Model", "?after=2102"));
      assert.deepEqual(end.lines, []);
      assert.equal(end.nextAfter, 2102);
      assert.equal(end.hasMore, false);

      // A new operation starts a new log whose seq continues, so an old
      // cursor simply gets the new operation's lines. Its first 102 lines
      // (2103 to 2204) were evicted too.
      const second = await startAndWait(baseUrl, "Test Model");
      const { body: secondLog } = await getJson(logsUrl(baseUrl, "Test Model", "?after=2102&limit=1"));
      assert.notEqual(second.operationId, first.operationId);
      assert.equal(secondLog.operationId, second.operationId);
      assert.deepEqual(secondLog.lines.map((line) => [line.seq, line.text]), [[2205, "line 102"]]);
      assert.equal(secondLog.truncated, true);

      // A cursor beyond anything issued (from an earlier API run) starts over.
      const { body: stale } = await getJson(logsUrl(baseUrl, "Test Model", "?after=999999999&limit=1"));
      assert.equal(stale.lines[0].seq, 2205);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("a switchRunning start logs the conflicting model's stop in its own log", async () => {
  const fixture = await createFixture({
    "Wanted Model": { start: "echo wanted-up" },
    "Other Model": { stop: "echo other-down" },
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl, { runtime }) => {
      runtime.set("Other Model", [container("other")]);
      const response = await postJson(modelUrl(baseUrl, "Wanted Model", "start"), { switchRunning: true });
      const { operationId } = await response.json();
      await waitUntil(
        () => getJson(`${baseUrl}/operations/${operationId}`),
        ({ body }) => body.operation.status === "succeeded",
      );
      const { body } = await getJson(logsUrl(baseUrl, "Wanted Model"));
      assert.deepEqual(body.lines.map((line) => line.text), [
        'Stopping conflicting model "Other Model".',
        'Running ./stop.sh for "Other Model".',
        "other-down",
        "./stop.sh exited with status 0.",
        'Running ./start.sh for "Wanted Model".',
        "wanted-up",
        "./start.sh exited with status 0.",
      ]);
      const { body: other } = await getJson(logsUrl(baseUrl, "Other Model"));
      assert.equal(other.operationId, null);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("logTail keeps the last 50 lines", async () => {
  const fixture = await createFixture({
    "Test Model": { start: "i=1; while [ $i -le 80 ]; do echo \"line $i\"; i=$((i+1)); done\nexit 1" },
  });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const operation = await startAndWait(baseUrl, "Test Model");
      assert.equal(operation.error.logTail.length, 50);
      assert.equal(operation.error.logTail[0], "line 33");
      assert.equal(operation.error.logTail.at(-1).startsWith("Start failed (START_COMMAND_FAILED)"), true);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("logs before any operation, for unknown models and with invalid queries", async () => {
  const fixture = await createFixture({ "Test Model": {} });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const { status, body } = await getJson(logsUrl(baseUrl, "Test Model"));
      assert.equal(status, 200);
      assert.deepEqual(body, {
        displayName: "Test Model",
        operationId: null,
        operationKind: null,
        operationStatus: null,
        lines: [],
        nextAfter: 0,
        truncated: false,
        hasMore: false,
      });

      const missing = await getJson(logsUrl(baseUrl, "Missing"));
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, "MODEL_NOT_FOUND");

      for (const query of [
        "?after=-1",
        "?after=abc",
        "?after=",
        "?after=1.5",
        "?after=1&after=2",
        "?limit=0",
        "?limit=1001",
        "?limit=",
        "?other=1",
        "?after[x]=1",
      ]) {
        const response = await getJson(logsUrl(baseUrl, "Test Model", query));
        assert.equal(response.status, 400, query);
        assert.equal(response.body.error.code, "INVALID_LOG_QUERY", query);
      }
      assert.equal((await getJson(logsUrl(baseUrl, "Test Model", "?after=0&limit=1000"))).status, 200);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("model listings mask secret-named launch environment values", async () => {
  const fixture = await createFixture({ "Test Model": {} }, { "Test Model": HF_TOKEN_OPTION });
  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl, { runtime }) => {
      runtime.set("Test Model", [container("c1")]);
      for (const path of ["/models", "/models/running"]) {
        const { status, body } = await getJson(`${baseUrl}${path}`);
        assert.equal(status, 200, path);
        assert.deepEqual(body.models[0].launchOptions[0].choices[0].environment, {
          HF_TOKEN: "[REDACTED]",
          CONTEXT: "65536",
        }, path);
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

test("the logs route requires the bearer token", async () => {
  const fixture = await createFixture({ "Test Model": {} });
  try {
    await withApi({ registryPath: fixture.registryPath, token: API_TOKEN }, async (baseUrl) => {
      assert.equal((await fetch(logsUrl(baseUrl, "Test Model"))).status, 401);
      assert.equal((await fetch(logsUrl(baseUrl, "Test Model"), { headers: AUTH })).status, 200);
    });
  } finally {
    await fixture.cleanup();
  }
});
