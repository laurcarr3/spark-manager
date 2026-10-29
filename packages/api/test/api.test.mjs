import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../dist/app.js";

test("lists models and reports status from Docker without running recipes", async () => {
  const fixture = await createFixture({
    "Test Model": "must-not-run\n",
    "Idle Model": "must-not-run\n",
  });
  for (const workspace of Object.values(fixture.workspaces)) {
    await writeExecutable(join(workspace, "start.sh"), "#!/bin/sh\n: > started.txt\n");
  }
  const restorePath = await installDockerStub(fixture.directory, [
    {
      Id: "unrelated",
      Mounts: [{ Source: fixture.directory }],
      State: { Running: true, Status: "running" },
    },
    {
      Id: "compose-id",
      Name: "/test-model",
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": fixture.workspaces["Test Model"],
        },
      },
      State: { Running: true, Status: "running", StartedAt: "2026-01-01T00:00:00Z" },
    },
  ]);

  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/models`);
      assert.equal(listResponse.status, 200);
      assert.deepEqual((await listResponse.json()).models[0], {
        displayName: "Test Model",
        workspaceDirectory: fixture.workspaces["Test Model"],
      });

      const allStatusResponse = await fetch(`${baseUrl}/models/status`);
      assert.equal(allStatusResponse.status, 200);
      const allStatus = await allStatusResponse.json();
      assert.deepEqual(
        allStatus.models.map((model) => [model.displayName, model.lifecycleState]),
        [
          ["Test Model", "running"],
          ["Idle Model", "stopped"],
        ],
      );

      const oneStatusResponse = await fetch(`${baseUrl}/models/Test%20Model/status`);
      assert.equal(oneStatusResponse.status, 200);
      assert.deepEqual(await oneStatusResponse.json(), {
        model: {
          displayName: "Test Model",
          lifecycleState: "running",
          runtime: {
            observed: true,
            present: true,
            containers: [
              {
                id: "compose-id",
                name: "test-model",
                running: true,
                restarting: false,
                status: "running",
                exitCode: null,
                oomKilled: false,
                restartCount: 0,
                startedAt: "2026-01-01T00:00:00Z",
                finishedAt: null,
              },
            ],
            error: null,
          },
        },
      });
    });
    for (const workspace of Object.values(fixture.workspaces)) {
      await assert.rejects(readFile(join(workspace, "started.txt")));
    }
  } finally {
    restorePath();
    await fixture.cleanup();
  }
});

test("status reports an unobserved runtime when Docker fails or is missing", async () => {
  const fixture = await createFixture({ "Test Model": "must-not-run\n" });
  const originalPath = process.env.PATH;
  const binDirectory = join(fixture.directory, "bin");
  await mkdir(binDirectory);
  await writeExecutable(
    join(binDirectory, "docker"),
    "#!/bin/sh\necho 'daemon unavailable' >&2\nexit 1\n",
  );
  const emptyDirectory = join(fixture.directory, "empty");
  await mkdir(emptyDirectory);

  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      process.env.PATH = `${binDirectory}:${originalPath}`;
      const failingResponse = await fetch(`${baseUrl}/models/status`);
      assert.equal(failingResponse.status, 200);
      const [failing] = (await failingResponse.json()).models;
      assert.equal(failing.lifecycleState, "unknown");
      assert.deepEqual(failing.runtime, {
        observed: false,
        present: false,
        containers: [],
        error: "Unable to query Docker: daemon unavailable",
      });

      process.env.PATH = emptyDirectory;
      const missingResponse = await fetch(`${baseUrl}/models/Test%20Model/status`);
      assert.equal(missingResponse.status, 200);
      const { model } = await missingResponse.json();
      assert.equal(model.lifecycleState, "unknown");
      assert.equal(model.runtime.observed, false);
      assert.match(model.runtime.error, /^Unable to query Docker: /);
    });
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("status for an unknown model returns 404 without the registry path", async () => {
  const fixture = await createFixture({ "Test Model": "must-not-run\n" });
  await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/models/Unknown/status`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "MODEL_NOT_FOUND", message: 'Unknown model "Unknown".' },
    });
  });
  await fixture.cleanup();
});

