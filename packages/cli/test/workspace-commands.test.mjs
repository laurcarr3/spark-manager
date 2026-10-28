import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
        await writeRegistry(directory, { "Test Model": directory });
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
      await writeRegistry(directory, { "Test Model": directory });
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

test("start streams output before the workspace command exits", async () => {
  await withWorkspaceScript(
    "start.sh",
    '#!/bin/sh\nprintf "starting now\\n"\nsleep 30\n',
    async (directory) => {
      await writeRegistry(directory, { "Test Model": directory });
      const child = spawn(process.execPath, [cliPath, "start", "Test Model"], {
        env: { ...process.env, HOME: directory },
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        const output = await waitForOutput(child.stdout, "starting now\n");
        assert.equal(output, "starting now\n");
        assert.equal(child.exitCode, null);
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("close", resolve));
      }
    },
  );
});

test("start interactively applies a registry launch option", async () => {
  await withWorkspaceScript(
    "start.sh",
    [
      "#!/bin/sh",
      'printf "%s\\n" "$MAX_MODEL_LEN" > selected-context.txt',
      'printf "%s\\n" "$CACHE_PROFILE" >> selected-context.txt',
      "",
    ].join("\n"),
    async (directory) => {
      await writeRegistry(directory, {
        "Test Model": {
          workspaceDirectory: directory,
          launchOptions: [
            {
              id: "context",
              label: "Context window",
              description: "Choose a recipe-defined launch profile.",
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

      const result = await runCliWithInput(
        { home: directory },
        "1\n",
        "start",
        "Test Model",
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Context window/);
      assert.match(result.stdout, /2\) Balanced \(default\)/);
      assert.equal(
        await readFile(join(directory, "selected-context.txt"), "utf8"),
        "65536\ncompact\n",
      );
    },
  );
});

test("start accepts a launch option default with Enter", async () => {
  await withWorkspaceScript(
    "start.sh",
    '#!/bin/sh\nprintf "%s\\n" "$MAX_MODEL_LEN" > selected-context.txt\n',
    async (directory) => {
      await writeRegistry(directory, {
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
                  environment: { MAX_MODEL_LEN: "65536" },
                },
                {
                  id: "balanced",
                  label: "Balanced",
                  environment: { MAX_MODEL_LEN: "131072" },
                },
              ],
            },
          ],
        },
      });

      const result = await runCliWithInput(
        { home: directory },
        "\n",
        "start",
        "Test Model",
      );

      assert.equal(result.code, 0);
      assert.equal(
        await readFile(join(directory, "selected-context.txt"), "utf8"),
        "131072\n",
      );
    },
  );
});

