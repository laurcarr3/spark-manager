import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
        await writeRegistry(directory, "Test Model", directory);
        const { stdout, stderr } = await runCli(
          { home: directory },
          command,
          "Test Model",
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

  test(`${command} requires a display name`, async () => {
    await assert.rejects(
      runCli({}, command),
      (error) =>
        error.code === 1 &&
        error.stderr ===
          `Usage: spark-manager ${command} "<display name>"\n`,
    );
  });
}

test("workspace command failures preserve stderr and exit code", async () => {
  await withWorkspaceScript(
    "start.sh",
    '#!/bin/sh\nprintf "model failed\\n" >&2\nexit 7\n',
    async (directory) => {
      await writeRegistry(directory, "Test Model", directory);
      await assert.rejects(
        runCli({ home: directory }, "start", "Test Model"),
        (error) =>
          error.code === 7 &&
          error.stdout === "" &&
          error.stderr === "model failed\n",
      );
    },
  );
});

test("an unknown display name returns a useful error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  try {
    await writeRegistry(directory, "Known Model", directory);
    await assert.rejects(
      runCli({ home: directory }, "status", "Unknown Model"),
      (error) =>
        error.code === 1 &&
        error.stderr.includes('Unknown display name "Unknown Model"'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runCli(options, ...args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: options.home ?? process.env.HOME },
  });
}

async function writeRegistry(home, displayName, workspaceDirectory) {
  const configDirectory = join(home, ".spark-manager");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "registry.json"),
    JSON.stringify({ [displayName]: { workspaceDirectory } }),
  );
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
