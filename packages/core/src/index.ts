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

export interface GetModelStatusOptions {
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

export async function getModelStatus(
  options: GetModelStatusOptions,
): Promise<CommandResult> {
  const workspaceDir = await resolveWorkspace(options.workspaceDir);
  const command = options.command ?? DEFAULT_STATUS_COMMAND;
  const [executable, ...args] = command;

  if (!executable) {
    throw new ModelCommandError("Status command must not be empty.");
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
          `Unable to run status command in ${workspaceDir}: ${error.message}`,
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
