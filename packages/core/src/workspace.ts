import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

interface DockerContainerInspection {
  Config?: {
    Labels?: Record<string, string> | null;
  };
  Mounts?: Array<{
    Source?: string;
  }>;
}

export async function resolveWorkspace(workspaceDir: string): Promise<string> {
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

/** A container belongs to a workspace if its Compose working_dir or any mount source is inside it. */
export function containerBelongsToWorkspace(
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

export function runDockerCommand(args: readonly string[]): Promise<string> {
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

export function defaultRegistryPath(): string {
  return join(homedir(), ".spark-manager", "registry.json");
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
