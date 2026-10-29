# Model lifecycle: layered implementation plan

This plan describes how to add observable, asynchronous model lifecycle
operations to spark-manager. Each layer is built on the one before it.

An earlier attempt implemented the full specification in one pass. It worked
(56 tests passing), but it was too complex for a personal utility: the core
manager alone was about 1,800 lines. That code was reverted. This document
keeps what was learned from it, including the reusable code (inlined in the
appendices), the pitfalls found during testing, and facts about the recipes
that are not obvious from this repository.

**Context:** spark-manager is a single-user tool on one DGX Spark. Models are
started and stopped a few times a day, and only one model can run at a time
because they share the GPU and port 8888. Prefer simple designs that suit that
scale.

**How to use this plan**

- Implement one layer at a time. Each layer is one commit that passes
  `pnpm typecheck` and `pnpm test`, and updates the README API section in the
  same commit.
- Do not start a layer until the previous one is merged and working.
- Layers 1 to 4 deliver most of the value. Layers 5 to 7 are hardening.
  Anything under "Optional extras" needs an explicit decision from the user
  before it is built.
- Do not modify sparkDash (a separate consumer of this API) as part of this
  work unless asked.

---

## 1. Baseline (commit `eecfd39`)

### Repository

- pnpm workspace with three packages: `packages/core`, `packages/cli` and
  `packages/api`.
- TypeScript 7 (`tsc -b`, NodeNext, strict), Node 22, Express 5, `node:test`.
- There is no linter; `pnpm typecheck` (`tsc -b --pretty false`) is the only
  static check.
- `pnpm test` builds, then runs `node --test` on
  `packages/{core,cli,api}/test/*.test.mjs`. Tests import from `../dist`.

### Core (`packages/core/src/index.ts`)

- The registry is `~/.spark-manager/registry.json` (`defaultRegistryPath()`).
  It maps a display name to `{ workspaceDirectory, launchOptions? }`.
- Launch options are validated, and `resolveLaunchEnvironment(model,
  selections)` turns the selections into environment variables.
- `startModel`, `stopModel` and `getModelStatus` run `./start.sh`, `./stop.sh`
  and `./start.sh ps` in the workspace and wait for them to finish
  (`runModelCommand`).
- `startRegisteredModel` acquires the lifecycle lock, finds other running
  models, stops them if `confirmSwitch` allows it, then starts the requested
  model.
- `getRunningRegisteredModels()` runs `docker ps` plus `docker inspect` and
  matches containers to workspaces with `containerBelongsToWorkspace`
  (Appendix A).
- `acquireLifecycleLock(registryPath)` creates a directory lock at
  `~/.spark-manager/lifecycle.lock` holding a `pid` file. It removes stale
  locks whose owner process is dead. The CLI uses the same lock.

### API (`packages/api/src/app.ts`)

- A request-ID middleware writes structured JSON logs (`log(level, event,
  fields)`).
- If `SPARK_MANAGER_API_TOKEN` is set, the `requireBearerToken` middleware is
  registered **before every route**, so any route added after it inherits
  authentication. Keep new routes below it, and add a test that checks every
  new route returns 401 without the token.
- `express.json({ limit: "8kb", strict: true })`.
- Routes:
  - `GET /health`
  - `GET /models`
  - `GET /models/running`
  - `GET /models/status` and `GET /models/:displayName/status` (run
    `./start.sh ps`)
  - `POST /models/:displayName/start` with body `{ switchRunning?,
    launchOptionSelections? }`. Waits for the start to finish and returns 200,
    409 `MODEL_ALREADY_RUNNING` (with `runningModels`), or 502 on command
    failure.
  - `POST /models/:displayName/stop`. Waits and returns 200 or 502.
- Error body shape: `{ error: { code, message, ...details } }`.

### Recipe behaviour (outside this repo; verified on the machine)

| Model | Workspace | Notes |
| --- | --- | --- |
| `deepseek-v4` | `~/Desktop/DeepSeek-v4-Flash-One-DGX-Spark` | Docker Compose. **No `stop.sh`**; it stops with `./start.sh down`. Has `/health` on 8888. |
| `qwen3.8-27b` | `~/Desktop/Qwen3.8-27B-SGLang-DGX-Spark` | SGLang. **Ignores the `ps` argument and starts the model.** Serves `/v1/models` with id `qwen3.8-27b-sglang`. |
| `qwen3.8-flash-next-tensorfold` | `~/Desktop/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold` | **Passes `ps` through to the server**, so it also starts the model. Serves `/v1/models`. Its container `qwen38-flash-next-tf` mounts only cache directories and has no Compose label, so it is matched by the registry's `containerNames` (added in Layer 1). |

- Every `start.sh` launches a detached Docker container, then **blocks**: it
  streams `docker logs -f` and loops on a health check until the server
  answers. It exits 0 once the model is healthy and non-zero on failure. Its
  exit is therefore a reasonable readiness signal when there is no probe.
- `start.sh` starts background helpers (`docker logs -f`, health loops) that
  inherit its stdout and stderr pipes. Node's `close` event can therefore
  arrive long after the script exits, or never (see Appendix C).
- All models serve on **port 8888**. An HTTP probe of 8888 cannot tell which
  model answered unless it checks the served model ID, or only runs when that
  model's own containers are present.
- Recipes print banners such as `Listening on 0.0.0.0:8888` and `
  http://127.0.0.1:8888/health — live logs above` **before** the runtime
  starts. Do not treat these as progress (see Layer 7).
- Model weights load for minutes. Starts can take a long time: allow hours,
  not seconds.

**Important hazard:** `GET /models/status` (and the CLI `status` command) run
`./start.sh ps`, which **launches** two of the three models. Layer 1 fixes this
first.

---

## 2. Target design overview

### States (`lifecycleState`)

`stopped`, `queued`, `starting`, `running`, `stopping`, `failed`.

Keep these concepts separate in every status response:

- `lifecycleState`: what the manager believes is happening.
- `desiredState`: `running` or `stopped`, meaning what was last requested.
  Added in Layer 2.
- `phase`: a finer-grained step code during an operation. Added in Layer 7.
- `readiness`: whether the model's API answers. Added in Layer 4.
- `runtime`: the containers Docker reports. Added in Layer 1.
- `lastError`: the most recent failure. A later success does **not** erase it.
  It is only replaced by a newer failure.

How the state is derived (final form):

1. An operation is active for the model: `queued` (waiting to run),
   `starting`, or `stopping`.
2. Otherwise, if the last operation failed, or a container the manager started
   has since died: `failed`.
3. Otherwise, if containers are running: `running` when ready, or `starting`
   when not yet ready (from Layer 4).
4. Otherwise: `stopped`.

`failed` is not terminal: a new start or stop is allowed from it.

Never report `running` just because a process or container exists (from
Layer 4 onwards, readiness decides).

Never invent progress percentages. Report `current`/`total` only when the
runtime prints real counts (Layer 7).

### Operations

An operation is one start or stop request. It runs in the background. The
POST returns `202` immediately with an `operationId`, and the client polls
`GET /operations/:id` and the model's status.

Only one operation runs at a time across all models: a second request returns
`409`. Per-model concurrency adds complexity with no benefit, because only one
model fits on the GPU.

### Final route list

