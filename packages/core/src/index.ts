import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

export interface RegisteredModel {
  displayName: string;
  workspaceDirectory: string;
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
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
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

  const registry = await readRegistry(registryPath);
  const model = registry.find((entry) => entry.displayName === displayName);
  if (!model) {
    throw new Error(
      `Unknown display name ${JSON.stringify(displayName)} in ${registryPath}.`,
    );
  }
  return model;
}

async function readRegistry(registryPath: string): Promise<RegisteredModel[]> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
