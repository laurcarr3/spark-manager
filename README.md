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
runs `./start.sh` and `./stop.sh` in the registered workspace without invoking a
shell. Status never runs recipe scripts (some recipes start the model when given
`ps`); it is read from Docker instead.

Spark Manager links Docker containers to a model when a container mounts a path
inside the workspace or carries a Compose `working_dir` label inside it. Recipes
that start a plain `docker run` container with neither (such as TensorFold, which
mounts only cache directories) must list their container names in the optional
`containerNames` array, for example `"containerNames": ["qwen38-flash-next-tf"]`.
Otherwise a running model is reported as stopped and the switch check misses it.

Registry entries may also declare interactive launch options. Spark Manager does
not interpret these as memory settings or runtime flags: each choice is simply a
recipe-owned environment map passed to `./start.sh`. This keeps the option system
usable for context profiles, quantization modes, speculative decoding, or any
future recipe setting.

```json
{
  "example-model": {
    "workspaceDirectory": "/models/example",
    "launchOptions": [
      {
        "id": "context-profile",
        "label": "Context profile",
        "description": "Choose a profile calibrated by this recipe.",
        "defaultChoice": "balanced",
        "choices": [
          {
            "id": "compact",
            "label": "Compact",
            "environment": {
              "MAX_MODEL_LEN": "65536",
              "MAX_NUM_SEQS": "1",
              "KV_TARGET_GIB": "2"
            }
          },
          {
            "id": "balanced",
            "label": "Balanced",
            "environment": {
              "MAX_MODEL_LEN": "131072",
              "MAX_NUM_SEQS": "2",
              "KV_TARGET_GIB": "6"
            }
          }
        ]
      }
    ]
  }
}
```

When the CLI starts a model, it presents every declared option and accepts either
the choice number or choice ID. Pressing Enter selects `defaultChoice`. Defaults
are also used when a non-interactive caller does not provide a selection. An
option without a default requires an explicit selection, and conflicting
environment assignments are rejected instead of relying on option order.

```bash
pnpm dev:cli start deepseek-v4
pnpm dev:cli stop deepseek-v4
pnpm dev:cli status
pnpm dev:cli status deepseek-v4
pnpm dev:cli list
```

`status` prints one tab-separated line per model: the display name, its state
(`running`, `stopped`, or `unknown` when Docker cannot be queried), and the names
of its running containers. It exits with status 1 when Docker is unavailable.

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
curl http://127.0.0.1:3000/models/running
curl http://127.0.0.1:3000/models/DeepSeek-v4/status
curl -X POST -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:3000/models/DeepSeek-v4/start
curl -X POST -H 'Content-Type: application/json' \
  -d '{"switchRunning":true}' http://127.0.0.1:3000/models/DeepSeek-v4/start
curl -X POST -H 'Content-Type: application/json' \
  -d '{"launchOptionSelections":{"context-profile":"compact"}}' \
  http://127.0.0.1:3000/models/deepseek-v4/start
curl -X POST -H 'Content-Type: application/json' \
  http://127.0.0.1:3000/models/DeepSeek-v4/stop
```

Model names in URLs must be URL-encoded. Unknown names return `404`
`MODEL_NOT_FOUND`.

### Status

`GET /models/status` returns `{ "models": [...] }` and
`GET /models/:displayName/status` returns `{ "model": {...} }`. Status is
derived from Docker; recipe scripts are never run. A container belongs to a model
when its name is listed in the model's `containerNames`, or when its Compose
`working_dir` label or any mount source is inside the model's workspace.

```jsonc
{
  "displayName": "qwen3.8-27b",
  "lifecycleState": "running",   // "running", "stopped", or "unknown"
  "runtime": {
    "observed": true,            // false when Docker could not be queried
    "present": true,             // a container owned by the workspace is running
    "containers": [
      {
        "id": "4f0c…",
        "name": "qwen-sglang",
        "running": true,
        "restarting": false,
        "status": "running",     // Docker State.Status
        "exitCode": null,        // set only for stopped containers
        "oomKilled": false,
        "restartCount": 0,
        "startedAt": "2026-10-29T09:12:44.123Z",
        "finishedAt": null
      }
    ],
    "error": null                // the Docker error when observed is false
  }
}
```

`containers` lists running and recently exited containers, newest first. If
Docker is unavailable the endpoints still return `200`, with
`lifecycleState: "unknown"`, `observed: false`, and the error message.

**Breaking change:** the status endpoints previously returned the output of
`./start.sh ps` (`command.stdout`, `command.exitCode`) alongside the registry
entry. They now return the structure above, without registry fields; use
`GET /models` for those.

### Start and stop

A start request returns `409` when
another registered model is running unless `switchRunning` is `true`. Mutation
requests require a JSON content type, which also prevents ordinary cross-origin
HTML forms from triggering local lifecycle operations.

The optional `launchOptionSelections` object maps registry option IDs to choice
IDs. Omitted options use their declared defaults; options without a default
must be selected explicitly.

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
- [Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold)
