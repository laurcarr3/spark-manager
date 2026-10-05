#!/usr/bin/env node

import { getModelStatus } from "@spark-manager/core";

const HELP = `spark-manager

Manage local models on an NVIDIA DGX Spark.

Usage:
  spark-manager status --workspace <path>
  spark-manager <command>

Commands:
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
    case "status": {
      const workspaceDir = parseWorkspace(commandArgs);
      if (!workspaceDir) {
        console.error("Usage: spark-manager status --workspace <path>");
        return 1;
      }

      const result = await getModelStatus({ workspaceDir });
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      if (result.signal) {
        console.error(`Status command terminated by ${result.signal}.`);
      }
      return result.exitCode;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 1;
  }
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
