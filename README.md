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

## Model workspace

Pass the path to a checked-out model recipe directly to the CLI. The status
command runs `./start.sh ps` in that workspace without invoking a shell.

```bash
pnpm dev:cli status \
  --workspace /home/calvin/models/DeepSeek-v4-Flash-One-DGX-Spark
```

## Relevant recipes

- [DeepSeek-v4-Flash-One-DGX-Spark](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-One-DGX-Spark/)
- [Qwen3.8-27B-SGLang-DGX-Spark](https://github.com/MiaAI-Lab/Qwen3.8-27B-SGLang-DGX-Spark)
- [Qwen3.8-Flash-Next-Single-DGX-Spark](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark)
