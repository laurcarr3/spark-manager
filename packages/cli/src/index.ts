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
  spark-manager start --workspace <path>
  spark-manager stop --workspace <path>
  spark-manager status --workspace <path>
  spark-manager <command>

Commands:
  start      Run ./start.sh in a model workspace
  stop       Run ./start.sh stop in a model workspace
  status     Run ./start.sh ps in a model workspace
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
      return runWorkspaceCommand("start", commandArgs, startModel, "Start");
    case "stop":
      return runWorkspaceCommand("stop", commandArgs, stopModel, "Stop");
    case "status": {
      return runWorkspaceCommand(
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

async function runWorkspaceCommand(
  command: string,
  args: string[],
  operation: (options: { workspaceDir: string }) => Promise<CommandResult>,
  displayName: string,
): Promise<number> {
  const workspaceDir = parseWorkspace(args);
  if (!workspaceDir) {
    console.error(`Usage: spark-manager ${command} --workspace <path>`);
    return 1;
  }

  const result = await operation({ workspaceDir });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.signal) {
    console.error(`${displayName} command terminated by ${result.signal}.`);
  }
  return result.exitCode;
}

function parseWorkspace(args: string[]): string | undefined {
  if (args.length !== 2 || args[0] !== "--workspace") {
    return undefined;
  }
  return args[1] || undefined;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