| Method | Path | Layer |
| --- | --- | --- |
| GET | `/models` | unchanged (Layer 3 masks secrets) |
| GET | `/models/running` | unchanged |
| GET | `/models/status` | 1, then extended |
| GET | `/models/:displayName/status` | 1, then extended |
| POST | `/models/:displayName/start` | 2 |
| POST | `/models/:displayName/stop` | 2 (Layer 6 adds `allowForceKill`) |
| GET | `/operations/:operationId` | 2 |
| GET | `/models/:displayName/logs` | 3 |

### Breaking changes to document in the README

- Start and stop return `202` with an operation instead of waiting and
  returning 200/502. There is no synchronous mode.
- The status endpoints return structured state instead of `start.sh ps`
  output.

---

## Layer 1: Status that does not launch models

**Goal:** status comes from Docker, never from running recipe scripts.

### Code

1. Move the Docker and workspace helpers out of `index.ts` into
   `packages/core/src/workspace.ts` (Appendix A). Other modules can then import
   them without an import cycle. Re-export what the CLI and API need.
2. Add `packages/core/src/runtime.ts` with a `RuntimeController` interface and
   a `DockerRuntimeController` (Appendix B):
   - `inspect(workspaces)` returns a `Map<displayName, RuntimeContainer[]>`,
     newest first, including exited containers (needed later for exit codes
     and OOM).
   - `kill(ids)` runs `docker kill`. It is used in Layer 6.
   - The interface exists so tests can inject a fake (Appendix G).
3. Add `getModelStatuses(registryPath, runtime)` in core. It returns, per
   registered model:

   ```jsonc
   {
     "displayName": "qwen3.8-27b",
     "lifecycleState": "running",          // or "stopped" (only these two in Layer 1)
     "runtime": {
       "observed": true,                   // false if Docker could not be queried
       "present": true,                    // any running container owned by the workspace
       "containers": [ /* RuntimeContainer */ ],
       "error": null                       // message when observed is false
     }
   }
   ```

   If Docker is unavailable, return `observed: false` with the error and
   `lifecycleState: "unknown"`, or omit the state. Do not throw.
4. Replace `getModelStatus` (`./start.sh ps`) everywhere, including the CLI
   `status` command. Delete `DEFAULT_STATUS_COMMAND`.
5. API: `GET /models/status` returns `{ models: [...] }` and
   `GET /models/:displayName/status` returns `{ model: {...} }`. Unknown name:
   404 `MODEL_NOT_FOUND`. Do not include the registry path in the message.

### `RuntimeContainer`

```ts
interface RuntimeContainer {
  id: string;
  name: string | null;
  running: boolean;
  restarting: boolean;
  status: string | null;      // Docker State.Status
  exitCode: number | null;    // only when not running
  oomKilled: boolean;
  restartCount: number;
  startedAt: string | null;   // null for Docker's zero time "0001-01-01..."
  finishedAt: string | null;
}
```

### Tests

- A mock `docker` script on `PATH` (write an executable shell script into a
  temp directory and prepend it to `PATH`). It returns `ps` ids and `inspect`
  JSON with containers mounted from the workspace, containers with a Compose
  `working_dir` label, and unrelated containers. Assert that ownership is
  correct.
- Docker missing or failing gives `observed: false` and a 200 response, not a
  500.
- A recipe `start.sh` that writes a marker file must **not** be run by status.
- Auth: the status routes return 401 without the token when one is
  configured.

**Size:** about 150 lines plus tests.

---

## Layer 2: Async start and stop with in-memory operations

**Goal:** POST returns immediately, and the work is observable by polling.
State is held in memory only; it is lost on restart until Layer 5.

### Core: `packages/core/src/lifecycle.ts` (`LifecycleManager`)

One class, created once by the API (`createApp`) and stored in
`app.locals.lifecycle` so tests can reach it.

```ts
type OperationKind = "start" | "stop";
type OperationStatus = "queued" | "running" | "succeeded" | "failed";

interface Operation {
  operationId: string;          // "op_" + 32 hex chars (randomBytes(16))
  kind: OperationKind;
  displayName: string;
  status: OperationStatus;
  requestId: string | null;     // API request ID, for correlating logs
  options: { switchRunning?: boolean; launchOptionSelections?: Record<string,string> };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  command: { exitCode: number | null; signal: string | null } | null;
  error: LifecycleError | null;
}

interface LifecycleError {
  operationId: string;
  kind: OperationKind;
  code: LifecycleErrorCode;     // stable, see below
  message: string;
  at: string;
  exitCode: number | null;
  signal: string | null;
  retrySafe: boolean;
  logTail: string[];            // added in Layer 3; [] until then
}
```

Per model, keep `{ desiredState, activeOperationId, lastOperationId, lastError }`.
Keep a bounded map of operations: the last 10 per model, pruning older ones.

**Admission** (synchronous checks before the 202):

1. The model exists in the registry (404 `MODEL_NOT_FOUND`).
2. Launch option selections are valid: call `resolveLaunchEnvironment` now and
   return 400 `INVALID_LAUNCH_OPTIONS`.
3. No operation is active: otherwise return 409 `LIFECYCLE_BUSY` with
   `activeOperationId` and its model. If it is the same model, use
   `OPERATION_IN_PROGRESS`.
4. Start only: if another model is running and `switchRunning` is not true,
   return 409 `MODEL_ALREADY_RUNNING` with `runningModels` (keep this
   compatible with the old contract). If Docker cannot be queried, return 503
   `RUNTIME_INSPECTION_FAILED`.
5. Acquire the cross-process lifecycle lock (`acquireLifecycleLock`, exported
   from core). If the CLI holds it, return 409 `LIFECYCLE_LOCK_HELD`. Release
   it when the operation finishes.
6. Create the operation, mark it active, start the background task, and return
   it.

Do admission inside a simple async mutex (a promise chain) so two concurrent
POSTs cannot both pass check 3.

**Start task:**

1. If `switchRunning`, stop each other running model by running its
   `./stop.sh`. On failure, fail with `CONFLICTING_MODEL_STOP_FAILED`, naming
   the model.
2. Run `./start.sh` with `launchProcess` (Appendix C) using
   `{ ...process.env, ...launchEnvironment }`, with cwd set to the resolved
   workspace.
3. Exit 0: the operation succeeds. Non-zero exit or signal:
   `START_COMMAND_FAILED`. Spawn error (for example, no `start.sh`):
   `START_COMMAND_UNAVAILABLE`.
4. Timeout (default 3 hours): terminate the process group,
   `STARTUP_TIMEOUT`.

**Stop task:** run `./stop.sh`. A non-zero exit gives `STOP_COMMAND_FAILED`.
Default timeout 5 minutes, then `STOP_TIMEOUT`. A missing `stop.sh` gives
`STOP_COMMAND_UNAVAILABLE` for now; Layer 6 adds the force-kill fallback, which
DeepSeek needs.

**On finish:** set `status`, `finishedAt` and `command`. On failure, also set
the model's `lastError`. Clear `activeOperationId`, set `lastOperationId`, and
release the lock.

**Timing** must be injectable (`timing: { startTimeoutMs, stopTimeoutMs,
pollIntervalMs, ... }`) so tests run in milliseconds.

