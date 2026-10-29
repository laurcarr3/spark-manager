import { randomBytes } from "node:crypto";

import {
  acquireLifecycleLock,
  getModelStatuses,
  getRegisteredModel,
  getRegisteredModels,
  getRegisteredModelStatus,
  LifecycleLockHeldError,
  resolveLaunchEnvironment,
  type LifecycleState,
  type RegisteredModel,
  type RegisteredModelStatus,
} from "./index.js";
import { launchProcess, type LaunchedProcess, type ProcessExit } from "./process.js";
import { DockerRuntimeController, type RuntimeController } from "./runtime.js";
import { defaultRegistryPath, errorMessage, resolveWorkspace } from "./workspace.js";

export type OperationKind = "start" | "stop";
export type OperationStatus = "queued" | "running" | "succeeded" | "failed";

export type LifecycleErrorCode =
  | "CONFLICTING_MODEL_STOP_FAILED"
  | "START_COMMAND_UNAVAILABLE"
  | "START_COMMAND_FAILED"
  | "STARTUP_TIMEOUT"
  | "STOP_COMMAND_UNAVAILABLE"
  | "STOP_COMMAND_FAILED"
  | "STOP_TIMEOUT"
  | "INTERNAL_ERROR";

export interface LifecycleError {
  operationId: string;
  kind: OperationKind;
  code: LifecycleErrorCode;
  message: string;
  at: string;
  exitCode: number | null;
  signal: string | null;
  /** True when nothing is left half-running, so the same request can simply be retried. */
  retrySafe: boolean;
  /** Filled in by Layer 3; always empty until then. */
  logTail: string[];
}

export interface Operation {
  operationId: string;
  kind: OperationKind;
  displayName: string;
  status: OperationStatus;
  /** API request ID, for correlating logs. */
  requestId: string | null;
  options: {
    switchRunning?: boolean;
    launchOptionSelections?: Record<string, string>;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  command: { exitCode: number | null; signal: string | null } | null;
  error: LifecycleError | null;
}

export interface OperationSummary {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
}

export interface ManagedModelStatus {
  displayName: string;
  lifecycleState: LifecycleState;
  /** What was last requested; null until the first start or stop. */
  desiredState: "running" | "stopped" | null;
  activeOperation: OperationSummary | null;
  lastOperation: OperationSummary | null;
  /** The most recent failure; a later success does not clear it. */
  lastError: LifecycleError | null;
  runtime: RegisteredModelStatus["runtime"];
}

export interface LifecycleTiming {
  startTimeoutMs: number;
  stopTimeoutMs: number;
  /** Time between SIGTERM and SIGKILL when terminating a recipe's process group. */
  killGraceMs: number;
}

export interface LifecycleManagerOptions {
  registryPath?: string;
  runtime?: RuntimeController;
  timing?: Partial<LifecycleTiming>;
  /** Called once per operation when it succeeds or fails. */
  onOperationFinished?: (operation: Operation) => void;
}

export const OPERATION_ID_PATTERN = /^op_[a-f0-9]{32}$/;

const DEFAULT_TIMING: LifecycleTiming = {
  startTimeoutMs: 3 * 60 * 60 * 1000,
  stopTimeoutMs: 5 * 60 * 1000,
  killGraceMs: 10_000,
};
const OPERATIONS_KEPT_PER_MODEL = 10;

/** A request the manager refuses before creating an operation; the API maps it to an HTTP error. */
export class LifecycleRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LifecycleRequestError";
  }
}

interface ModelRecord {
  desiredState: "running" | "stopped" | null;
  activeOperationId: string | null;
  lastOperationId: string | null;
  lastError: LifecycleError | null;
  /** Oldest first; pruned to OPERATIONS_KEPT_PER_MODEL. */
  operationIds: string[];
}

interface Failure {
  code: LifecycleErrorCode;
  message: string;
  retrySafe: boolean;
}

type ScriptResult =
  | { outcome: "exited"; exit: ProcessExit }
  | { outcome: "timeout"; exit: ProcessExit }
  | { outcome: "unavailable"; message: string };

/**
 * Runs start and stop requests in the background, one at a time across all
 * models, and keeps their history in memory.
 */
