import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

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
  workspaceDir: string;
  command?: readonly string[];
}

export class ModelCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelCommandError";
  }
}

const DEFAULT_STATUS_COMMAND = ["./start.sh", "ps"] as const;
const DEFAULT_START_COMMAND = ["./start.sh"] as const;
const DEFAULT_STOP_COMMAND = ["./stop.sh"] as const;

export async function getModelStatus(
  options: ModelCommandOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options.workspaceDir,
    options.command ?? DEFAULT_STATUS_COMMAND,
    "Status",
  );
}

export async function startModel(
  options: ModelCommandOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options.workspaceDir,
    options.command ?? DEFAULT_START_COMMAND,
    "Start",
  );
}

export async function stopModel(
  options: ModelCommandOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options.workspaceDir,
    options.command ?? DEFAULT_STOP_COMMAND,
    "Stop",
  );
}

async function runModelCommand(
  requestedWorkspaceDir: string,
  command: readonly string[],
  commandName: string,
): Promise<CommandResult> {
  const workspaceDir = await resolveWorkspace(requestedWorkspaceDir);
  const [executable, ...args] = command;

  if (!executable) {
    throw new ModelCommandError(`${commandName} command must not be empty.`);
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
        new ModelCommandError(
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

async function resolveWorkspace(workspaceDir: string): Promise<string> {
  try {
    const workspaceStats = await stat(workspaceDir);
    if (!workspaceStats.isDirectory()) {
      throw new Error("path is not a directory");
    }
    return await realpath(workspaceDir);
  } catch (error) {
    throw new ModelCommandError(
      `Invalid workspace ${workspaceDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
