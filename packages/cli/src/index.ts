#!/usr/bin/env node

import { createInterface } from "node:readline";

import {
  getModelStatus,
  getRegisteredModel,
  getRegisteredModels,
  startRegisteredModel,
  stopModel,
  type CommandResult,
  type LaunchOption,
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

  const model = await getRegisteredModel(modelDisplayName);
  const prompt = new PromptSession();
  let result: Awaited<ReturnType<typeof startRegisteredModel>>;
  try {
    const launchOptionSelections = await promptForLaunchOptions(
      model.launchOptions ?? [],
      prompt,
    );
    result = await startRegisteredModel({
      displayName: modelDisplayName,
      launchOptionSelections,
      onStdout: writeStdout,
      onStderr: writeStderr,
      confirmSwitch: async (runningModels) => {
        const runningNames = runningModels
          .map((runningModel) => JSON.stringify(runningModel.displayName))
          .join(", ");
        return promptYesNo(
          prompt,
          `${runningModels.length === 1 ? "Model" : "Models"} ${runningNames} ${runningModels.length === 1 ? "is" : "are"} running. Stop ${runningModels.length === 1 ? "it" : "them"} and start ${JSON.stringify(modelDisplayName)}? [y/N] `,
        );
      },
      onStopping: (runningModel) => {
        console.log(`Stopping ${JSON.stringify(runningModel.displayName)}...`);
      },
    });
  } finally {
    prompt.close();
  }

  if (result.outcome === "cancelled") {
    console.error("Start cancelled.");
    return 1;
  }
  if (result.outcome === "stop-failed") {
    if (result.result.signal) {
      console.error(
        `Stop command for ${JSON.stringify(result.model.displayName)} terminated by ${result.result.signal}.`,
      );
    }
    console.error(
      `Unable to start ${JSON.stringify(modelDisplayName)} because ${JSON.stringify(result.model.displayName)} could not be stopped.`,
    );
    return result.result.exitCode;
  }

  if (result.result.signal) {
    console.error(`Start command terminated by ${result.result.signal}.`);
  }
  return result.result.exitCode;
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

async function promptForLaunchOptions(
  options: readonly LaunchOption[],
  prompt: PromptSession,
): Promise<Record<string, string>> {
  const selections: Record<string, string> = {};
  for (const option of options) {
    console.log(`\n${option.label}`);
    if (option.description) {
      console.log(option.description);
    }
    option.choices.forEach((choice, index) => {
      const defaultMarker =
        choice.id === option.defaultChoice ? " (default)" : "";
      console.log(`  ${index + 1}) ${choice.label}${defaultMarker}`);
      if (choice.description) {
        console.log(`     ${choice.description}`);
      }
    });

    while (true) {
      const defaultChoiceIndex = option.defaultChoice
        ? option.choices.findIndex(
            (choice) => choice.id === option.defaultChoice,
          )
        : -1;
      const defaultPrompt =
        defaultChoiceIndex >= 0 ? ` [${defaultChoiceIndex + 1}]` : "";
      const answer = await prompt.question(
        `Select 1-${option.choices.length}${defaultPrompt}: `,
      );
      if (answer === undefined) {
        throw new Error("Interactive launch option selection was cancelled.");
      }

      const normalizedAnswer = answer.trim();
      const selectedNumber = Number(normalizedAnswer);
      const choice =
        normalizedAnswer === "" && defaultChoiceIndex >= 0
          ? option.choices[defaultChoiceIndex]
          : (Number.isSafeInteger(selectedNumber)
              ? option.choices[selectedNumber - 1]
              : undefined) ??
            option.choices.find(
              (candidate) => candidate.id === normalizedAnswer,
            );
      if (choice) {
        selections[option.id] = choice.id;
        break;
      }
      console.error(
        `Choose a number from 1 to ${option.choices.length}${option.defaultChoice ? ", or press Enter for the default" : ""}.`,
      );
    }
  }
  return selections;
}

async function promptYesNo(
  prompt: PromptSession,
  question: string,
): Promise<boolean> {
  const answer = await prompt.question(question);
  return answer !== undefined && ["y", "yes"].includes(answer.trim().toLowerCase());
}

class PromptSession {
  readonly #readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  readonly #answers: string[] = [];
  readonly #waiters: Array<(answer: string | undefined) => void> = [];
  #closed = false;

  constructor() {
    this.#readline.on("line", (answer) => {
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(answer);
      } else {
        this.#answers.push(answer);
      }
    });
    this.#readline.once("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter(undefined);
      }
    });
  }

  question(question: string): Promise<string | undefined> {
    process.stdout.write(question);
    const queuedAnswer = this.#answers.shift();
    if (queuedAnswer !== undefined) {
      return Promise.resolve(queuedAnswer);
    }
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolveAnswer) => this.#waiters.push(resolveAnswer));
  }

  close(): void {
    if (!this.#closed) {
      this.#readline.close();
    }
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