**`retrySafe`:** true for failures where nothing is left half-running (command
unavailable, conflicting stop failed before launch, `STOP_COMMAND_FAILED`
where containers are gone). Use false when the runtime state is unknown.

**Status:** add `desiredState`, `activeOperation` (an `{ operationId, kind,
status }` summary), `lastOperation` and `lastError`, and derive
`lifecycleState` as described in section 2. There is no readiness yet, so
running containers mean `running`.

### API

- `POST /models/:displayName/start`, body `{ switchRunning?: boolean,
  launchOptionSelections?: Record<string,string> }`. Reject unknown fields and
  wrong types with 400 `INVALID_REQUEST`.
- `POST /models/:displayName/stop`, with an optional body (`{}` or no body).
  In Layer 6 the body gains `allowForceKill?: boolean`.
- Both return **202**, with a `Location: /operations/:id` header:

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

- `GET /operations/:operationId` validates the ID against
  `/^op_[a-f0-9]{32}$/` (400 `INVALID_OPERATION_ID`) and returns
  `{ operation }` (404 `OPERATION_NOT_FOUND`).
- Display name validation: reject names longer than 256 characters or
  containing control characters with 400 `INVALID_MODEL_NAME`, before the
  registry lookup.
- The error handler maps `LifecycleRequestError(status, code, message,
  details)` to `{ error: { code, message, ...details } }`.
- Log `model.start.requested` and `model.stop.requested` with `requestId`,
  `operationId` and `displayName`. Log operation completion with the same IDs.
  **Never log the environment or launch option values.**
- On SIGINT or SIGTERM in `packages/api/src/index.ts`, close the server and
  call `lifecycle.close()`, which terminates running launcher processes.
  Containers keep running.

### Tests (`packages/api/test/lifecycle.test.mjs`)

Use the fixture helpers in Appendix G (fake runtime, scripted `start.sh`).

- Start returns 202 quickly while `start.sh` sleeps; the operation goes
  queued, then running, then succeeded.
- A failing `start.sh` (exit 3) gives `failed`, `START_COMMAND_FAILED` with
  `exitCode: 3`, and `lastError` set on the model.
- A missing `start.sh` gives `START_COMMAND_UNAVAILABLE`.
- A second start while one is active gives 409; a stop of another model while
  one is active gives 409.
- Another model running without `switchRunning` gives 409
  `MODEL_ALREADY_RUNNING`. With `switchRunning`, the other model's `stop.sh`
  runs first.
- `lastError` survives a later successful start.
- Validation: a bad name, bad operation ID, unknown body fields and invalid
  launch options give 400.
- All new routes require auth.

**Size:** about 400 lines for the manager plus routes and tests. This layer
alone covers daily use.

---

## Layer 3: Logs and redaction

**Goal:** see what `start.sh` and `stop.sh` printed, with secrets removed and
memory bounded.

### Code

1. Add `redaction.ts` (Appendix D) unchanged: `Redactor`, `sanitizeLogText`,
   `isSecretName`, `maskSecretEnvironment`.
2. Build a redactor for each operation:
   `Redactor.fromEnvironment(process.env, launchEnvironment).with([apiToken])`.
   It removes literal values of secret-named environment variables, the API
   bearer token and common token shapes.
3. Keep one in-memory log per model, holding the **latest operation's**
   lines only. Each line is `{ seq, at, stream: "stdout" | "stderr" |
   "manager", text }`, capped at 2,000 lines (drop the oldest). `seq`
   increases monotonically. Start a new log for each operation.
4. Feed it from `launchProcess` `onLine` through `sanitizeLogText`. Split
   lines with `LineSplitter` (Appendix C): carriage returns count as line
   breaks, because progress bars use them.
5. Add `stream: "manager"` lines for the manager's own events (for example,
   "Stopping conflicting model X", "start.sh exited with code 3").
6. On failure, `error.logTail` gets the last 50 lines.
7. Mask secret-named values in `GET /models` and `/models/running` responses
   (launch option environment) with `maskSecretEnvironment`.

### API

`GET /models/:displayName/logs?after=<seq>&limit=<n>`

- `after` is an optional non-negative integer (default 0). `limit` is an
  integer from 1 to 1000 (default 200). Reject any other query parameter,
  repeated parameters and empty values with 400 `INVALID_LOG_QUERY`.
- Response:

  ```json
  {
    "displayName": "qwen3.8-27b",
    "operationId": "op_…",        // null if no operation since the API started
    "operationKind": "start",
    "operationStatus": "running",
    "lines": [{ "seq": 41, "at": "…", "stream": "stdout", "text": "…" }],
    "nextAfter": 41,              // pass back as ?after=
    "truncated": false,           // true if lines after `after` were already evicted
    "hasMore": false
  }
  ```

- If the client's `after` belongs to an earlier operation, it simply gets the
  new operation's lines, because `operationId` changed. No cursor encoding is
  needed.

### Pitfalls

- **Over-redaction:** a bare `TOKEN` pattern also matches `max_tokens`,
  `--max-total-tokens` and `tokenizer`. Use `TOKEN(?!S|IZ)` and
  `token(?!s|iz)`, as in Appendix D, and keep the test cases from Appendix H.
- Ignore literal secrets shorter than 6 characters; otherwise short values
  such as `"1"` would redact every digit.
- Cap each line at 4,096 characters, and cap a pending unterminated line at
  64 KB.

### Tests

- The redactor test table (Appendix H).
- Logs contain `start.sh` output with an `HF_TOKEN` value and a
  `Bearer …` header redacted. The bearer API token never appears in logs,
  operations or errors.
- Paging with `after` and `limit`, and eviction setting `truncated`.
- Invalid query parameters give 400.
- `GET /models` masks `HF_TOKEN`-style launch environment values.

**Size:** about 150 lines plus the copied redaction module.

---

## Layer 4: Readiness

**Goal:** `running` means the model's API actually answers.

### Registry

Add an optional field to each registry entry:

```jsonc
"readiness": {
  "url": "http://127.0.0.1:8888/v1/models",   // http or https only
  "expectedModelId": "qwen3.8-27b-sglang",     // optional, non-empty
  "timeoutMs": 2000                            // optional integer, 100..60000
}
```

Validate it in `parseRegistryEntry` and reject other URL schemes (for example
`file:`). Add probes to `registry.example.json`:

- deepseek: `http://127.0.0.1:8888/health`
- qwen3.8-27b: `/v1/models` with `expectedModelId: "qwen3.8-27b-sglang"`
- tensorfold: `/v1/models`

The user's real `~/.spark-manager/registry.json` is theirs to update; do not
edit it.

### Code

- Add `HttpReadinessProber` (Appendix B) behind a `ReadinessProber` interface
  so tests can inject a fake.
- Start task: after `start.sh` exits 0, if the model has a probe, poll it every
  `pollIntervalMs` until it is ready or `readinessTimeoutMs` (default 15
  minutes) passes. On timeout, fail with `READINESS_TIMEOUT`, `retrySafe:
  false` (the container may still be loading).
- Status gains a readiness block:

  ```json
  "readiness": {
    "configured": true,
    "ready": false,
    "source": "probe",            // "probe" | "start-command" | "none"
    "endpoint": "http://127.0.0.1:8888/v1/models",  // strip userinfo and query before returning
    "httpStatus": null,
    "servedModelIds": [],
    "checkedAt": "…",
    "error": "connect ECONNREFUSED"
  }
  ```