test("status uses an injected runtime", async () => {
  const fixture = await createFixture({ "Test Model": "must-not-run\n" });
  const runtime = {
    inspect: async (workspaces) =>
      new Map(
        workspaces.map((workspace) => [
          workspace.displayName,
          [{ id: "injected", name: "injected", running: true }],
        ]),
      ),
    kill: async () => {},
  };
  await withApi(
    { registryPath: fixture.registryPath, lifecycle: { runtime } },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/models/status`);
      const { models } = await response.json();
      assert.equal(models[0].lifecycleState, "running");
      assert.equal(models[0].runtime.containers[0].id, "injected");
    },
  );
  await fixture.cleanup();
});

test("logs correlated request metadata without exposing authorization", async () => {
  const fixture = await createFixture({ "Test Model": "stopped\n" });
  const entries = [];
  const logger = {
    info: (message) => entries.push(JSON.parse(message)),
    warn: (message) => entries.push(JSON.parse(message)),
    error: (message) => entries.push(JSON.parse(message)),
  };
  const lifecycle = { runtime: emptyRuntime() };
  await withApi({ logger, lifecycle, registryPath: fixture.registryPath }, async (baseUrl) => {
    const quietResponse = await fetch(`${baseUrl}/models/status`);
    assert.equal(quietResponse.status, 200);
    assert.equal(entries.length, 0);

    const response = await fetch(`${baseUrl}/models/Test%20Model/start`, {
      method: "POST",
      headers: {
        authorization: "Bearer must-not-be-logged",
        "content-type": "application/json",
        "x-request-id": "browser-123",
      },
      body: "{}",
    });
    assert.equal(response.headers.get("x-request-id"), "browser-123");
    assert.equal(response.status, 200);
  });

  assert.equal(entries[0].event, "request.started");
  assert.equal(entries[0].requestId, "browser-123");
  assert.equal(entries[0].authorizationPresent, true);
  assert.equal(entries.at(-1).event, "request.completed");
  assert.equal(entries.at(-1).status, 200);
  assert.equal(JSON.stringify(entries).includes("must-not-be-logged"), false);
  await fixture.cleanup();
});

test("reports running models without invoking recipe status commands", async () => {
  const fixture = await createFixture({ "Test Model": "must-not-run\n" });
  const originalPath = process.env.PATH;
  const binDirectory = join(fixture.directory, "bin");
  await mkdir(binDirectory);
  await writeExecutable(
    join(binDirectory, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  ps) printf '%s\\n' container-id ;;",
      `  inspect) printf '%s' '${JSON.stringify([{
        Id: "container-id",
        Config: { Labels: {} },
        Mounts: [{ Source: fixture.workspaces["Test Model"] }],
        State: { Running: true },
      }])}' ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  process.env.PATH = `${binDirectory}:${originalPath}`;

  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/models/running`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.models[0].displayName, "Test Model");
    });
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("starts and stops a registered model", async () => {
  const fixture = await createFixture({ "Test Model": "stopped\n" });
  const workspace = fixture.workspaces["Test Model"];
  await writeExecutable(
    join(workspace, "start.sh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "ps" ]; then printf "stopped\\n"; exit; fi',
      'printf "started\\n" > started.txt',
      "",
    ].join("\n"),
  );
  await writeExecutable(
    join(workspace, "stop.sh"),
    '#!/bin/sh\nprintf "stopped\\n" > stopped.txt\n',
  );

  await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
    const startResponse = await postJson(
      `${baseUrl}/models/Test%20Model/start`,
      {},
    );
    assert.equal(startResponse.status, 200);
    assert.equal(await readFile(join(workspace, "started.txt"), "utf8"), "started\n");

    const stopResponse = await fetch(`${baseUrl}/models/Test%20Model/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(stopResponse.status, 200);
    assert.equal(await readFile(join(workspace, "stopped.txt"), "utf8"), "stopped\n");
  });
  await fixture.cleanup();
});

