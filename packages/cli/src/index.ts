#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  getModelStatus,
  getRegisteredModel,
  getRegisteredModels,
  getRunningRegisteredModels,
  startModel,
  stopModel,
  type CommandResult,
} from "@spark-manager/core";

const HELP = `spark-manager

Manage local models on an NVIDIA DGX Spark.

Usage:
  spark-manager start "<display name>"
  spark-manager stop "<display name>"
  spark-manager status
  spark-manager status "<display name>"
  spark-manager list
  spark-manager <command>

Commands:
  start      Start a registered model
  stop       Stop a registered model
  status     Check every registered model's status
  list       List registered models and their workspaces
  help       Show this help message
  version    Show the current version
`;

async function main(args: string[]): Promise<number> {
  const [command, ...commandArgs] = args;

  switch (command ?? "help") {
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "version":
    case "--version":
    case "-v":
      console.log("0.0.0");
      return 0;
    case "start":
      return runStartCommand(commandArgs);
    case "stop":
      return runModelCommand("stop", commandArgs, stopModel, "Stop");
    case "status":
      return runStatusCommand(commandArgs);
    case "list":
      return runListCommand(commandArgs);
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 1;
  }
}

async function runStartCommand(args: string[]): Promise<number> {
  const modelDisplayName = parseDisplayName(args);
  if (!modelDisplayName) {
    console.error('Usage: spark-manager start "<display name>"');
    return 1;
  }

  await getRegisteredModel(modelDisplayName);
  const releaseLock = await acquireLifecycleLock();
  try {
    const registeredModels = await getRegisteredModels();
    const otherRegisteredModels = registeredModels.filter(
      (model) => model.displayName !== modelDisplayName,
    );
    if (otherRegisteredModels.length > 0) {
      const runningModels = (await getRunningRegisteredModels()).filter(
        (model) => model.displayName !== modelDisplayName,
      );
      if (runningModels.length > 0) {
        const runningNames = runningModels
          .map((model) => JSON.stringify(model.displayName))
          .join(", ");
        const shouldSwitch = await promptYesNo(
          `${runningModels.length === 1 ? "Model" : "Models"} ${runningNames} ${runningModels.length === 1 ? "is" : "are"} running. Stop ${runningModels.length === 1 ? "it" : "them"} and start ${JSON.stringify(modelDisplayName)}? [y/N] `,
        );
        if (!shouldSwitch) {
          console.error("Start cancelled.");
          return 1;
        }

        for (const runningModel of runningModels) {
          console.log(
            `Stopping ${JSON.stringify(runningModel.displayName)}...`,
          );
          const result = await stopModel({
            displayName: runningModel.displayName,
            onStdout: writeStdout,
            onStderr: writeStderr,
          });
          if (result.signal) {
            console.error(
              `Stop command for ${JSON.stringify(runningModel.displayName)} terminated by ${result.signal}.`,
            );
          }
          if (result.exitCode !== 0) {
            console.error(
              `Unable to start ${JSON.stringify(modelDisplayName)} because ${JSON.stringify(runningModel.displayName)} could not be stopped.`,
            );
            return result.exitCode;
          }
        }
      }
    }

    return runModelCommand("start", args, startModel, "Start");
  } finally {
    await releaseLock();
  }
}

async function runStatusCommand(args: string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && !args[0]?.trim())) {
    console.error('Usage: spark-manager status ["<display name>"]');
    return 1;
  }

  const models = args[0]
    ? [await getRegisteredModel(args[0])]
    : await getRegisteredModels();
  let exitCode = 0;
  for (const model of models) {
    console.log(`${model.displayName}:`);
    try {
      const result = await getModelStatus({ displayName: model.displayName });
      writeCommandOutput(result, true);
      if (result.signal) {
        console.error(
          `Status command for ${JSON.stringify(model.displayName)} terminated by ${result.signal}.`,
        );
      }
      if (exitCode === 0 && result.exitCode !== 0) {
        exitCode = result.exitCode;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      exitCode = exitCode || 1;
    }
  }
  return exitCode;
}

async function runListCommand(args: string[]): Promise<number> {
  if (args.length > 0) {
    console.error("Usage: spark-manager list");
    return 1;
  }

  const models = await getRegisteredModels();
  for (const model of models) {
    console.log(`${model.displayName}\t${model.workspaceDirectory}`);
  }
  return 0;
}

async function runModelCommand(
  command: string,
  args: string[],
  operation: (options: {
    displayName: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
  }) => Promise<CommandResult>,
  commandDisplayName: string,
): Promise<number> {
  const modelDisplayName = parseDisplayName(args);
  if (!modelDisplayName) {
    console.error(`Usage: spark-manager ${command} "<display name>"`);
    return 1;
  }

  const result = await operation({
    displayName: modelDisplayName,
    onStdout: writeStdout,
    onStderr: writeStderr,
  });
  if (result.signal) {
    console.error(`${commandDisplayName} command terminated by ${result.signal}.`);
  }
  return result.exitCode;
}

function writeStdout(chunk: string): void {
  process.stdout.write(chunk);
}

function writeStderr(chunk: string): void {
  process.stderr.write(chunk);
}

function writeCommandOutput(
  result: CommandResult,
  ensureFinalNewline = false,
): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
    if (ensureFinalNewline && !result.stdout.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
    if (ensureFinalNewline && !result.stderr.endsWith("\n")) {
      process.stderr.write("\n");
    }
  }
}

function parseDisplayName(args: string[]): string | undefined {
  if (args.length !== 1) {
    return undefined;
  }
  return args[0]?.trim() ? args[0] : undefined;
}

async function promptYesNo(question: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolveAnswer) => {
    let answered = false;
    const finish = (answer: boolean) => {
      if (answered) {
        return;
      }
      answered = true;
      readline.close();
      resolveAnswer(answer);
    };

    readline.once("close", () => finish(false));
    readline.question(question, (answer) => {
      finish(["y", "yes"].includes(answer.trim().toLowerCase()));
    });
  });
}

async function acquireLifecycleLock(): Promise<() => Promise<void>> {
  const managerDirectory = join(homedir(), ".spark-manager");
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
