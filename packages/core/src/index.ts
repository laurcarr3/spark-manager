import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DockerRuntimeController,
  type RuntimeContainer,
  type RuntimeController,
} from "./runtime.js";
import {
  defaultRegistryPath,
  errorMessage,
  isNodeError,
  resolveWorkspace,
} from "./workspace.js";

export {
  DockerRuntimeController,
  type RuntimeContainer,
  type RuntimeController,
  type RuntimeWorkspace,
} from "./runtime.js";
export { defaultRegistryPath } from "./workspace.js";

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

export interface StartModelOptions extends ModelCommandOptions {
  environment?: Readonly<Record<string, string>>;
}

export interface LaunchOptionChoice {
  id: string;
  label: string;
  description?: string;
  environment: Readonly<Record<string, string>>;
}

export interface LaunchOption {
  id: string;
  label: string;
  description?: string;
  defaultChoice?: string;
  choices: readonly LaunchOptionChoice[];
}

export interface RegisteredModel {
  displayName: string;
  workspaceDirectory: string;
  /** Docker container names owned by the model, for recipes whose containers neither mount the workspace nor carry Compose labels. */
  containerNames?: readonly string[];
  launchOptions?: readonly LaunchOption[];
}

export interface StartRegisteredModelOptions extends ModelCommandOptions {
  launchOptionSelections?: Readonly<Record<string, string>>;
  confirmSwitch?: (runningModels: readonly RegisteredModel[]) => Promise<boolean>;
  onStopping?: (model: RegisteredModel) => void;
  runtime?: RuntimeController;
}

export type StartRegisteredModelResult =
  | {
      outcome: "started";
      result: CommandResult;
      stoppedModels: RegisteredModel[];
    }
  | { outcome: "cancelled"; runningModels: RegisteredModel[] }
  | {
      outcome: "stop-failed";
      model: RegisteredModel;
      result: CommandResult;
    };

export class UnknownModelError extends Error {
  constructor(
    readonly displayName: string,
    readonly registryPath: string,
  ) {
    super(
      `Unknown display name ${JSON.stringify(displayName)} in ${registryPath}.`,
    );
    this.name = "UnknownModelError";
  }
}

export type LifecycleState = "stopped" | "running" | "unknown";

export interface RuntimeObservation {
  /** False when Docker could not be queried. */
  observed: boolean;
  /** True when any container owned by the workspace is running. */
  present: boolean;
  containers: RuntimeContainer[];
  error: string | null;
}

export interface RegisteredModelStatus {
  displayName: string;
  lifecycleState: LifecycleState;
  runtime: RuntimeObservation;
}

const DEFAULT_START_COMMAND = ["./start.sh"] as const;
const DEFAULT_STOP_COMMAND = ["./stop.sh"] as const;

