import { execFile, spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type ModelStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface Model {
  id: string;
  name: string;
  status: ModelStatus;
}

export interface CommandResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ModelCommandOptions {
  displayName: string;
  command?: readonly string[];
  registryPath?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RegisteredModel {
  displayName: string;
  workspaceDirectory: string;
}

interface DockerContainerInspection {
  Config?: {
    Labels?: Record<string, string> | null;
  };
  Mounts?: Array<{
    Source?: string;
  }>;
}

const DEFAULT_STATUS_COMMAND = ["./start.sh", "ps"] as const;
const DEFAULT_START_COMMAND = ["./start.sh"] as const;
const DEFAULT_STOP_COMMAND = ["./stop.sh"] as const;

export async function getModelStatus(
  options: ModelCommandOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options,
    options.command ?? DEFAULT_STATUS_COMMAND,
    "Status",
  );
}

export async function startModel(
  options: ModelCommandOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options,
    options.command ?? DEFAULT_START_COMMAND,
    "Start",
  );
}

export async function stopModel(
  options: ModelCommandOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options,
    options.command ?? DEFAULT_STOP_COMMAND,
    "Stop",
  );
}

async function runModelCommand(
  options: ModelCommandOptions,
  command: readonly string[],
  commandName: string,
): Promise<CommandResult> {
  const model = await getRegisteredModel(
    options.displayName,
    options.registryPath,
  );
  const workspaceDir = await resolveWorkspace(model.workspaceDirectory);
  const [executable, ...args] = command;

  if (!executable) {
    throw new Error(`${commandName} command must not be empty.`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspaceDir,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.once("error", (error) => {
      reject(
        new Error(
          `Unable to run ${commandName.toLowerCase()} command in ${workspaceDir}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr });
    });
  });
}

export async function getRegisteredModel(
  displayName: string,
  registryPath = join(homedir(), ".spark-manager", "registry.json"),
): Promise<RegisteredModel> {
  if (!displayName.trim()) {
    throw new Error("Model display name must not be empty.");
  }

  const registry = await getRegisteredModels(registryPath);
  const model = registry.find((entry) => entry.displayName === displayName);
  if (!model) {
    throw new Error(
      `Unknown display name ${JSON.stringify(displayName)} in ${registryPath}.`,
    );
  }
  return model;
}

export async function getRegisteredModels(
  registryPath = join(homedir(), ".spark-manager", "registry.json"),
): Promise<RegisteredModel[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read model registry ${registryPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid model registry ${registryPath}: expected a JSON object.`,
    );
  }

  return Object.entries(value).map(([displayName, entry]) => {
    if (!displayName.trim()) {
      throw new Error(
        `Invalid model registry ${registryPath}: model ${JSON.stringify(displayName)} must have a non-empty workspaceDirectory string.`,
      );
    }
    return parseRegistryEntry(registryPath, displayName, entry);
  });
}

export async function getRunningRegisteredModels(
  registryPath = join(homedir(), ".spark-manager", "registry.json"),
): Promise<RegisteredModel[]> {
  const models = await getRegisteredModels(registryPath);
  const containerIds = (await runDockerCommand(["ps", "--quiet", "--no-trunc"]))
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);

  if (containerIds.length === 0) {
    return [];
  }

  let inspections: unknown;
  try {
    inspections = JSON.parse(
      await runDockerCommand(["inspect", ...containerIds]),
    );
  } catch (error) {
    throw new Error(
      `Unable to inspect running Docker containers: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(inspections)) {
    throw new Error(
      "Unable to inspect running Docker containers: expected a JSON array.",
    );
  }

  const workspaces = await Promise.all(
    models.map(async (model) => ({
      model,
      workspaceDirectory: await resolveWorkspace(model.workspaceDirectory),
    })),
  );

  return workspaces
    .filter(({ workspaceDirectory }) =>
      inspections.some((inspection) =>
        containerBelongsToWorkspace(inspection, workspaceDirectory),
      ),
    )
    .map(({ model }) => model);
}

function parseRegistryEntry(
  registryPath: string,
  displayName: string,
  entry: unknown,
): RegisteredModel {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("workspaceDirectory" in entry) ||
    typeof entry.workspaceDirectory !== "string" ||
    !entry.workspaceDirectory.trim()
  ) {
    throw new Error(
      `Invalid model registry ${registryPath}: model ${JSON.stringify(displayName)} must have a non-empty workspaceDirectory string.`,
    );
  }

  return { displayName, workspaceDirectory: entry.workspaceDirectory };
}

async function resolveWorkspace(workspaceDir: string): Promise<string> {
  try {
    const workspaceStats = await stat(workspaceDir);
    if (!workspaceStats.isDirectory()) {
      throw new Error("path is not a directory");
    }
    return await realpath(workspaceDir);
  } catch (error) {
    throw new Error(
      `Invalid workspace ${workspaceDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function containerBelongsToWorkspace(
  value: unknown,
  workspaceDirectory: string,
): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const inspection = value as DockerContainerInspection;
  const composeWorkspace =
    inspection.Config?.Labels?.["com.docker.compose.project.working_dir"];
  if (
    composeWorkspace &&
    pathIsWithinWorkspace(workspaceDirectory, composeWorkspace)
  ) {
    return true;
  }

  return (
    inspection.Mounts?.some(
      (mount) =>
        typeof mount.Source === "string" &&
        pathIsWithinWorkspace(workspaceDirectory, mount.Source),
    ) ?? false
  );
}

function pathIsWithinWorkspace(
  workspaceDirectory: string,
  candidatePath: string,
): boolean {
  const pathFromWorkspace = relative(
    workspaceDirectory,
    resolve(candidatePath),
  );
  return (
    pathFromWorkspace === "" ||
    (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace))
  );
}

function runDockerCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    execFile(
      "docker",
      args,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Unable to query Docker: ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolveCommand(stdout);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