- **Only probe when this model's own containers are running.** All models
  share port 8888, so probing whenever the port answers would show a stopped
  model as ready because another model is up. If there are no containers,
  report `ready: false` without probing.
- Without a probe, a successful `start.sh` counts as ready, with `source:
  "start-command"`. This is acceptable because the recipes wait for their own
  health check before exiting.
- `lifecycleState`: containers present and not ready give `starting`;
  containers present and ready give `running`.
- Cache probe results for about 2 seconds so repeated status polls don't
  flood the server. Make the cache time injectable and set it to 0 in tests.
- Models started outside the API (for example, by the CLI) still get correct
  status, because status is derived from Docker plus the probe. Mark them
  `externallyManaged: true` when there is no operation for them.

### Tests

- With a fake prober: `start.sh` exits 0 while the probe is not ready, so the
  model reports `starting` with `readiness.ready: false`. Flip the prober to
  ready, and the operation succeeds and the model reports `running`.
- Readiness timeout gives `READINESS_TIMEOUT`.
- A model with no containers is never probed (assert the prober's call
  count).
- Registry readiness validation: valid config, `file:` URL, an invalid URL,
  `timeoutMs` 5, empty `expectedModelId`, and a non-object value.

**Size:** about 150 lines.

---

## Layer 5: Persistence and recovery

**Goal:** operations, `lastError` and history survive an API restart.

### Code

- State directory: `SPARK_MANAGER_STATE_DIR`, defaulting to
  `~/.spark-manager/state`. Create it with mode 0700. Add the variable to
  `.env.example`.
- One file, `lifecycle-state.json`:

  ```json
  { "version": 1, "models": { "<name>": { "desiredState", "activeOperationId",
    "lastOperationId", "lastError", "lastSuccessfulStartAt", "lastSuccessfulStopAt" } },
    "operations": { "op_…": Operation } }
  ```

- Write with `writeAtomically` (Appendix E): a temp file with mode 0600,
  fsync, then rename. Serialize writes through a promise chain.
- Save on operation creation, on each status change and on finish. **Do not
  write on status reads.**
- Logs are **not** persisted. `error.logTail` inside the state file is enough.
- On load:
  - Missing file: empty state.
  - Unparseable file, or wrong `version`: rename it to
    `lifecycle-state.json.corrupt-<timestamp>`, log a warning and start empty.
- **Recovery** on startup, before accepting requests (`await
  lifecycle.ready()`). Any operation that was `queued` or `running` becomes
  `failed` with `MANAGER_INTERRUPTED`, `retrySafe: true` for a stop and
  `false` for a start. Its model's `lastError` is set. Never re-run recipe
  scripts during recovery. Live status is then derived from Docker plus
  readiness as usual, so a model whose start was interrupted but whose
  container came up shows `running`. The interrupted operation stays failed.
- Remove a stale lifecycle lock left by this process's previous run.
  `acquireLifecycleLock` already handles a dead owner PID.

### Tests

- Start a model, wait for success, then create a new app with the same state
  directory: `lastOperation` and history are present.
- Fail a start, restart: `lastError` is present.
- Begin a start whose `start.sh` sleeps, close the app (`lifecycle.close()`
  without finishing), and create a new app: the operation is `failed` with
  `MANAGER_INTERRUPTED`.
- A corrupt state file is quarantined and the app still starts.
- File modes: 0600 for the file and 0700 for the directory.
- The state file contains no secret values.

**Size:** about 120 lines.

---

## Layer 6: Stop hardening

**Goal:** a stop reliably ends with no containers running, and reports how it
got there.

### Code

- Stop task phases (internal steps; exposed as phases in Layer 7):
  1. Run `./stop.sh` with a timeout. If it does not exist, skip to step 3.
  2. Verify: poll the runtime until no running containers are owned by the
     workspace, or `stopVerifyTimeoutMs` (default 30 seconds) passes.
  3. If containers remain and `allowForceKill` (body field, default `true`)
     is set, run `runtime.kill(ids)` and verify again.
- Record `shutdown: { mode: "graceful" | "forced", verified: boolean,
  forceKilledContainerIds: string[] }` on the operation.
- Failure codes:
  - `STOP_COMMAND_FAILED`: `stop.sh` exited non-zero and containers remain,
    with force kill disabled.
  - `STOP_TIMEOUT`: `stop.sh` did not exit in time. Terminate its process
    group.
  - `RUNTIME_STILL_RUNNING`: containers remain after a graceful stop, with
    force kill disabled.
  - `FORCE_KILL_FAILED`: containers remain after `docker kill`.
- If Docker cannot be observed during verification, trust `stop.sh`'s exit
  code. Report `verified: false`.
- The process-group kill in `launchProcess.terminate` (SIGTERM, then SIGKILL
  after `killGraceMs`, default 10 seconds) also applies to start timeouts.
- `switchRunning` reuses the same stop task for each conflicting model, so it
  gets verification and force kill too.

### DeepSeek

DeepSeek has no `stop.sh`, so it will always be force-killed. Recommend to the
user that they add `stop.sh` containing `#!/bin/sh\nexec ./start.sh down` to
that recipe, so it stops gracefully. Do not edit the recipe repository without
asking.

### Tests

- `stop.sh` exits 0 and the fake runtime clears its containers: `graceful`,
  `verified`.
- `stop.sh` exits 0 but containers remain: `forced` with the IDs killed.
- The same with `allowForceKill: false`: `RUNTIME_STILL_RUNNING`.
- An unkillable container: `FORCE_KILL_FAILED`.
- `stop.sh` sleeps past the timeout: `STOP_TIMEOUT`, and the process is gone.

**Size:** about 120 lines.

---

## Layer 7: Phases

**Goal:** show which step an operation is on.

### Model

```ts
interface Phase {
  code: string;          // open set; known codes below
  label: string;         // human label, e.g. "Loading weights"
  current?: number;      // only when the runtime printed real counts
  total?: number;
  percent?: number;      // floor(current/total*100), only when both are valid
  detail?: Record<string, string | number | boolean | null>;
}
```

The operation gets `phase` (current) and `phaseHistory` (capped at 50
entries, each `{ code, label, at, ... }`). The model status shows the active
operation's phase.

Known codes:

- Start: `queued`, `validating`, `stopping_conflicting_models`, `preparing`,
  `launching_runtime`, `loading_weights`, `compiling`, `warming`,
  `waiting_for_readiness`, `complete`.
- Stop: `queued`, `validating`, `terminating`, `verifying_shutdown`,
  `force_killing`, `complete`.

### How phases are set

- Steps the manager controls set their phase directly: validating, stopping
  conflicting models, preparing (just before spawning `start.sh`), waiting
  for readiness (probe loop), and every stop phase.
- `launching_runtime` is also set when the runtime first reports a container
  for the model during a start. Poll at `pollIntervalMs` while `start.sh`
  runs.
- `loading_weights`, `compiling` and `warming` come only from log heuristics
  (`detectStartupPhase`, Appendix F) and **only move forward**: ignore a match
  that ranks lower than the current phase.
