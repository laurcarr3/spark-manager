import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DockerRuntimeController,
  getModelStatuses,
  getRegisteredModel,
  getRegisteredModelStatus,
  resolveLaunchEnvVariables,
} from "../dist/index.js";

test("getModelStatuses derives state from the runtime without running recipes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const runningWorkspace = join(directory, "running");
    const exitedWorkspace = join(directory, "exited");
    for (const workspace of [runningWorkspace, exitedWorkspace]) {
      await mkdir(workspace);
      await writeFile(join(workspace, "start.sh"), "#!/bin/sh\n: > started.txt\n", { mode: 0o755 });
    }
    const registryPath = await writeRegistry(directory, {
      "Running Model": { workspaceDirectory: runningWorkspace },
      "Exited Model": { workspaceDirectory: exitedWorkspace },
    });
    const runtime = fakeRuntime({
      "Running Model": [container("c1")],
      "Exited Model": [
        container("c2", { running: false, status: "exited", exitCode: 137 }),
      ],
    });

    const statuses = await getModelStatuses(registryPath, runtime);

    assert.deepEqual(
      statuses.map((status) => [
        status.displayName,
        status.lifecycleState,
        status.runtime.present,
      ]),
      [
        ["Running Model", "running", true],
        ["Exited Model", "stopped", false],
      ],
    );
    assert.equal(statuses[1].runtime.containers[0].exitCode, 137);
    await assert.rejects(readFile(join(runningWorkspace, "started.txt")));
    await assert.rejects(readFile(join(exitedWorkspace, "started.txt")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("getModelStatuses reports unknown when the runtime cannot be observed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {
      "Test Model": { workspaceDirectory: directory },
    });
    const runtime = {
      inspect: async () => {
        throw new Error("Unable to query Docker: daemon unavailable");
      },
      kill: async () => {},
    };

    assert.deepEqual(await getModelStatuses(registryPath, runtime), [
      {
        displayName: "Test Model",
        lifecycleState: "unknown",
        runtime: {
          observed: false,
          present: false,
          containers: [],
          error: "Unable to query Docker: daemon unavailable",
        },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("getRegisteredModelStatus inspects one model and rejects unknown names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {
      "Test Model": { workspaceDirectory: directory },
    });
    const inspected = [];
    const runtime = fakeRuntime({ "Test Model": [container("c1")] }, inspected);

    const status = await getRegisteredModelStatus("Test Model", registryPath, runtime);
    assert.equal(status.lifecycleState, "running");
    assert.deepEqual(inspected, [["Test Model"]]);

    await assert.rejects(
      getRegisteredModelStatus("Unknown", registryPath, runtime),
      (error) =>
        error instanceof Error &&
        error.message.includes('Unknown display name "Unknown"'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DockerRuntimeController matches containers to workspaces and parses state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  const originalPath = process.env.PATH;
  try {
    const mountWorkspace = join(directory, "mount");
    const composeWorkspace = join(directory, "compose");
    const unrelatedDirectory = join(directory, "unrelated");
    for (const path of [mountWorkspace, composeWorkspace, unrelatedDirectory]) {
      await mkdir(path);
    }
    const inspections = [
      {
        Id: "old-mount",
        Name: "/old-mount",
        Mounts: [{ Source: join(mountWorkspace, ".cache") }],
        State: {
          Running: false,
          Status: "exited",
          ExitCode: 137,
          OOMKilled: true,
          StartedAt: "2026-01-01T00:00:00Z",
          FinishedAt: "2026-01-01T01:00:00Z",
        },
      },
      {
        Id: "new-mount",
        Name: "/new-mount",
        RestartCount: 2,
        Mounts: [{ Source: mountWorkspace }],
        State: {
          Running: true,
          Status: "running",
          ExitCode: 0,
          StartedAt: "2026-02-01T00:00:00Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        },
      },
      {
        Id: "compose",
        Config: {
          Labels: { "com.docker.compose.project.working_dir": composeWorkspace },
        },
        State: { Running: true, Status: "running" },
      },
      {
        Id: "unrelated",
        Mounts: [{ Source: unrelatedDirectory }, { Source: `${mountWorkspace}-sibling` }],
        State: { Running: true, Status: "running" },
      },
      {
        Id: "named",
        Name: "/named-server",
        Mounts: [{ Source: join(directory, "cache") }],
        State: { Running: true, Status: "running" },
      },
      { Name: "/missing-id" },
    ];
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    await writeFile(
      join(binDirectory, "docker"),
      [
        "#!/bin/sh",
        'case "$1" in',
        "  ps) printf '%s\\n' old-mount new-mount compose unrelated named ;;",
        `  inspect) printf '%s' '${JSON.stringify(inspections)}' ;;`,
        "  *) exit 2 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${binDirectory}:${originalPath}`;

    const result = await new DockerRuntimeController().inspect([
      { displayName: "Mount Model", workspaceDirectory: mountWorkspace },
      { displayName: "Compose Model", workspaceDirectory: composeWorkspace },
      { displayName: "Missing Model", workspaceDirectory: join(directory, "missing") },
      {
        displayName: "Named Model",
        workspaceDirectory: join(directory, "missing"),
        containerNames: ["named-server"],
      },
    ]);

    assert.deepEqual(result.get("Mount Model"), [
      {
        id: "new-mount",
        name: "new-mount",
        running: true,
        restarting: false,
        status: "running",
        exitCode: null,
        oomKilled: false,
        restartCount: 2,
        startedAt: "2026-02-01T00:00:00Z",
        finishedAt: null,
      },
      {
        id: "old-mount",
        name: "old-mount",
        running: false,
        restarting: false,
        status: "exited",
        exitCode: 137,
        oomKilled: true,
        restartCount: 0,
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T01:00:00Z",
      },
    ]);
    assert.deepEqual(
      result.get("Compose Model").map((container) => container.id),
      ["compose"],
    );
    assert.deepEqual(result.get("Missing Model"), []);
    assert.deepEqual(
      result.get("Named Model").map((container) => container.id),
      ["named"],
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the registry requires valid workspaceDirectory values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {
      "Test Model": { workspaceDirectory: "" },
    });
    await assert.rejects(
      getRegisteredModel("Test Model", registryPath),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          'model "Test Model" must have a non-empty workspaceDirectory string',
        ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the registry accepts containerNames and rejects invalid names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {
      "Test Model": { workspaceDirectory: directory, containerNames: ["qwen38-flash-next-tf"] },
      "Bad Model": { workspaceDirectory: directory, containerNames: ["/bad name"] },
    });
    assert.deepEqual(
      (await getRegisteredModel("Test Model", registryPath).catch((error) => error)).message,
      'Invalid model registry ' + registryPath + ': model "Bad Model" containerNames must be an array of Docker container names.',
    );

    await writeRegistry(directory, {
      "Test Model": { workspaceDirectory: directory, containerNames: ["qwen38-flash-next-tf"] },
    });
    assert.deepEqual(
      (await getRegisteredModel("Test Model", registryPath)).containerNames,
      ["qwen38-flash-next-tf"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry launch options resolve defaults and explicit selections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {
      "Test Model": {
        workspaceDirectory: directory,
        launchOptions: [
          {
            id: "context",
            label: "Context window",
            defaultChoice: "balanced",
            choices: [
              {
                id: "compact",
                label: "Compact",
                environment: {
                  MAX_MODEL_LEN: "65536",
                  CACHE_PROFILE: "compact",
                },
              },
              {
                id: "balanced",
                label: "Balanced",
                environment: {
                  MAX_MODEL_LEN: "131072",
                  CACHE_PROFILE: "balanced",
                },
              },
            ],
          },
        ],
      },
    });
    const model = await getRegisteredModel("Test Model", registryPath);

    assert.deepEqual(resolveLaunchEnvVariables(model), {
      MAX_MODEL_LEN: "131072",
      CACHE_PROFILE: "balanced",
    });
    assert.deepEqual(resolveLaunchEnvVariables(model, { context: "compact" }), {
      MAX_MODEL_LEN: "65536",
      CACHE_PROFILE: "compact",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry launch options reject invalid defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {
      "Test Model": {
        workspaceDirectory: directory,
        launchOptions: [
          {
            id: "context",
            label: "Context window",
            defaultChoice: "missing",
            choices: [
              {
                id: "compact",
                label: "Compact",
                environment: { MAX_MODEL_LEN: "65536" },
              },
            ],
          },
        ],
      },
    });

    await assert.rejects(
      getRegisteredModel("Test Model", registryPath),
      (error) =>
        error instanceof Error &&
        error.message.includes("defaultChoice must match a choice id"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeRegistry(directory, entries) {
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(entries));
  return registryPath;
}

function fakeRuntime(containersByModel, inspected = []) {
  return {
    async inspect(workspaces) {
      inspected.push(workspaces.map((workspace) => workspace.displayName));
      return new Map(
        workspaces.map((workspace) => [
          workspace.displayName,
          structuredClone(containersByModel[workspace.displayName] ?? []),
        ]),
      );
    },
    async kill() {},
  };
}

function container(id, overrides = {}) {
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
