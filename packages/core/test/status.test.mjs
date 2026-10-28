import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getModelStatus,
  getRegisteredModel,
  resolveLaunchEnvironment,
} from "../dist/index.js";

test("getModelStatus runs the command in the registered workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));

  try {
    const result = await getModelStatus({
      displayName: "Test Model",
      registryPath: await writeRegistry(directory, {
        "Test Model": { workspaceDirectory: directory },
      }),
      command: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, directory);
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("getModelStatus rejects an invalid workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  const registryPath = await writeRegistry(directory, {
    "Missing Model": {
      workspaceDirectory: "/path/that/does/not/exist",
    },
  });
  await assert.rejects(
    getModelStatus({ displayName: "Missing Model", registryPath }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Invalid workspace /path/that/does/not/exist"),
  );
  await rm(directory, { recursive: true, force: true });
});

test("getModelStatus rejects an unknown display name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));
  try {
    const registryPath = await writeRegistry(directory, {});
    await assert.rejects(
      getModelStatus({ displayName: "Unknown", registryPath }),
      (error) =>
        error instanceof Error &&
        error.message.includes('Unknown display name "Unknown"'),
    );
  } finally {
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

    assert.deepEqual(resolveLaunchEnvironment(model), {
      MAX_MODEL_LEN: "131072",
      CACHE_PROFILE: "balanced",
    });
    assert.deepEqual(resolveLaunchEnvironment(model, { context: "compact" }), {
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
