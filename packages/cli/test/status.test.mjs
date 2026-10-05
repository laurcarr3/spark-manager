import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("status runs the workspace status command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  const startScript = join(directory, "start.sh");

  try {
    await writeFile(
      startScript,
      '#!/bin/sh\n[ "$1" = "ps" ] && printf "model is running\\n"\n',
    );
    await chmod(startScript, 0o755);

    const { stdout, stderr } = await execFileAsync(process.execPath, [
      new URL("../dist/index.js", import.meta.url).pathname,
      "status",
      "--workspace",
      directory,
    ]);

    assert.equal(stdout, "model is running\n");
    assert.equal(stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status requires --workspace", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      new URL("../dist/index.js", import.meta.url).pathname,
      "status",
    ]),
    (error) =>
      error.code === 1 &&
      error.stderr === "Usage: spark-manager status --workspace <path>\n",
  );
});
