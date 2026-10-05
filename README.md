# spark-manager

A TypeScript utility for managing local models on my DGX Spark.

While project is currently a standalone CLI and HTTP API, I have created it to utilize with my fork of sparkDash.

## Project layout

```text
packages/
  api/    HTTP API entry point
  cli/    Command-line entry point
  core/   Shared types and model-management logic
```

## Development

Requires Node.js 20 or newer and pnpm.

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm dev:cli --help
pnpm dev:api
```

## Model registry

Create `~/.spark-manager/registry.json` and manually add each model workspace:

```json
{
  "deepseek-v4": {
    "workspaceDirectory": "/home/calvin/Desktop/DeepSeek-v4-Flash-One-DGX-Spark"
  },
  "qwen3-next": {
    "workspaceDirectory": "/home/calvin/Desktop/Qwen3.8-Flash-Next-Single-DGX-Spark"
  }
}
```

Each object key is the model name used by the CLI. Model names must be non-empty,
and each `workspaceDirectory` must exist. The start, stop, and status commands
run `./start.sh`, `./stop.sh`, and `./start.sh ps`, respectively, in the
registered workspace without invoking a shell.

```bash
pnpm dev:cli start deepseek-v4
pnpm dev:cli stop deepseek-v4
pnpm dev:cli status deepseek-v4
```

## Relevant recipes

- [DeepSeek-v4-Flash-One-DGX-Spark](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-One-DGX-Spark/)
- [Qwen3.8-27B-SGLang-DGX-Spark](https://github.com/MiaAI-Lab/Qwen3.8-27B-SGLang-DGX-Spark)
- [Qwen3.8-Flash-Next-Single-DGX-Spark](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark)
