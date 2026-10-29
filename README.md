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
curl http://127.0.0.1:3000/operations/op_0123456789abcdef0123456789abcdef
```

Model names in URLs must be URL-encoded. Names longer than 256 characters or
containing control characters return `400` `INVALID_MODEL_NAME`; unknown names
return `404` `MODEL_NOT_FOUND`. Errors have the shape
`{ "error": { "code": "...", "message": "...", ...details } }`.

### Status

`GET /models/status` returns `{ "models": [...] }` and
`GET /models/:displayName/status` returns `{ "model": {...} }`. Status is
derived from Docker; recipe scripts are never run. A container belongs to a model
when its name is listed in the model's `containerNames`, or when its Compose
`working_dir` label or any mount source is inside the model's workspace.

```jsonc
{
  "displayName": "qwen3.8-27b",
  "lifecycleState": "running",   // see below
  "desiredState": "running",     // last requested: "running", "stopped", or null
  "activeOperation": null,       // { operationId, kind, status } while one runs
  "lastOperation": {             // the most recent finished operation, or null
    "operationId": "op_…",
    "kind": "start",
    "status": "succeeded"
  },
  "lastError": null,             // the most recent failure (see Operations); a later success keeps it
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

`lifecycleState` is derived in this order:

1. An operation is active for the model: `queued`, then `starting` or
   `stopping` once it runs.
2. The model's last operation failed: `failed`. This is not terminal; a new
   start or stop is allowed.
3. Docker could not be queried: `unknown`.
4. A container owned by the workspace is running: `running`; otherwise
   `stopped`.

`containers` lists running and recently exited containers, newest first. If
Docker is unavailable the endpoints still return `200`, with `observed: false`
and the error message.

Operation history, `desiredState`, and `lastError` are held in memory and are
lost when the API restarts.

**Breaking change:** the status endpoints previously returned the output of
`./start.sh ps` (`command.stdout`, `command.exitCode`) alongside the registry
entry. They now return the structure above, without registry fields; use
`GET /models` for those.

### Start and stop

`POST /models/:displayName/start` accepts
`{ "switchRunning"?: boolean, "launchOptionSelections"?: { [optionId]: choiceId } }`.
`POST /models/:displayName/stop` accepts an empty body or `{}`. Unknown fields
or wrong types return `400` `INVALID_REQUEST`. Mutation requests require a JSON
content type (`415` otherwise), which also prevents ordinary cross-origin HTML
forms from triggering local lifecycle operations.

The optional `launchOptionSelections` object maps registry option IDs to choice
IDs. Omitted options use their declared defaults; options without a default
must be selected explicitly. Invalid selections return `400`
`INVALID_LAUNCH_OPTIONS`.

Both endpoints run `./start.sh` or `./stop.sh` in the background and return
`202` immediately, with a `Location: /operations/:operationId` header:

```json
{
  "operationId": "op_…",
  "kind": "start",
  "model": "qwen3.8-27b",
  "desiredState": "running",
  "lifecycleState": "queued",
  "operationStatus": "queued",
  "statusUrl": "/operations/op_…",
  "modelStatusUrl": "/models/qwen3.8-27b/status"
}
```

Poll `statusUrl` and `modelStatusUrl` to follow progress. A start finishes when
`./start.sh` exits (recipes exit once the model is healthy), so it can take a
long time; it times out after 3 hours. A stop times out after 5 minutes.

Only one operation runs at a time across all models. A request is refused with:

| Status | Code | When |
| --- | --- | --- |
| `409` | `OPERATION_IN_PROGRESS` | This model already has an active operation. Details: `activeOperationId`, `activeModel`. |
| `409` | `LIFECYCLE_BUSY` | Another model's operation is active. Same details. |
| `409` | `MODEL_ALREADY_RUNNING` | Another model is running and `switchRunning` is not `true`. Details: `runningModels`. |
| `409` | `LIFECYCLE_LOCK_HELD` | The CLI is starting a model. |
| `503` | `RUNTIME_INSPECTION_FAILED` | Docker could not be queried to check for other running models. |

With `switchRunning: true`, the start operation runs each other running model's
`./stop.sh` before `./start.sh`.

On `SIGINT` or `SIGTERM` the API terminates any running `start.sh` or `stop.sh`
(and the helpers they started) before exiting. Model containers keep running.

### Operations

`GET /operations/:operationId` returns `{ "operation": {...} }`. IDs not
matching `op_` plus 32 lowercase hex characters return `400`
`INVALID_OPERATION_ID`; unknown IDs return `404` `OPERATION_NOT_FOUND`. The
last 10 operations per model are kept.

```jsonc
{
  "operationId": "op_…",
  "kind": "start",               // or "stop"
  "displayName": "qwen3.8-27b",
  "status": "failed",            // "queued", "running", "succeeded", or "failed"
  "requestId": "…",              // the x-request-id of the request that created it
  "options": { "switchRunning": false, "launchOptionSelections": { "context-profile": "compact" } },
  "createdAt": "…",
  "startedAt": "…",
  "finishedAt": "…",
  "command": { "exitCode": 3, "signal": null },   // null if no script ran
  "error": {                     // null unless failed
    "operationId": "op_…",
    "kind": "start",
    "code": "START_COMMAND_FAILED",
    "message": "The start command exited with status 3.",
    "at": "…",
    "exitCode": 3,
    "signal": null,
    "retrySafe": false,          // true when nothing was left half-running
    "logTail": []
  }
}
```

Operation error codes:

| Code | Meaning |
| --- | --- |
| `CONFLICTING_MODEL_STOP_FAILED` | `switchRunning` could not stop the other model; the requested model was not started. |
| `START_COMMAND_UNAVAILABLE` | `start.sh` is missing or not executable, or the workspace is invalid. |
| `START_COMMAND_FAILED` | `start.sh` exited non-zero or was killed by a signal. |
| `STARTUP_TIMEOUT` | `start.sh` did not finish in time and was terminated. |
| `STOP_COMMAND_UNAVAILABLE` | The model has no `stop.sh`. |
| `STOP_COMMAND_FAILED` | `stop.sh` exited non-zero or was killed by a signal. |
| `STOP_TIMEOUT` | `stop.sh` did not finish in time and was terminated. |
| `INTERNAL_ERROR` | An unexpected error. |

**Breaking change:** start and stop previously waited for the recipe script and
returned `200` (or `502` `COMMAND_FAILED` with the command output). They now
return `202` with an operation, and there is no synchronous mode.

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
