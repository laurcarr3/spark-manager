import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = new URL("../dist/index.js", import.meta.url).pathname;

for (const [command, expectedArgument] of [
  ["start", ""],
  ["stop", "stop"],
]) {
  test(`${command} runs the workspace ${command} command`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
    const startScript = join(directory, "start.sh");

    try {
      await writeFile(startScript, '#!/bin/sh\nprintf "%s\\n" "$1"\n');
      await chmod(startScript, 0o755);

      const { stdout, stderr } = await execFileAsync(process.execPath, [
        cliPath,
        command,
        "--workspace",
        directory,
      ]);

      assert.equal(stdout, `${expectedArgument}\n`);
      assert.equal(stderr, "");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${command} requires --workspace`, async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, command]),
      (error) =>
        error.code === 1 &&
        error.stderr ===
          `Usage: spark-manager ${command} --workspace <path>\n`,
    );
  });
}
