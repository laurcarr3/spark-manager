import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getModelStatus, ModelCommandError } from "../dist/index.js";

test("getModelStatus runs the command in the requested workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));

  try {
    const result = await getModelStatus({
      workspaceDir: directory,
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
  await assert.rejects(
    getModelStatus({ workspaceDir: "/path/that/does/not/exist" }),
    (error) =>
      error instanceof ModelCommandError &&
      error.message.includes("Invalid workspace /path/that/does/not/exist"),
  );
});