export async function startRegisteredModel(
  options: StartRegisteredModelOptions,
): Promise<StartRegisteredModelResult> {
  const registryPath = options.registryPath ?? defaultRegistryPath();
  const model = await getRegisteredModel(options.displayName, registryPath);
  const launchEnvironment = resolveLaunchEnvironment(
    model,
    options.launchOptionSelections,
  );
  const releaseLock = await acquireLifecycleLock(registryPath);

  try {
    const registeredModels = await getRegisteredModels(registryPath);
    const hasOtherModels = registeredModels.some(
      (model) => model.displayName !== options.displayName,
    );
    const runningModels = hasOtherModels
      ? (await getRunningRegisteredModels(registryPath, options.runtime)).filter(
          (model) => model.displayName !== options.displayName,
        )
      : [];

    if (
      runningModels.length > 0 &&
      !(await options.confirmSwitch?.(runningModels))
    ) {
      return { outcome: "cancelled", runningModels };
    }

    const stoppedModels: RegisteredModel[] = [];
    for (const runningModel of runningModels) {
      options.onStopping?.(runningModel);
      const result = await stopModel({
        displayName: runningModel.displayName,
        registryPath,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      });
      if (result.exitCode !== 0 || result.signal) {
        return { outcome: "stop-failed", model: runningModel, result };
      }
      stoppedModels.push(runningModel);
    }

    const result = await startModel({
      displayName: options.displayName,
      command: options.command,
      environment: launchEnvironment,
      registryPath,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
    return { outcome: "started", result, stoppedModels };
  } finally {
    await releaseLock();
  }
}

/** Reports every registered model's status from Docker without running recipe scripts. */
export async function getModelStatuses(
  registryPath = defaultRegistryPath(),
  runtime: RuntimeController = new DockerRuntimeController(),
): Promise<RegisteredModelStatus[]> {
  return inspectModelStatuses(await getRegisteredModels(registryPath), runtime);
}

export async function getRegisteredModelStatus(
  displayName: string,
  registryPath = defaultRegistryPath(),
  runtime: RuntimeController = new DockerRuntimeController(),
): Promise<RegisteredModelStatus> {
  const model = await getRegisteredModel(displayName, registryPath);
  const [status] = await inspectModelStatuses([model], runtime);
  return status!;
}

async function inspectModelStatuses(
  models: readonly RegisteredModel[],
  runtime: RuntimeController,
): Promise<RegisteredModelStatus[]> {
  let containersByModel: Map<string, RuntimeContainer[]>;
  try {
    containersByModel = await runtime.inspect(models);
  } catch (error) {
    return models.map((model) => ({
      displayName: model.displayName,
      lifecycleState: "unknown",
      runtime: {
        observed: false,
        present: false,
        containers: [],
        error: errorMessage(error),
      },
    }));
  }

  return models.map((model) => {
    const containers = containersByModel.get(model.displayName) ?? [];
    const present = containers.some((container) => container.running);
    return {
      displayName: model.displayName,
      lifecycleState: present ? "running" : "stopped",
      runtime: { observed: true, present, containers, error: null },
    };
  });
}

export async function startModel(
  options: StartModelOptions,
): Promise<CommandResult> {
  return runModelCommand(
    options,
    options.command ?? DEFAULT_START_COMMAND,
    "Start",
    options.environment,
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
  environment?: Readonly<Record<string, string>>,
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
      env: { ...process.env, ...environment },
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
  registryPath = defaultRegistryPath(),
): Promise<RegisteredModel> {
  if (!displayName.trim()) {
    throw new Error("Model display name must not be empty.");
  }

  const registry = await getRegisteredModels(registryPath);
  const model = registry.find((entry) => entry.displayName === displayName);
  if (!model) {
    throw new UnknownModelError(displayName, registryPath);
  }
  return model;
}

export async function getRegisteredModels(
  registryPath = defaultRegistryPath(),
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
  registryPath = defaultRegistryPath(),
  runtime: RuntimeController = new DockerRuntimeController(),
): Promise<RegisteredModel[]> {
  const models = await getRegisteredModels(registryPath);
  const containersByModel = await runtime.inspect(models);
  return models.filter((model) =>
    containersByModel
      .get(model.displayName)
      ?.some((container) => container.running),
  );
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

  const containerNames =
    "containerNames" in entry
      ? parseContainerNames(registryPath, displayName, entry.containerNames)
      : undefined;
  const launchOptions =
    "launchOptions" in entry
      ? parseLaunchOptions(registryPath, displayName, entry.launchOptions)
      : undefined;

  return {
    displayName,
    workspaceDirectory: entry.workspaceDirectory,
    ...(containerNames ? { containerNames } : {}),
    ...(launchOptions ? { launchOptions } : {}),
  };
}

function parseContainerNames(
  registryPath: string,
  displayName: string,
  value: unknown,
): string[] {
  // Docker's own container name rule.
  if (
    !Array.isArray(value) ||
    !value.every(
      (name) =>
        typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name),
    )
  ) {
    throw new Error(
      `Invalid model registry ${registryPath}: model ${JSON.stringify(displayName)} containerNames must be an array of Docker container names.`,
    );
  }
  return value;
}

export function resolveLaunchEnvironment(
  model: RegisteredModel,
  selections: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const options = model.launchOptions ?? [];
  const knownOptionIds = new Set(options.map((option) => option.id));
  const unknownOptionId = Object.keys(selections).find(
    (optionId) => !knownOptionIds.has(optionId),
  );
  if (unknownOptionId) {
    throw new Error(
      `Unknown launch option ${JSON.stringify(unknownOptionId)} for ${JSON.stringify(model.displayName)}.`,
    );
  }

  const environment: Record<string, string> = {};
  for (const option of options) {
    const choiceId = selections[option.id] ?? option.defaultChoice;
    if (choiceId === undefined) {
      throw new Error(
        `Launch option ${JSON.stringify(option.id)} for ${JSON.stringify(model.displayName)} requires a selection.`,
      );
    }
    const choice = option.choices.find((candidate) => candidate.id === choiceId);
    if (!choice) {
      throw new Error(
        `Unknown choice ${JSON.stringify(choiceId)} for launch option ${JSON.stringify(option.id)} on ${JSON.stringify(model.displayName)}.`,
      );
    }

    for (const [name, value] of Object.entries(choice.environment)) {
      const existingValue = environment[name];
      if (existingValue !== undefined && existingValue !== value) {
        throw new Error(
          `Launch options for ${JSON.stringify(model.displayName)} assign conflicting values to ${name}.`,
        );
      }
      environment[name] = value;
    }
  }
  return environment;
}

function parseLaunchOptions(
  registryPath: string,
  displayName: string,
  value: unknown,
): LaunchOption[] {
  if (!Array.isArray(value)) {
    throw invalidLaunchOptions(
      registryPath,
      displayName,
      "launchOptions must be an array",
    );
  }

  const optionIds = new Set<string>();
  return value.map((entry, optionIndex) => {
    const location = `launchOptions[${optionIndex}]`;
    const option = requireRecord(
      registryPath,
      displayName,
      location,
      entry,
    );
    const id = requireIdentifier(
      registryPath,
      displayName,
      `${location}.id`,
      option.id,
    );
    if (optionIds.has(id)) {
      throw invalidLaunchOptions(
        registryPath,
        displayName,
        `${location}.id duplicates ${JSON.stringify(id)}`,
      );
    }
    optionIds.add(id);

    const label = requireNonEmptyString(
      registryPath,
      displayName,
      `${location}.label`,
      option.label,
    );
    const description = optionalNonEmptyString(
      registryPath,
      displayName,
      `${location}.description`,
      option.description,
    );
    if (!Array.isArray(option.choices) || option.choices.length === 0) {
      throw invalidLaunchOptions(
        registryPath,
        displayName,
        `${location}.choices must be a non-empty array`,
      );
    }

    const choiceIds = new Set<string>();
    const choices = option.choices.map((choiceEntry, choiceIndex) => {
      const choiceLocation = `${location}.choices[${choiceIndex}]`;
      const choice = requireRecord(
        registryPath,
        displayName,
        choiceLocation,
        choiceEntry,
      );
      const choiceId = requireIdentifier(
        registryPath,
        displayName,
        `${choiceLocation}.id`,
        choice.id,
      );
      if (choiceIds.has(choiceId)) {
        throw invalidLaunchOptions(
          registryPath,
          displayName,
          `${choiceLocation}.id duplicates ${JSON.stringify(choiceId)}`,
        );
      }
      choiceIds.add(choiceId);

      const environment = parseEnvironment(
        registryPath,
        displayName,
        `${choiceLocation}.environment`,
        choice.environment,
      );
      return {
        id: choiceId,
        label: requireNonEmptyString(
          registryPath,
          displayName,
          `${choiceLocation}.label`,
          choice.label,
        ),
        ...optionalProperty(
          "description",
          optionalNonEmptyString(
            registryPath,
            displayName,
            `${choiceLocation}.description`,
            choice.description,
          ),
        ),
        environment,
      };
    });

    const defaultChoice = optionalNonEmptyString(
      registryPath,
      displayName,
      `${location}.defaultChoice`,
      option.defaultChoice,
    );
    if (defaultChoice !== undefined && !choiceIds.has(defaultChoice)) {
      throw invalidLaunchOptions(
        registryPath,
        displayName,
        `${location}.defaultChoice must match a choice id`,
      );
    }

    return {
      id,
      label,
      ...optionalProperty("description", description),
      ...optionalProperty("defaultChoice", defaultChoice),
      choices,
    };
  });
}

function parseEnvironment(
  registryPath: string,
  displayName: string,
  location: string,
  value: unknown,
): Record<string, string> {
  const environment = requireRecord(
    registryPath,
    displayName,
    location,
    value,
  );
  if (Object.keys(environment).length === 0) {
    throw invalidLaunchOptions(
      registryPath,
      displayName,
      `${location} must not be empty`,
    );
  }
  return Object.fromEntries(
    Object.entries(environment).map(([name, entry]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw invalidLaunchOptions(
          registryPath,
          displayName,
          `${location} contains invalid environment variable ${JSON.stringify(name)}`,
        );
      }
      if (typeof entry !== "string") {
        throw invalidLaunchOptions(
          registryPath,
          displayName,
          `${location}.${name} must be a string`,
        );
      }
      return [name, entry];
    }),
  );
}

function requireRecord(
  registryPath: string,
  displayName: string,
  location: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidLaunchOptions(
      registryPath,
      displayName,
      `${location} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(
  registryPath: string,
  displayName: string,
  location: string,
  value: unknown,
): string {
  const identifier = requireNonEmptyString(
    registryPath,
    displayName,
    location,
    value,
  );
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(identifier)) {
    throw invalidLaunchOptions(
      registryPath,
      displayName,
      `${location} must start with a letter and contain only letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return identifier;
}

function requireNonEmptyString(
  registryPath: string,
  displayName: string,
  location: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidLaunchOptions(
      registryPath,
      displayName,
      `${location} must be a non-empty string`,
    );
  }
  return value;
}

function optionalNonEmptyString(
  registryPath: string,
  displayName: string,
  location: string,
  value: unknown,
): string | undefined {
  return value === undefined
    ? undefined
    : requireNonEmptyString(
        registryPath,
        displayName,
        location,
        value,
      );
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: Value });
}

