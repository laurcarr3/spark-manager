import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cliPath = new URL("../dist/index.js", import.meta.url).pathname;

for (const [command, scriptName, expectedArguments] of [
  ["start", "start.sh", []],
  ["stop", "stop.sh", []],
  ["status", "start.sh", ["ps"]],
]) {
  test(`${command} invokes ${scriptName} with the expected arguments`, async () => {
    await withWorkspaceScript(
      scriptName,
      [
        "#!/bin/sh",
        ": > invocation.txt",
        'for argument in "$@"; do',
        '  printf "%s\\n" "$argument" >> invocation.txt',
        "done",
        "",
      ].join("\n"),
      async (directory) => {
        const { stdout, stderr } = await runCli(
          command,
          "--workspace",
          directory,
        );

        const invocation = await readFile(
          join(directory, "invocation.txt"),
          "utf8",
        );
        const actualArguments = invocation
          ? invocation.trimEnd().split("\n")
          : [];

        assert.deepEqual(actualArguments, expectedArguments);
        assert.equal(stdout, "");
        assert.equal(stderr, "");
      },
    );
  });

  test(`${command} requires --workspace`, async () => {
    await assert.rejects(
      runCli(command),
      (error) =>
        error.code === 1 &&
        error.stderr ===
          `Usage: spark-manager ${command} --workspace <path>\n`,
    );
  });
}

test("workspace command failures preserve stderr and exit code", async () => {
  await withWorkspaceScript(
    "start.sh",
    '#!/bin/sh\nprintf "model failed\\n" >&2\nexit 7\n',
    async (directory) => {
      await assert.rejects(
        runCli("start", "--workspace", directory),
        (error) =>
          error.code === 7 &&
          error.stdout === "" &&
          error.stderr === "model failed\n",
      );
    },
  );
});

function runCli(...args) {
  return execFileAsync(process.execPath, [cliPath, ...args]);
}

async function withWorkspaceScript(scriptName, contents, run) {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));

  try {
    const script = join(directory, scriptName);
    await writeFile(script, contents);
    await chmod(script, 0o755);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