- `stopping_conflicting_models` carries `detail: { model, phase }` with the
  conflicting model's current stop phase (for example, `verifying_shutdown`).
  This satisfies "switchRunning must report the stop phases of the
  conflicting model" without creating child operations.
- On failure, record the phase that was active in `error.phase`.

### Pitfalls

- The patterns `Listening on` and `Waiting … /health` matched recipe banners
  printed before anything started, which made the phase jump straight to
  `waiting_for_readiness`. They were removed; keep them out.
- In tests, a fixture script echoing `Starting server` matches
  `launching_runtime`. Use neutral text such as `Preparing recipe` when a test
  needs no phase change.
- Startup "draining" is not observable; do not invent it.

### Tests

- A scripted `start.sh` printing a sequence of engine lines (Appendix H)
  gives the expected `phaseHistory` order. `Loading checkpoint shards 42/72`
  gives `current: 42, total: 72, percent: 58`.
- A lower-ranked line after a higher phase does not move the phase back.
- `switchRunning` shows `stopping_conflicting_models` with the other model's
  stop phase in `detail`.
- A failed start records `error.phase`.

**Size:** about 150 lines plus the copied `phases.ts`.

---

## Optional extras (each needs an explicit go-ahead)

| Feature | What it adds | Why it's deferred |
| --- | --- | --- |
| Unexpected exit and OOM detection | A container the manager started disappears, or Docker reports `OOMKilled`: the model becomes `failed` with `RUNTIME_EXITED` or `RUNTIME_OOM_KILLED`. During a start, fail fast instead of waiting for `start.sh`. | Moderate complexity. To avoid false alarms, it must track which containers were seen since the start. |
| Stop cancels an in-flight start | A stop during a start terminates the launcher and the start becomes `cancelled`. | Adds a `cancelled` status, cancellation plumbing and races. A 409 is fine for one user. |
| Resume a start after restart | Recovery continues waiting for readiness instead of failing. | Small benefit; restarts mid-start are rare. |
| Idempotency keys | The `Idempotency-Key` header replays the original operation; a different request with the same key gets 422. | Little use with one user and a dashboard. |
| Persisted logs | Full logs survive a restart. | `logTail` covers the failure case. |
| Server-sent events (SSE) stream | Push updates instead of polling. | Polling every few seconds is fine. |

If unexpected exit detection is built: a model only fails this way if
containers were observed after the start succeeded and are now gone without a
stop. A missing `OOMKilled` flag means "unknown" (`null`), not `false`.

---

## Error codes (final set)

| Code | HTTP / where | Meaning |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | Bad body or fields. |
| `INVALID_MODEL_NAME` | 400 | Name too long or contains control characters. |
| `INVALID_OPERATION_ID` | 400 | ID doesn't match `op_[a-f0-9]{32}`. |
| `INVALID_LOG_QUERY` | 400 | Bad `after` or `limit`, or unknown parameters. |
| `INVALID_LAUNCH_OPTIONS` | 400 | Unknown option or choice. |
| `MODEL_NOT_FOUND` | 404 | Not in the registry. |
| `OPERATION_NOT_FOUND` | 404 | Unknown or pruned operation. |
| `OPERATION_IN_PROGRESS` | 409 | This model already has an active operation. |
| `LIFECYCLE_BUSY` | 409 | Another model's operation is active. |
| `MODEL_ALREADY_RUNNING` | 409 | Another model is running and `switchRunning` is not set. |
| `LIFECYCLE_LOCK_HELD` | 409 | The CLI holds the lifecycle lock. |
| `RUNTIME_INSPECTION_FAILED` | 503 / operation | Docker could not be queried. |
| `CONFLICTING_MODEL_STOP_FAILED` | operation | `switchRunning` could not stop the other model. |
| `START_COMMAND_UNAVAILABLE` | operation | `start.sh` is missing or not executable. |
| `START_COMMAND_FAILED` | operation | `start.sh` exited non-zero or was killed by a signal. |
| `STARTUP_TIMEOUT` | operation | `start.sh` did not finish in time. |
| `READINESS_TIMEOUT` | operation | The probe never became ready. |
| `STOP_COMMAND_UNAVAILABLE` | operation | No `stop.sh` (Layer 2 only; Layer 6 force-kills instead). |
| `STOP_COMMAND_FAILED` | operation | `stop.sh` failed and containers remain. |
| `STOP_TIMEOUT` | operation | `stop.sh` did not finish in time. |
| `RUNTIME_STILL_RUNNING` | operation | Containers remain and force kill is disabled. |
| `FORCE_KILL_FAILED` | operation | Containers survived `docker kill`. |
| `MANAGER_INTERRUPTED` | operation | The API restarted mid-operation. |
| `INTERNAL_ERROR` | 500 / operation | An unexpected exception. Never include stack traces or environment values. |

---

## Security checklist (applies to every layer)

- Every new route sits behind the existing bearer token middleware, and a test
  asserts 401 for each.
- Validate every path and query parameter: display names, operation IDs, and
  `after` and `limit`.
- No user input ever becomes a filesystem path. Workspaces come only from the
  registry; operation IDs are generated internally and checked against the
  `op_` pattern before any use.
- Never return or log the full launch environment. Mask secret-named values in
  `/models`.
- Every log line is redacted and bounded before storage. The API token is
  included in the redactor's literal secrets.
- Readiness URLs are restricted to http and https. Strip userinfo and query
  from the endpoint before returning it. Use `redirect: "manual"`.
- Durable state is written atomically with mode 0600 in a 0700 directory.
- Lifecycle logs include `requestId` and `operationId`, and never environment
  values.

---

## Appendix A: `workspace.ts` (reuse unchanged)

```ts
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

interface DockerContainerInspection {
  Config?: { Labels?: Record<string, string> | null };
  Mounts?: Array<{ Source?: string }>;
}

export async function resolveWorkspace(workspaceDir: string): Promise<string> {
  try {
    const workspaceStats = await stat(workspaceDir);
    if (!workspaceStats.isDirectory()) {
      throw new Error("path is not a directory");
    }
    return await realpath(workspaceDir);
  } catch (error) {
    throw new Error(`Invalid workspace ${workspaceDir}: ${errorMessage(error)}`, { cause: error });
  }
}

/** A container belongs to a workspace if its Compose working_dir or any mount source is inside it. */
export function containerBelongsToWorkspace(value: unknown, workspaceDirectory: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const inspection = value as DockerContainerInspection;
  const composeWorkspace = inspection.Config?.Labels?.["com.docker.compose.project.working_dir"];
  if (composeWorkspace && pathIsWithinWorkspace(workspaceDirectory, composeWorkspace)) {
    return true;
  }
  return (
    inspection.Mounts?.some(
      (mount) => typeof mount.Source === "string" && pathIsWithinWorkspace(workspaceDirectory, mount.Source),
    ) ?? false
  );
}

function pathIsWithinWorkspace(workspaceDirectory: string, candidatePath: string): boolean {
  const pathFromWorkspace = relative(workspaceDirectory, resolve(candidatePath));
  return pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace));
}

export function runDockerCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    execFile("docker", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Unable to query Docker: ${stderr.trim() || error.message}`, { cause: error }));
        return;
      }
      resolveCommand(stdout);
    });
  });
}