export class LifecycleManager {
  readonly #registryPath: string;
  readonly #runtime: RuntimeController;
  readonly #timing: LifecycleTiming;
  readonly #onOperationFinished: ((operation: Operation) => void) | undefined;
  readonly #operations = new Map<string, Operation>();
  readonly #models = new Map<string, ModelRecord>();
  readonly #processes = new Set<LaunchedProcess>();
  readonly #tasks = new Set<Promise<void>>();
  #activeOperationId: string | null = null;
  #admission: Promise<unknown> = Promise.resolve();

  constructor(options: LifecycleManagerOptions = {}) {
    this.#registryPath = options.registryPath ?? defaultRegistryPath();
    this.#runtime = options.runtime ?? new DockerRuntimeController();
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#onOperationFinished = options.onOperationFinished;
  }

  start(
    displayName: string,
    options: {
      switchRunning?: boolean;
      launchOptionSelections?: Record<string, string>;
    } = {},
    requestId: string | null = null,
  ): Promise<Operation> {
    return this.#serialize(async () => {
      const model = await getRegisteredModel(displayName, this.#registryPath);
      let launchEnvironment: Record<string, string>;
      try {
        launchEnvironment = resolveLaunchEnvironment(
          model,
          options.launchOptionSelections,
        );
      } catch (error) {
        throw new LifecycleRequestError(
          400,
          "INVALID_LAUNCH_OPTIONS",
          errorMessage(error),
        );
      }
      this.#assertIdle(displayName);
      const conflictingModels = await this.#runningModelsOtherThan(displayName);
      if (conflictingModels.length > 0 && options.switchRunning !== true) {
        throw new LifecycleRequestError(
          409,
          "MODEL_ALREADY_RUNNING",
          "Another registered model is running. Retry with switchRunning set to true to stop it first.",
          { runningModels: conflictingModels },
        );
      }

      return this.#launch("start", model, options, requestId, async (operation) => {
        for (const conflictingModel of conflictingModels) {
          const result = await this.#runScript(
            conflictingModel,
            "./stop.sh",
            {},
            this.#timing.stopTimeoutMs,
          );
          if (result.outcome !== "unavailable") {
            operation.command = commandOf(result.exit);
          }
          if (result.outcome !== "exited" || commandFailed(result.exit)) {
            return {
              code: "CONFLICTING_MODEL_STOP_FAILED",
              message: `Unable to stop ${JSON.stringify(conflictingModel.displayName)} before starting ${JSON.stringify(displayName)}: ${describeScriptResult(result, "stop")}`,
              retrySafe: true,
            };
          }
        }

        const result = await this.#runScript(
          model,
          "./start.sh",
          launchEnvironment,
          this.#timing.startTimeoutMs,
        );
        if (result.outcome === "unavailable") {
          operation.command = null;
          return {
            code: "START_COMMAND_UNAVAILABLE",
            message: `Unable to run the start command: ${result.message}`,
            retrySafe: true,
          };
        }
        operation.command = commandOf(result.exit);
        if (result.outcome === "timeout") {
          return {
            code: "STARTUP_TIMEOUT",
            message: `The start command did not finish within ${formatDuration(this.#timing.startTimeoutMs)}.`,
            retrySafe: false,
          };
        }
        if (commandFailed(result.exit)) {
          return {
            code: "START_COMMAND_FAILED",
            message: `The start command ${describeScriptResult(result, "start")}.`,
            retrySafe: false,
          };
        }
        return null;
      });
    });
  }

  stop(displayName: string, requestId: string | null = null): Promise<Operation> {
    return this.#serialize(async () => {
      const model = await getRegisteredModel(displayName, this.#registryPath);
      this.#assertIdle(displayName);

      return this.#launch("stop", model, {}, requestId, async (operation) => {
        const result = await this.#runScript(
          model,
          "./stop.sh",
          {},
          this.#timing.stopTimeoutMs,
        );
        if (result.outcome === "unavailable") {
          return {
            code: "STOP_COMMAND_UNAVAILABLE",
            message: `Unable to run the stop command: ${result.message}`,
            retrySafe: true,
          };
        }
        operation.command = commandOf(result.exit);
        if (result.outcome === "timeout") {
          return {
            code: "STOP_TIMEOUT",
            message: `The stop command did not finish within ${formatDuration(this.#timing.stopTimeoutMs)}.`,
            retrySafe: false,
          };
        }
        if (commandFailed(result.exit)) {
          return {
            code: "STOP_COMMAND_FAILED",
            message: `The stop command ${describeScriptResult(result, "stop")}.`,
            retrySafe: await this.#hasNoRunningContainers(model),
          };
        }
        return null;
      });
    });
  }

  getOperation(operationId: string): Operation | undefined {
    const operation = this.#operations.get(operationId);
    return operation && structuredClone(operation);
  }

  async getStatuses(): Promise<ManagedModelStatus[]> {
    const statuses = await getModelStatuses(this.#registryPath, this.#runtime);
    return statuses.map((status) => this.#withLifecycle(status));
  }

  async getStatus(displayName: string): Promise<ManagedModelStatus> {
    return this.#withLifecycle(
      await getRegisteredModelStatus(displayName, this.#registryPath, this.#runtime),
    );
  }

  /** Terminates running recipe scripts and waits for their operations to finish. Containers keep running. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.#processes].map((process) => process.terminate(this.#timing.killGraceMs)),
    );
    await Promise.all(this.#tasks);
  }

  /** Runs admission checks one request at a time so two requests can't both find the manager idle. */
  #serialize<T>(admit: () => Promise<T>): Promise<T> {
    const result = this.#admission.then(admit);
    this.#admission = result.catch(() => undefined);
    return result;
  }

  #assertIdle(displayName: string): void {
    const active =
      this.#activeOperationId === null
        ? undefined
        : this.#operations.get(this.#activeOperationId);
    if (!active) {
      return;
    }
    const sameModel = active.displayName === displayName;
    throw new LifecycleRequestError(
      409,
      sameModel ? "OPERATION_IN_PROGRESS" : "LIFECYCLE_BUSY",
      sameModel
        ? `A ${active.kind} operation is already in progress for ${JSON.stringify(displayName)}.`
        : `A ${active.kind} operation is in progress for ${JSON.stringify(active.displayName)}.`,
      { activeOperationId: active.operationId, activeModel: active.displayName },
    );
  }

  async #runningModelsOtherThan(displayName: string): Promise<RegisteredModel[]> {
    const otherModels = (await getRegisteredModels(this.#registryPath)).filter(
      (model) => model.displayName !== displayName,
    );
    if (otherModels.length === 0) {
      return [];
    }
    let containersByModel;
    try {
      containersByModel = await this.#runtime.inspect(otherModels);
    } catch (error) {
      throw new LifecycleRequestError(
        503,
        "RUNTIME_INSPECTION_FAILED",
        `Unable to check for running models: ${errorMessage(error)}`,
      );
    }
    return otherModels.filter((model) =>
      containersByModel
        .get(model.displayName)
        ?.some((container) => container.running),
    );
  }

  async #hasNoRunningContainers(model: RegisteredModel): Promise<boolean> {
    try {
      const containersByModel = await this.#runtime.inspect([model]);
      return !containersByModel
        .get(model.displayName)
        ?.some((container) => container.running);
    } catch {
      return false;
    }
  }

  async #launch(
    kind: OperationKind,
    model: RegisteredModel,
    options: Operation["options"],
    requestId: string | null,
    run: (operation: Operation) => Promise<Failure | null>,
  ): Promise<Operation> {
    let releaseLock: () => Promise<void>;
    try {
      releaseLock = await acquireLifecycleLock(this.#registryPath);
    } catch (error) {
      if (error instanceof LifecycleLockHeldError) {
        throw new LifecycleRequestError(
          409,
          "LIFECYCLE_LOCK_HELD",
          "Another spark-manager process (such as the CLI) is running a lifecycle operation.",
          { ownerPid: error.ownerPid },
        );
      }
      throw error;
    }

    const operation: Operation = {
      operationId: `op_${randomBytes(16).toString("hex")}`,
      kind,
      displayName: model.displayName,
      status: "queued",
      requestId,
      options,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      command: null,
      error: null,
    };
    const record = this.#record(model.displayName);
    record.desiredState = kind === "start" ? "running" : "stopped";
    record.activeOperationId = operation.operationId;
    record.operationIds.push(operation.operationId);
    this.#operations.set(operation.operationId, operation);
    this.#activeOperationId = operation.operationId;
    this.#prune(record);

    const task = (async () => {
      // Let the caller respond before any work starts.
      await new Promise((resolve) => setImmediate(resolve));
      operation.status = "running";
      operation.startedAt = new Date().toISOString();
      let failure: Failure | null;
      try {
        failure = await run(operation);
      } catch (error) {
        failure = {
          code: "INTERNAL_ERROR",
          message: `Unexpected error: ${errorMessage(error)}`,
          retrySafe: false,
        };
      }
      try {
        await releaseLock();
      } catch {
        // A lock left behind is removed by the next owner once this process exits.
      }
      this.#finish(operation, record, failure);
    })();
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
    return structuredClone(operation);
  }

  #finish(operation: Operation, record: ModelRecord, failure: Failure | null): void {
    const at = new Date().toISOString();
    operation.status = failure ? "failed" : "succeeded";
    operation.finishedAt = at;
    if (failure) {
      operation.error = {
        operationId: operation.operationId,
        kind: operation.kind,
        code: failure.code,
        message: failure.message,
        at,
        exitCode: operation.command?.exitCode ?? null,
        signal: operation.command?.signal ?? null,
        retrySafe: failure.retrySafe,
        logTail: [],
      };
      record.lastError = operation.error;
    }
    record.activeOperationId = null;
    record.lastOperationId = operation.operationId;
    this.#activeOperationId = null;
    this.#onOperationFinished?.(structuredClone(operation));
  }

  #record(displayName: string): ModelRecord {
    let record = this.#models.get(displayName);
    if (!record) {
      record = {
        desiredState: null,
        activeOperationId: null,
        lastOperationId: null,
        lastError: null,
        operationIds: [],
      };
      this.#models.set(displayName, record);
    }
    return record;
  }

  #prune(record: ModelRecord): void {
    while (record.operationIds.length > OPERATIONS_KEPT_PER_MODEL) {
      const [oldest] = record.operationIds.splice(0, 1);
      if (oldest !== undefined) {
        this.#operations.delete(oldest);
      }
    }
  }

  async #runScript(
    model: RegisteredModel,
    script: string,
    environment: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<ScriptResult> {
    let cwd: string;
    try {
      cwd = await resolveWorkspace(model.workspaceDirectory);
    } catch (error) {
      return { outcome: "unavailable", message: errorMessage(error) };
    }
    const launched = launchProcess({
      command: [script],
      cwd,
      env: { ...process.env, ...environment },
      // Output is discarded until Layer 3 adds logs.
      onLine: () => undefined,
    });
    this.#processes.add(launched);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const first = await Promise.race([launched.exited, timedOut]);
      if (first === "timeout") {
        return {
          outcome: "timeout",
          exit: await launched.terminate(this.#timing.killGraceMs),
        };
      }
      if (first.spawnError !== null) {
        return { outcome: "unavailable", message: first.spawnError };
      }
      return { outcome: "exited", exit: first };
    } finally {
      clearTimeout(timer);
      this.#processes.delete(launched);
    }
  }

  #withLifecycle(status: RegisteredModelStatus): ManagedModelStatus {
    const record = this.#models.get(status.displayName);
    const active = this.#operationFor(record?.activeOperationId);
    const last = this.#operationFor(record?.lastOperationId);
    let lifecycleState = status.lifecycleState;
    if (active) {
      lifecycleState =
        active.status === "queued"
          ? "queued"
          : active.kind === "start"
            ? "starting"
            : "stopping";
    } else if (last?.status === "failed") {
      lifecycleState = "failed";
    }
    return {
      displayName: status.displayName,
      lifecycleState,
      desiredState: record?.desiredState ?? null,
      activeOperation: summarize(active),
      lastOperation: summarize(last),
      lastError: record?.lastError ? structuredClone(record.lastError) : null,
      runtime: status.runtime,
    };
  }

  #operationFor(operationId: string | null | undefined): Operation | undefined {
    return operationId ? this.#operations.get(operationId) : undefined;
  }
}

function summarize(operation: Operation | undefined): OperationSummary | null {
  return operation
    ? {
        operationId: operation.operationId,
        kind: operation.kind,
        status: operation.status,
      }
    : null;
}

function commandOf(exit: ProcessExit): Operation["command"] {
  return { exitCode: exit.exitCode, signal: exit.signal };
}

function commandFailed(exit: ProcessExit): boolean {
  return exit.exitCode !== 0 || exit.signal !== null;
}

function describeScriptResult(result: ScriptResult, name: string): string {
  switch (result.outcome) {
    case "unavailable":
      return result.message;
    case "timeout":
      return `the ${name} command timed out`;
    case "exited":
      return result.exit.signal
        ? `was terminated by ${result.exit.signal}`
        : `exited with status ${result.exit.exitCode}`;
  }
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 60_000 === 0
    ? `${milliseconds / 60_000} minutes`
    : `${milliseconds / 1000} seconds`;
}
