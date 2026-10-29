import {
  containerBelongsToWorkspace,
  errorMessage,
  resolveWorkspace,
  runDockerCommand,
} from "./workspace.js";

const MAX_INSPECTED_CONTAINERS = 200;

export interface RuntimeContainer {
  id: string;
  name: string | null;
  running: boolean;
  restarting: boolean;
  /** Docker State.Status. */
  status: string | null;
  /** Only set when the container is not running. */
  exitCode: number | null;
  oomKilled: boolean;
  restartCount: number;
  /** Null for Docker's zero time. */
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RuntimeWorkspace {
  displayName: string;
  workspaceDirectory: string;
  /** Containers with these exact names belong to the workspace even without a mount or Compose label. */
  containerNames?: readonly string[];
}

export interface RuntimeController {
  /** Containers (running and recently exited) per display name, newest first. Rejects if Docker can't be queried. */
  inspect(
    workspaces: readonly RuntimeWorkspace[],
  ): Promise<Map<string, RuntimeContainer[]>>;
  kill(containerIds: readonly string[]): Promise<void>;
}

export class DockerRuntimeController implements RuntimeController {
  async inspect(
    workspaces: readonly RuntimeWorkspace[],
  ): Promise<Map<string, RuntimeContainer[]>> {
    const result = new Map<string, RuntimeContainer[]>(
      workspaces.map((workspace) => [workspace.displayName, []]),
    );
    const containerIds = (
      await runDockerCommand([
        "ps",
        "--all",
        "--last",
        String(MAX_INSPECTED_CONTAINERS),
        "--quiet",
        "--no-trunc",
      ])
    )
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
    if (containerIds.length === 0) {
      return result;
    }

    let inspections: unknown;
    try {
      inspections = JSON.parse(
        await runDockerCommand(["inspect", ...containerIds]),
      );
    } catch (error) {
      throw new Error(
        `Unable to inspect Docker containers: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!Array.isArray(inspections)) {
      throw new Error(
        "Unable to inspect Docker containers: expected a JSON array.",
      );
    }

    const resolvedWorkspaces: Array<{
      displayName: string;
      directory: string | undefined;
      containerNames: readonly string[];
    }> = [];
    for (const workspace of workspaces) {
      let directory: string | undefined;
      try {
        directory = await resolveWorkspace(workspace.workspaceDirectory);
      } catch {
        // An invalid workspace owns no containers by path; validation reports it separately.
      }
      resolvedWorkspaces.push({
        displayName: workspace.displayName,
        directory,
        containerNames: workspace.containerNames ?? [],
      });
    }

    for (const inspection of inspections) {
      const container = parseContainer(inspection);
      if (!container) {
        continue;
      }
      for (const workspace of resolvedWorkspaces) {
        const owned =
          (container.name !== null &&
            workspace.containerNames.includes(container.name)) ||
          (workspace.directory !== undefined &&
            containerBelongsToWorkspace(inspection, workspace.directory));
        if (owned) {
          result.get(workspace.displayName)?.push(container);
        }
      }
    }
    for (const containers of result.values()) {
      containers.sort(
        (first, second) =>
          timeValue(second.startedAt) - timeValue(first.startedAt),
      );
    }
    return result;
  }

  async kill(containerIds: readonly string[]): Promise<void> {
    if (containerIds.length > 0) {
      await runDockerCommand(["kill", ...containerIds]);
    }
  }
}

function parseContainer(value: unknown): RuntimeContainer | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const inspection = value as {
    Id?: unknown;
    Name?: unknown;
    RestartCount?: unknown;
    State?: {
      Running?: unknown;
      Restarting?: unknown;
      Status?: unknown;
      ExitCode?: unknown;
      OOMKilled?: unknown;
      StartedAt?: unknown;
      FinishedAt?: unknown;
    };
  };
  if (typeof inspection.Id !== "string") {
    return undefined;
  }
  const state = inspection.State ?? {};
  const running = state.Running === true;
  return {
    id: inspection.Id,
    name:
      typeof inspection.Name === "string"
        ? inspection.Name.replace(/^\//, "")
        : null,
    running,
    restarting: state.Restarting === true,
    status: typeof state.Status === "string" ? state.Status : null,
    exitCode:
      !running && typeof state.ExitCode === "number" ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    restartCount:
      typeof inspection.RestartCount === "number" ? inspection.RestartCount : 0,
    startedAt: dockerTime(state.StartedAt),
    finishedAt: dockerTime(state.FinishedAt),
  };
}

function dockerTime(value: unknown): string | null {
  // Docker reports the zero time for containers that never started or finished.
  return typeof value === "string" && !value.startsWith("0001-") ? value : null;
}

function timeValue(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}