export function defaultRegistryPath(): string {
  return join(homedir(), ".spark-manager", "registry.json");
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

## Appendix B: `DockerRuntimeController` and `HttpReadinessProber`

```ts
const MAX_INSPECTED_CONTAINERS = 200;

export interface RuntimeWorkspace { displayName: string; workspaceDirectory: string }

export interface RuntimeController {
  /** Containers (running and recently exited) per display name, newest first. Rejects if Docker can't be queried. */
  inspect(workspaces: readonly RuntimeWorkspace[]): Promise<Map<string, RuntimeContainer[]>>;
  kill(containerIds: readonly string[]): Promise<void>;
}

export class DockerRuntimeController implements RuntimeController {
  async inspect(workspaces: readonly RuntimeWorkspace[]): Promise<Map<string, RuntimeContainer[]>> {
    const result = new Map<string, RuntimeContainer[]>(workspaces.map((w) => [w.displayName, []]));
    const containerIds = (
      await runDockerCommand(["ps", "--all", "--last", String(MAX_INSPECTED_CONTAINERS), "--quiet", "--no-trunc"])
    ).split("\n").map((id) => id.trim()).filter(Boolean);
    if (containerIds.length === 0) {
      return result;
    }
    const inspections: unknown = JSON.parse(await runDockerCommand(["inspect", ...containerIds]));
    if (!Array.isArray(inspections)) {
      throw new Error("Unable to inspect Docker containers: expected a JSON array.");
    }
    const resolvedWorkspaces: Array<{ displayName: string; directory: string }> = [];
    for (const workspace of workspaces) {
      try {
        resolvedWorkspaces.push({ displayName: workspace.displayName, directory: await resolveWorkspace(workspace.workspaceDirectory) });
      } catch {
        // An invalid workspace owns no containers; validation reports it separately.
      }
    }
    for (const inspection of inspections) {
      const container = parseContainer(inspection);
      if (!container) continue;
      for (const workspace of resolvedWorkspaces) {
        if (containerBelongsToWorkspace(inspection, workspace.directory)) {
          result.get(workspace.displayName)?.push(container);
        }
      }
    }
    for (const containers of result.values()) {
      containers.sort((a, b) => timeValue(b.startedAt) - timeValue(a.startedAt));
    }
    return result;
  }

  async kill(containerIds: readonly string[]): Promise<void> {
    if (containerIds.length > 0) {
      await runDockerCommand(["kill", ...containerIds]);
    }
  }
}

function parseContainer(value: unknown): RuntimeContainer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const inspection = value as {
    Id?: unknown; Name?: unknown; RestartCount?: unknown;
    State?: { Running?: unknown; Restarting?: unknown; Status?: unknown; ExitCode?: unknown;
              OOMKilled?: unknown; StartedAt?: unknown; FinishedAt?: unknown };
  };
  if (typeof inspection.Id !== "string") return undefined;
  const state = inspection.State ?? {};
  const running = state.Running === true;
  return {
    id: inspection.Id,
    name: typeof inspection.Name === "string" ? inspection.Name.replace(/^\//, "") : null,
    running,
    restarting: state.Restarting === true,
    status: typeof state.Status === "string" ? state.Status : null,
    exitCode: !running && typeof state.ExitCode === "number" ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    restartCount: typeof inspection.RestartCount === "number" ? inspection.RestartCount : 0,
    startedAt: dockerTime(state.StartedAt),
    finishedAt: dockerTime(state.FinishedAt),
  };
}

function dockerTime(value: unknown): string | null {
  // Docker reports the zero time for containers that never started or finished.
  return typeof value === "string" && !value.startsWith("0001-") ? value : null;
}

function timeValue(value: string | null): number {
  return value ? Date.parse(value) || 0 : 0;
}

export interface ReadinessResult {
  endpointReachable: boolean;
  ready: boolean;
  servedModelIds: string[];
  httpStatus: number | null;
  error: string | null;
}

/**
 * Probes an OpenAI-compatible endpoint. A 2xx response means the API answers;
 * when the body lists models (`data[].id`), their IDs are reported and, if
 * configured, the expected model must be among them.
 */
export class HttpReadinessProber {
  async probe(config: ReadinessConfig): Promise<ReadinessResult> {
    let response: Response;
    try {
      response = await fetch(config.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs ?? 2000),
        headers: { accept: "application/json" },
      });
    } catch (error) {
      return { endpointReachable: false, ready: false, servedModelIds: [], httpStatus: null, error: errorMessage(error) };
    }
    let servedModelIds: string[] = [];
    try {
      const body = JSON.parse((await response.text()).slice(0, 256 * 1024)) as { data?: unknown };
      if (Array.isArray(body.data)) {
        servedModelIds = body.data
          .map((e) => (typeof e === "object" && e !== null && "id" in e ? (e as { id: unknown }).id : undefined))
          .filter((id): id is string => typeof id === "string")
          .slice(0, 32);
      }
    } catch {
      // Health endpoints may answer with an empty or non-JSON body.
    }
    const ok = response.status >= 200 && response.status < 300;
    const hasExpectedModel = config.expectedModelId === undefined || servedModelIds.includes(config.expectedModelId);
    return {
      endpointReachable: true,
      ready: ok && hasExpectedModel,
      servedModelIds,
      httpStatus: response.status,
      error: !ok ? `HTTP ${response.status}`
        : hasExpectedModel ? null
        : `Expected model ${JSON.stringify(config.expectedModelId)} is not served.`,
    };
  }
}
```

## Appendix C: `launchProcess` and `LineSplitter`

Key points:

- Spawn **detached** (its own process group) with `shell: false`, so the
  manager can signal the whole group, including the `docker logs -f` and
  health-loop helpers the recipe starts.
- `exited` never rejects.
- Do not wait only for `close`. Background helpers keep the pipes open after
  `start.sh` exits, so `close` may never fire. Settle on `close`, or 2 seconds
  after `exit` (destroying the pipes).

```ts
import { spawn } from "node:child_process";

export interface ProcessExit { exitCode: number | null; signal: NodeJS.Signals | null; spawnError: string | null }

export interface LaunchedProcess {
  readonly pid: number | null;
  /** Resolves when the process exits or fails to start; never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** Sends SIGTERM to the process group, then SIGKILL after `graceMs`. */
  terminate(graceMs: number): Promise<ProcessExit>;
}

export function launchProcess(options: {
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
}): LaunchedProcess {
  const [executable, ...args] = options.command;
  if (!executable) {
    const exit = { exitCode: null, signal: null, spawnError: "Command must not be empty." };
    return { pid: null, exited: Promise.resolve(exit), terminate: async () => exit };
  }
  const child = spawn(executable, args, {
    cwd: options.cwd, env: options.env, shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = new LineSplitter((line) => options.onLine("stdout", line));
  const stderr = new LineSplitter((line) => options.onLine("stderr", line));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const exited = new Promise<ProcessExit>((resolveExit) => {
    let settled = false;
    const settle = (exit: ProcessExit): void => {
      if (!settled) {
        settled = true;
        stdout.flush();
        stderr.flush();
        resolveExit(exit);
      }
    };
    child.once("error", (error) => settle({ exitCode: null, signal: null, spawnError: error.message }));
    child.once("close", (exitCode, signal) => settle({ exitCode, signal, spawnError: null }));
    // "close" waits for every holder of the pipes; a background helper the
    // recipe forgot to reap must not keep the operation open indefinitely.
    child.once("exit", (exitCode, signal) => {
      const timer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ exitCode, signal, spawnError: null });
      }, 2000);
      timer.unref();
    });
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
    } catch {
      // The group already exited.
    }
  };

  return {
    pid: child.pid ?? null,
    exited,
    async terminate(graceMs: number): Promise<ProcessExit> {
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
      timer.unref();
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Splits streamed output into lines, treating carriage returns as line breaks. */
export class LineSplitter {
  #pending = "";
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.#pending + chunk).split(/\r\n|\n|\r/);
    this.#pending = parts.pop() ?? "";
    if (this.#pending.length > 64 * 1024) {
      this.onLine(this.#pending);
      this.#pending = "";
    }
    for (const part of parts) {
      if (part.trim()) this.onLine(part);
    }
  }

  flush(): void {
    if (this.#pending.trim()) this.onLine(this.#pending);
    this.#pending = "";
  }
}
```

## Appendix D: `redaction.ts` (reuse unchanged)

```ts
export const REDACTED = "[REDACTED]";

const SECRET_NAME_PATTERN =
  /(?:TOKEN(?!S|IZ)|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH(?!OR)|COOKIE)/i;

const MIN_LITERAL_SECRET_LENGTH = 6;
const MAX_LINE_LENGTH = 4096;

// Credential shapes that are recognizable without knowing the variable name.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Redacts credentials from text that will be stored or returned. Literal
 * values of secret-named environment variables are always removed, and common
 * credential shapes are removed even when their source is unknown.
 */
export class Redactor {
  readonly #literals: string[];

  constructor(literalSecrets: Iterable<string> = []) {
    this.#literals = [...new Set(literalSecrets)]
      .filter((value) => value.length >= MIN_LITERAL_SECRET_LENGTH)
      .sort((left, right) => right.length - left.length);
  }

  static fromEnvironment(
    ...environments: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>
  ): Redactor {
    const literals: string[] = [];
    for (const environment of environments) {
      for (const [name, value] of Object.entries(environment ?? {})) {
        if (value && isSecretName(name)) literals.push(value);
      }
    }
    return new Redactor(literals);
  }

  with(additionalSecrets: Iterable<string>): Redactor {
    return new Redactor([...this.#literals, ...additionalSecrets]);
  }

  redact(text: string): string {
    let result = text;
    for (const literal of this.#literals) {
      if (result.includes(literal)) result = result.split(literal).join(REDACTED);
    }
    result = result
      .replace(
        /\b(authorization|proxy-authorization)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s,;"']+/gi,
        (_m, header: string, separator: string, scheme?: string) =>
          `${header}${separator}${scheme ? `${scheme} ` : ""}${REDACTED}`,
      )
      .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
      .replace(
        /(--?[A-Za-z0-9-]*(?:token(?!s|iz)|secret|password|passwd|api-key|apikey|access-key|private-key)[A-Za-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi,
        `$1$2${REDACTED}`,
      )
      .replace(
        /("?[A-Za-z0-9_.-]*(?:token(?!s|iz)|secret|password|passwd|api_?key|access_?key|private_?key|credentials?)[A-Za-z0-9_.-]*"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi,
        (_m, prefix: string, value: string) =>
          value === REDACTED || value === `"${REDACTED}"`
            ? `${prefix}${value}`
            : `${prefix}${value.startsWith('"') ? `"${REDACTED}"` : REDACTED}`,
      );
    for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
    return result;
  }
}

/** Removes terminal control sequences, bounds length, and redacts secrets. */
export function sanitizeLogText(text: string, redactor: Redactor): string {
  const plain = text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  const bounded = plain.length > MAX_LINE_LENGTH
    ? `${plain.slice(0, MAX_LINE_LENGTH)}… [truncated ${plain.length - MAX_LINE_LENGTH} chars]`
    : plain;
  return redactor.redact(bounded);
}

/** Masks values of secret-named variables in a registry environment map. */
export function maskSecretEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [name, isSecretName(name) ? REDACTED : value]),
  );
}
```

## Appendix E: atomic write

```ts
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
```

Serialize writes so two saves can't interleave:

```ts
#writeChain: Promise<void> = Promise.resolve();
save(state: PersistedState): Promise<void> {
  const write = () => writeAtomically(this.#statePath, JSON.stringify(state));
  const next = this.#writeChain.then(write, write);
  this.#writeChain = next.catch(() => undefined);
  return next;
}
```

## Appendix F: `phases.ts` (reuse for Layer 7)

```ts
const PHASE_LABELS: Record<string, string> = {
  queued: "Queued", validating: "Validating",
  stopping_conflicting_models: "Stopping conflicting models", preparing: "Preparing",
  launching_runtime: "Launching runtime", loading_weights: "Loading weights",
  compiling: "Compiling", warming: "Warming up", waiting_for_readiness: "Waiting for readiness",
  terminating: "Terminating", verifying_shutdown: "Verifying shutdown",
  force_killing: "Force killing", complete: "Complete",
};

export function phase(code: string, extra: { current?: number; total?: number; detail?: Record<string, PhaseDetailValue> } = {}): Phase {
  const result: Phase = { code, label: PHASE_LABELS[code] ?? humanize(code) };
  if (extra.current !== undefined && extra.total !== undefined && extra.total > 0 &&
      extra.current >= 0 && extra.current <= extra.total) {
    result.current = extra.current;
    result.total = extra.total;
    result.percent = Math.floor((extra.current / extra.total) * 100);
  }
  if (extra.detail) result.detail = extra.detail;
  return result;
}

/** Startup phases in the order a launch normally moves through them. */
const STARTUP_ORDER = ["preparing", "launching_runtime", "loading_weights", "compiling", "warming", "waiting_for_readiness"] as const;

export function startupRank(code: string): number {
  return STARTUP_ORDER.indexOf(code as (typeof STARTUP_ORDER)[number]);
}

/*
 * Heuristics over recipe and engine output (vLLM, SGLang, TensorFold, Docker).
 * Callers only ever move a launch forward, so a stray match cannot regress
 * the reported phase. Rules are checked in this order; the first match wins.
 */
const PHASE_RULES = [
  { code: "waiting_for_readiness",
    pattern: /Uvicorn running|Application startup complete|server is fired up|Started server process/i },
  { code: "warming",
    pattern: /Capturing (?:CUDA|cuda)? ?graphs?|cuda graph|CUDA graph|warm(?:ing)?[ -]?up|Warmup|KV cache (?:pool|allocated)|Memory profiling/i },
  { code: "compiling",
    pattern: /torch\.compile|Compiling|compilation|inductor|autotun|Dynamo bytecode|AOT compile|Building (?:the )?(?:draft|engine)|JIT/i },
  { code: "loading_weights",
    pattern: /Loading (?:safetensors )?checkpoint shards|Loading weights|load_weights|Loading model|Model loading took|Loading .*shards?/i },
  { code: "launching_runtime",
    pattern: /Container .*(?:Started|Running|Created)|docker run|Starting (?:SGLang|vLLM|TensorFold|the server|server)|starting the server|Started\.|tensorfold-native serve|vllm serve|Initializing (?:a )?(?:V\d )?(?:LLM )?engine/i },
] as const;

export function detectStartupPhase(line: string): { code: string; current?: number; total?: number } | undefined {
  for (const rule of PHASE_RULES) {
    if (rule.pattern.test(line)) {
      if (rule.code === "loading_weights") {
        const progress = /(\d+)\s*\/\s*(\d+)/.exec(line);
        if (progress) return { code: rule.code, current: Number(progress[1]), total: Number(progress[2]) };
      }
      return { code: rule.code };
    }
  }
  return undefined;
}

function humanize(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}
```

## Appendix G: test helpers (`packages/api/test/helpers.mjs`)

Inject fakes through `createApp({ ..., lifecycle: { runtime, readiness, timing } })`
so tests never touch real containers and run in milliseconds.

```js
export const FAST_TIMING = {
  pollIntervalMs: 25,
  startTimeoutMs: 20_000,
  readinessTimeoutMs: 5_000,
  stopTimeoutMs: 5_000,
  stopVerifyTimeoutMs: 500,
  killGraceMs: 500,
  readinessCacheMs: 0,
};

/** In-memory stand-in for Docker: tests decide which containers each model owns. */
export class FakeRuntime {
  containers = new Map();
  killed = [];
  inspectError = null;
  unkillable = new Set();   // containers that ignore `docker kill`

  set(displayName, containers) { this.containers.set(displayName, containers); }

  async inspect(workspaces) {
    if (this.inspectError) throw new Error(this.inspectError);
    return new Map(workspaces.map((w) => [w.displayName, structuredClone(this.containers.get(w.displayName) ?? [])]));
  }

  async kill(ids) {
    this.killed.push(...ids);
    for (const containers of this.containers.values()) {
      for (const c of containers) {
        if (ids.includes(c.id) && !this.unkillable.has(c.id)) {
          Object.assign(c, { running: false, status: "exited", exitCode: 137 });
        }
      }
    }
  }
}

export class FakeProber {
  result = notReady("connection refused");
  calls = 0;
  async probe() { this.calls += 1; return structuredClone(this.result); }
}

export const ready = (servedModelIds = ["served-model"]) =>
  ({ endpointReachable: true, ready: true, servedModelIds, httpStatus: 200, error: null });
export const notReady = (error = "connection refused") =>
  ({ endpointReachable: false, ready: false, servedModelIds: [], httpStatus: null, error });

export function container(id, overrides = {}) {
  return { id, name: id, running: true, restarting: false, status: "running", exitCode: null,
           oomKilled: false, restartCount: 0, startedAt: new Date().toISOString(), finishedAt: null, ...overrides };
}
```

Other helpers:

- `createFixture(scripts, registryExtras)` creates a temp directory with one
  workspace per model. It writes executable `start.sh` and `stop.sh` from
  shell bodies (default `exit 0`) and a `registry.json`, and returns
  `{ registryPath, stateDirectory, workspaces, cleanup }`.
- `withApi(options, run)` listens on port 0, calls
  `run(baseUrl, { app, runtime, readiness, lifecycle })`, then closes the
  server and calls `lifecycle.close()` in `finally`.
- `postJson`, `getJson`, `modelUrl(base, name, suffix)`.
- `waitUntil(read, predicate, { timeoutMs, intervalMs })` and
  `waitForOperation(baseUrl, id, statuses)`. Always poll for state; never
  sleep for a fixed time.

**Driving containers from a fixture script:** have `start.sh` touch a marker
file (for example `touch "$PWD/.up"`), and have the test watch for the marker
and then call `runtime.set(name, [container("c1")])`. Alternatively, set the
runtime before the start and clear it in `stop.sh` via a marker the test
watches. Keep scripts free of phase-triggering text unless the test is about
phases.

**Testing real Docker parsing:** put a mock `docker` shell script first on
`PATH` that answers `ps` and `inspect` with canned output. Pass `useDocker:
true` to `withApi` so it uses `DockerRuntimeController`.

## Appendix H: test data worth keeping

Redactor cases. The environment is `{ HF_TOKEN: "literal-secret-value",
MAX_TOKENS: "4096", PATH: "/usr/bin" }`:

| Input | Expected |
| --- | --- |
| `value literal-secret-value here` | `value [REDACTED] here` |
| `Authorization: Bearer abc.def.ghi123` | `Authorization: Bearer [REDACTED]` |
| `curl -H 'authorization: token ghp_abcdefghijklmnopqrstuvwxyz'` | `curl -H 'authorization: token [REDACTED]'` |
| `HF_TOKEN=hf_abcdefghijklmnopqrstuv` | `HF_TOKEN=[REDACTED]` |
| `{"api_key": "sk-abcdefghijklmnopqrstuvwx"}` | `{"api_key": "[REDACTED]"}` |
| `--api-key s3cr3tvalue --port 8888` | `--api-key [REDACTED] --port 8888` |
| `postgres://user:pa55word@db:5432/x` | `postgres://[REDACTED]@db:5432/x` |
| `max_tokens=4096 --max-total-tokens 655360 tokenizer=auto` | unchanged |
| `MAX_TOKENS is 4096` | unchanged |

Sanitizing: `"\u001b[1;32mready\u001b[0m\u0007"` becomes `"ready"`. A
10,000-character line becomes under 4,200 characters and contains
`truncated 5904 chars`.

Phase detection:

| Line | Result |
| --- | --- |
| `Loading safetensors checkpoint shards:  58% Completed \| 42/72 [00:30<00:21]` | `loading_weights`, 42/72 |
| `INFO torch.compile takes 41.2 s in total` | `compiling` |
| `Capturing CUDA graphs (decode): 100%` | `warming` |
| `INFO:     Application startup complete.` | `waiting_for_readiness` |
| ` Container deepseek-v4  Started` | `launching_runtime` |
| `Listening on 0.0.0.0:8888` | no match (recipe banner) |
| `   http://127.0.0.1:8888/health — live logs above; Ctrl-C` | no match (recipe banner) |

---

## Lessons from the first attempt

- **TypeScript 7:** `typeof this.#method<T>` is a syntax error (TS1003).
  Declare a named type alias instead.
- **Waiting loops:** when a wait function returns a "poll again" outcome,
  loop until a real outcome. The first attempt treated the first poll as a
  timeout.
- **Status reads must not write state.** Writing on every poll rewrote the
  state file constantly.
- **Recovery should only observe.** Re-running recipe scripts on API restart
  could start models nobody asked for.
- **Readiness on a shared port:** only probe when the model's own containers
  exist, and use `expectedModelId` where the server lists models.
- **Real-Docker smoke test:** after Layers 2–4, run the built API
  (`pnpm build && node packages/api/dist/index.js`) against a temporary
  registry. Use a workspace whose `start.sh` runs a small container (for
  example `docker run -d --rm -v "$PWD:/w" alpine sleep 300`) and prints a
  fake `Loading checkpoint shards 1/2` line. Check status, logs (with a fake
  `HF_TOKEN` redacted), stop and the state file permissions. Delete the
  temporary registry afterwards.
- **Keep the manager small.** If `lifecycle.ts` grows past about 700 lines
  by Layer 7, look for removable generality before adding more.
