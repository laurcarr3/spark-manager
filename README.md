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

Start with the tracked [`registry.example.json`](./registry.example.json), which
contains entries for the three supported recipes:

```bash
mkdir -p ~/.spark-manager
cp registry.example.json ~/.spark-manager/registry.json
```

Edit the copied file so every `workspaceDirectory` points to the corresponding
local recipe checkout. Each object key is the model name used by the CLI, and
model names must be non-empty. Each `workspaceDirectory` must exist. The CLI
runs `./start.sh`, `./stop.sh`, and `./start.sh ps` in the registered workspace
without invoking a shell.

```bash
pnpm dev:cli start deepseek-v4
pnpm dev:cli stop deepseek-v4
pnpm dev:cli status
pnpm dev:cli status deepseek-v4
pnpm dev:cli list
```

Before starting a model, the CLI checks running Docker containers for mounts or
Compose metadata associated with the other registered workspaces. If another
registered model is running, it asks for confirmation before stopping that
model and starting the requested one. Concurrent start attempts are serialized.

## HTTP API

The API exposes the same list, status, start, stop, and model-switch behavior as
the CLI. It listens only on `127.0.0.1` and uses port `3000` by default.

```bash
pnpm dev:api

curl http://127.0.0.1:3000/models
curl http://127.0.0.1:3000/models/status
curl http://127.0.0.1:3000/models/DeepSeek-v4/status
curl -X POST -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:3000/models/DeepSeek-v4/start
curl -X POST -H 'Content-Type: application/json' \
  -d '{"switchRunning":true}' http://127.0.0.1:3000/models/DeepSeek-v4/start
curl -X POST -H 'Content-Type: application/json' \
  http://127.0.0.1:3000/models/DeepSeek-v4/stop
```

Model names in URLs must be URL-encoded. A start request returns `409` when
another registered model is running unless `switchRunning` is `true`. Mutation
requests require a JSON content type, which also prevents ordinary cross-origin
HTML forms from triggering local lifecycle operations.

Set `SPARK_MANAGER_API_PORT` to choose another port. For an additional local
authentication layer, set `SPARK_MANAGER_API_TOKEN`; all requests must then send
`Authorization: Bearer <token>`.

```bash
cp .env.example .env
# Edit .env as needed, then export its values into the current shell.
set -a && source .env && set +a
pnpm dev:api
```

If a token is configured, include it in requests:

```bash
curl -H 'Authorization: Bearer replace-with-a-long-random-value' \
  http://127.0.0.1:3000/models
```

## Relevant recipes

- [DeepSeek-v4-Flash-One-DGX-Spark](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-One-DGX-Spark/)
- [Qwen3.8-27B-SGLang-DGX-Spark](https://github.com/MiaAI-Lab/Qwen3.8-27B-SGLang-DGX-Spark)
- [Qwen3.8-Flash-Next-Single-DGX-Spark](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark)