test("passes registry launch option selections to the recipe", async () => {
  const fixture = await createFixture({ "Test Model": "stopped\n" });
  const workspace = fixture.workspaces["Test Model"];
  await writeFile(
    fixture.registryPath,
    JSON.stringify({
      "Test Model": {
        workspaceDirectory: workspace,
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
    }),
  );
  await writeExecutable(
    join(workspace, "start.sh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "ps" ]; then printf "stopped\\n"; exit; fi',
      'printf "%s\\n" "$CONTEXT" > selected.txt',
      "",
    ].join("\n"),
  );

  await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/models/Test%20Model/start`, {
      launchOptionSelections: { "context-profile": "compact" },
    });
    assert.equal(response.status, 200);
    assert.equal(await readFile(join(workspace, "selected.txt"), "utf8"), "65536\n");
  });
  await fixture.cleanup();
});

test("requires JSON for mutations and validates start options", async () => {
  const fixture = await createFixture({ "Test Model": "stopped\n" });
  await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
    const contentTypeResponse = await fetch(
      `${baseUrl}/models/Test%20Model/start`,
      { method: "POST" },
    );
    assert.equal(contentTypeResponse.status, 415);

    const invalidOptionResponse = await postJson(
      `${baseUrl}/models/Test%20Model/start`,
      { switchRunning: "yes" },
    );
    assert.equal(invalidOptionResponse.status, 400);
    assert.deepEqual(await invalidOptionResponse.json(), {
      error: {
        code: "INVALID_REQUEST",
        message: "switchRunning must be a boolean.",
      },
    });

    const invalidSelectionsResponse = await postJson(
      `${baseUrl}/models/Test%20Model/start`,
      { launchOptionSelections: [] },
    );
    assert.equal(invalidSelectionsResponse.status, 400);
  });
  await fixture.cleanup();
});

test("reports a conflict or switches away from a running model", async () => {
  const fixture = await createFixture({
    "First Model": "running\n",
    "Second Model": "stopped\n",
  });
  const firstWorkspace = fixture.workspaces["First Model"];
  const secondWorkspace = fixture.workspaces["Second Model"];
  await writeExecutable(
    join(firstWorkspace, "stop.sh"),
    '#!/bin/sh\nprintf "stopped\\n" > stopped.txt\n',
  );
  await writeExecutable(
    join(secondWorkspace, "start.sh"),
    [
      "#!/bin/sh",
      'if [ "$1" = "ps" ]; then printf "stopped\\n"; exit; fi',
      'printf "started\\n" > started.txt',
      "",
    ].join("\n"),
  );
  const originalPath = process.env.PATH;
  const binDirectory = join(fixture.directory, "bin");
  await mkdir(binDirectory);
  await writeExecutable(
    join(binDirectory, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  ps) printf '%s\\n' container-id ;;",
      `  inspect) printf '%s' '${JSON.stringify([
        {
          Id: "container-id",
          Config: { Labels: {} },
          Mounts: [{ Source: firstWorkspace }],
          State: { Running: true },
        },
      ])}' ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  process.env.PATH = `${binDirectory}:${originalPath}`;

  try {
    await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
      const conflictResponse = await postJson(
        `${baseUrl}/models/Second%20Model/start`,
        {},
      );
      assert.equal(conflictResponse.status, 409);
      const conflict = await conflictResponse.json();
      assert.equal(conflict.error.code, "MODEL_ALREADY_RUNNING");
      assert.equal(conflict.error.runningModels[0].displayName, "First Model");

      const switchResponse = await postJson(
        `${baseUrl}/models/Second%20Model/start`,
        { switchRunning: true },
      );
      assert.equal(switchResponse.status, 200);
      assert.equal(
        await readFile(join(firstWorkspace, "stopped.txt"), "utf8"),
        "stopped\n",
      );
      assert.equal(
        await readFile(join(secondWorkspace, "started.txt"), "utf8"),
        "started\n",
      );
    });
  } finally {
    process.env.PATH = originalPath;
    await fixture.cleanup();
  }
});

test("supports bearer-token authentication", async () => {
  const fixture = await createFixture({ "Test Model": "running\n" });
  await withApi(
    { registryPath: fixture.registryPath, token: "test-secret" },
    async (baseUrl) => {
      const unauthorizedResponse = await fetch(`${baseUrl}/models`);
      assert.equal(unauthorizedResponse.status, 401);

      for (const path of ["/models/status", "/models/Test%20Model/status"]) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, 401, path);
      }

      const authorizedResponse = await fetch(`${baseUrl}/models`, {
        headers: { authorization: "Bearer test-secret" },
      });
      assert.equal(authorizedResponse.status, 200);
    },
  );
  await fixture.cleanup();
});

async function createFixture(statuses) {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-api-test-"));
  const workspaces = {};
  const registry = {};
  for (const [displayName, status] of Object.entries(statuses)) {
    const workspace = join(
      directory,
      displayName.toLowerCase().replaceAll(" ", "-"),
    );
    await mkdir(workspace);
    await writeExecutable(
      join(workspace, "start.sh"),
      `#!/bin/sh\nprintf ${JSON.stringify(status)}\n`,
    );
    workspaces[displayName] = workspace;
    registry[displayName] = { workspaceDirectory: workspace };
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

function emptyRuntime() {
  return {
    inspect: async (workspaces) =>
      new Map(workspaces.map((workspace) => [workspace.displayName, []])),
    kill: async () => {},
  };
}

/** Puts a fake `docker` first on PATH that reports the given inspections; returns a restore function. */
async function installDockerStub(directory, inspections) {
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory);
  await writeExecutable(
    join(binDirectory, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      `  ps) printf '%s\\n' ${inspections.map((inspection) => inspection.Id).join(" ")} ;;`,
      `  inspect) printf '%s' '${JSON.stringify(inspections)}' ;;`,
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}:${originalPath}`;
  return () => {
    process.env.PATH = originalPath;
  };
}

async function withApi(options, run) {
  const server = createApp({ logger: false, ...options }).listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
