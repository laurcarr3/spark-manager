#!/usr/bin/env node

import {
  getModelStatus,
  startModel,
  stopModel,
  type CommandResult,
} from "@spark-manager/core";

const HELP = `spark-manager

Manage local models on an NVIDIA DGX Spark.

Usage:
  spark-manager start "<display name>"
  spark-manager stop "<display name>"
  spark-manager status "<display name>"
  spark-manager <command>

Commands:
  start      Start a registered model
  stop       Stop a registered model
  status     Check a registered model's status
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
      return runModelCommand("start", commandArgs, startModel, "Start");
    case "stop":
      return runModelCommand("stop", commandArgs, stopModel, "Stop");
    case "status": {
      return runModelCommand(
        "status",
        commandArgs,
        getModelStatus,
        "Status",
      );
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 1;
  }
}

async function runModelCommand(
  command: string,
  args: string[],
  operation: (options: { displayName: string }) => Promise<CommandResult>,
  commandDisplayName: string,
): Promise<number> {
  const modelDisplayName = parseDisplayName(args);
  if (!modelDisplayName) {
    console.error(`Usage: spark-manager ${command} "<display name>"`);
    return 1;
  }

  const result = await operation({ displayName: modelDisplayName });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.signal) {
    console.error(`${commandDisplayName} command terminated by ${result.signal}.`);
  }
  return result.exitCode;
}

function parseDisplayName(args: string[]): string | undefined {
  if (args.length !== 1) {
    return undefined;
  }
  return args[0]?.trim() ? args[0] : undefined;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
