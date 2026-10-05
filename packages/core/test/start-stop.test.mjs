import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startModel, stopModel } from "../dist/index.js";

for (const [name, operation] of [
  ["startModel", startModel],
  ["stopModel", stopModel],
]) {
  test(`${name} runs the command in the requested workspace`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spark-manager-test-"));

    try {
      const result = await operation({
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
}
