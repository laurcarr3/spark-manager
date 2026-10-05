import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getModelStatus,
  getRegisteredModel,
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

async function writeRegistry(directory, entries) {
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(entries));
  return registryPath;
}