test("start offers to stop a running registered model before switching", async () => {
  const home = await createModelSwitchFixture();
  try {
    const result = await runCliWithInput(
      {
        home,
        env: dockerStubEnvironment(home, [
          {
            Config: { Labels: {} },
            Mounts: [{ Source: join(home, "first", ".cache") }],
          },
        ]),
      },
      "yes\n",
      "start",
      "Second Model",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Model "First Model" is running\./);
    assert.match(result.stdout, /Stopping "First Model"/);
    assert.equal(
      await readFile(join(home, "first", "stopped.txt"), "utf8"),
      "stopped\n",
    );
    assert.equal(
      await readFile(join(home, "second", "started.txt"), "utf8"),
      "started\n",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("start leaves the running model alone when switching is declined", async () => {
  const home = await createModelSwitchFixture();
  try {
    const result = await runCliWithInput(
      {
        home,
        env: dockerStubEnvironment(home, [
          {
            Config: {
              Labels: {
                "com.docker.compose.project.working_dir": join(home, "first"),
              },
            },
            Mounts: [],
          },
        ]),
      },
      "no\n",
      "start",
      "Second Model",
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Stop it and start "Second Model"\?/);
    assert.equal(result.stderr, "Start cancelled.\n");
    await assert.rejects(readFile(join(home, "first", "stopped.txt")));
    await assert.rejects(readFile(join(home, "second", "started.txt")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status checks every registered model", async () => {
  const home = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  try {
    const firstWorkspace = join(home, "first");
    const secondWorkspace = join(home, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    await writeExecutable(
      join(firstWorkspace, "start.sh"),
      '#!/bin/sh\ntest "$1" = "ps"\nprintf "running\\n"\n',
    );
    await writeExecutable(
      join(secondWorkspace, "start.sh"),
      '#!/bin/sh\ntest "$1" = "ps"\nprintf "stopped\\n"\n',
    );
    await writeRegistry(home, {
      "First Model": firstWorkspace,
      "Second Model": secondWorkspace,
    });

    const { stdout, stderr } = await runCli({ home }, "status");

    assert.equal(stdout, "First Model:\nrunning\nSecond Model:\nstopped\n");
    assert.equal(stderr, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status checks an individual registered model", async () => {
  const home = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  try {
    const firstWorkspace = join(home, "first");
    const secondWorkspace = join(home, "second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    await writeExecutable(
      join(firstWorkspace, "start.sh"),
      '#!/bin/sh\nprintf "running\\n"\n',
    );
    await writeExecutable(
      join(secondWorkspace, "start.sh"),
      '#!/bin/sh\nprintf "stopped\\n"\n',
    );
    await writeRegistry(home, {
      "First Model": firstWorkspace,
      "Second Model": secondWorkspace,
    });

    const { stdout, stderr } = await runCli(
      { home },
      "status",
      "Second Model",
    );

    assert.equal(stdout, "Second Model:\nstopped\n");
    assert.equal(stderr, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("list returns every display name and workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  try {
    await writeRegistry(home, {
      "First Model": "/models/first",
      "Second Model": "/models/second",
    });

    const { stdout, stderr } = await runCli({ home }, "list");

    assert.equal(
      stdout,
      "First Model\t/models/first\nSecond Model\t/models/second\n",
    );
    assert.equal(stderr, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status rejects more than one display name", async () => {
  await assert.rejects(
    runCli({}, "status", "First Model", "Second Model"),
    (error) =>
      error.code === 1 &&
      error.stderr ===
        'Usage: spark-manager status ["<display name>"]\n',
  );
});

test("list rejects arguments", async () => {
  await assert.rejects(
    runCli({}, "list", "Test Model"),
    (error) =>
      error.code === 1 && error.stderr === "Usage: spark-manager list\n",
  );
});

test("an unknown display name returns a useful error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  try {
    await writeRegistry(directory, { "Known Model": directory });
    await assert.rejects(
      runCli({ home: directory }, "start", "Unknown Model"),
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
    env: {
      ...process.env,
      HOME: options.home ?? process.env.HOME,
      ...options.env,
    },
  });
}

function runCliWithInput(options, input, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        HOME: options.home ?? process.env.HOME,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function waitForOutput(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(expected)}`));
    }, 2_000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
    };
    stream.setEncoding("utf8");
    stream.on("data", onData);
  });
}

async function createModelSwitchFixture() {
  const home = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));
  const firstWorkspace = join(home, "first");
  const secondWorkspace = join(home, "second");
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  await mkdir(join(firstWorkspace, ".cache"));
  await writeExecutable(
    join(firstWorkspace, "stop.sh"),
    '#!/bin/sh\nprintf "stopped\\n" > stopped.txt\n',
  );
  await writeExecutable(
    join(secondWorkspace, "start.sh"),
    '#!/bin/sh\nprintf "started\\n" > started.txt\n',
  );
  await writeRegistry(home, {
    "First Model": firstWorkspace,
    "Second Model": secondWorkspace,
  });
  await installDockerStub(home);
  return home;
}

async function installDockerStub(home) {
  const binDirectory = join(home, "bin");
  await mkdir(binDirectory);
  await writeExecutable(
    join(binDirectory, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  ps) printf '%s\\n' container-id ;;",
      "  inspect) printf '%s' \"$FAKE_DOCKER_INSPECTIONS\" ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
  );
}

function dockerStubEnvironment(home, inspections) {
  return {
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
    FAKE_DOCKER_INSPECTIONS: JSON.stringify(inspections),
  };
}

async function writeRegistry(home, models) {
  const configDirectory = join(home, ".spark-manager");
  await mkdir(configDirectory, { recursive: true });
  const registry = Object.fromEntries(
    Object.entries(models).map(([displayName, entry]) => [
      displayName,
      typeof entry === "string" ? { workspaceDirectory: entry } : entry,
    ]),
  );
  await writeFile(
    join(configDirectory, "registry.json"),
    JSON.stringify(registry),
  );
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function withWorkspaceScript(scriptName, contents, run) {
  const directory = await mkdtemp(join(tmpdir(), "spark-manager-cli-test-"));

  try {
    const script = join(directory, scriptName);
    await writeExecutable(script, contents);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
