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

test("lists models and reports status for all or one model", async () => {
  const fixture = await createFixture({ "Test Model": "running\n" });
  await withApi({ registryPath: fixture.registryPath }, async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/models`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), {
      models: [
        {
          displayName: "Test Model",
          workspaceDirectory: fixture.workspaces["Test Model"],
        },
      ],
    });

    const allStatusResponse = await fetch(`${baseUrl}/models/status`);
    assert.equal(allStatusResponse.status, 200);
    const allStatus = await allStatusResponse.json();
    assert.equal(allStatus.models[0].command.stdout, "running\n");

    const oneStatusResponse = await fetch(
      `${baseUrl}/models/Test%20Model/status`,
    );
    assert.equal(oneStatusResponse.status, 200);
    const oneStatus = await oneStatusResponse.json();
    assert.equal(oneStatus.model.displayName, "Test Model");
    assert.equal(oneStatus.model.command.exitCode, 0);
  });
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
  await withApi({ logger, registryPath: fixture.registryPath }, async (baseUrl) => {
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
        Config: { Labels: {} },
        Mounts: [{ Source: fixture.workspaces["Test Model"] }],
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
          Config: { Labels: {} },
          Mounts: [{ Source: firstWorkspace }],
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
