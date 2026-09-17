#!/usr/bin/env node

const HELP = `spark-manager

Manage local models on an NVIDIA DGX Spark.

Usage:
  spark-manager <command>

Commands:
  help       Show this help message
  version    Show the current version
`;

const command = process.argv[2] ?? "help";

switch (command) {
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log("0.0.0");
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.error(HELP);
    process.exitCode = 1;
}