function invalidLaunchOptions(
  registryPath: string,
  displayName: string,
  detail: string,
): Error {
  return new Error(
    `Invalid model registry ${registryPath}: model ${JSON.stringify(displayName)} ${detail}.`,
  );
}

async function acquireLifecycleLock(
  registryPath: string,
): Promise<() => Promise<void>> {
  const managerDirectory = dirname(registryPath);
  const lockDirectory = join(managerDirectory, "lifecycle.lock");
  await mkdir(managerDirectory, { recursive: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockDirectory);
      try {
        await writeFile(join(lockDirectory, "pid"), `${process.pid}\n`);
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        await rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      const ownerPid = await readLockOwner(join(lockDirectory, "pid"));
      if (ownerPid !== undefined && processIsRunning(ownerPid)) {
        throw new Error(
          `Another spark-manager start operation is already running (PID ${ownerPid}).`,
        );
      }
      if (ownerPid === undefined) {
        throw new Error(
          `The spark-manager lifecycle lock has no valid owner: ${lockDirectory}`,
        );
      }

      const staleLockDirectory = `${lockDirectory}.stale-${process.pid}-${attempt}`;
      try {
        await rename(lockDirectory, staleLockDirectory);
        await rm(staleLockDirectory, { recursive: true, force: true });
      } catch (renameError) {
        if (!isNodeError(renameError) || renameError.code !== "ENOENT") {
          throw renameError;
        }
      }
    }
  }

  throw new Error("Unable to acquire the spark-manager lifecycle lock.");
}

async function readLockOwner(path: string): Promise<number | undefined> {
  try {
    const ownerPid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : undefined;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}
