import { randomUUID, timingSafeEqual } from "node:crypto";

import {
  DockerRuntimeController,
  getRegisteredModels,
  getRunningRegisteredModels,
  LifecycleManager,
  LifecycleRequestError,
  maskSecretEnvironment,
  OPERATION_ID_PATTERN,
  UnknownModelError,
  type LifecycleTiming,
  type Operation,
  type RegisteredModel,
  type RuntimeController,
} from "@spark-manager/core";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";

export interface AppOptions {
  registryPath?: string;
  token?: string;
  logger?: ApiLogger | false;
  lifecycle?: {
    /** Test-only: a fake runtime used instead of querying Docker. Leave unset in production. */
    runtime?: RuntimeController;
    /** Test-only: shorter timeouts. */
    timing?: Partial<LifecycleTiming>;
  };
}

export interface ApiLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface RequestLogContext {
  requestId: string;
  startedAt: number;
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  const logger = options.logger === false ? undefined : (options.logger ?? console);
  const requestLogContexts = new WeakMap<express.Request, RequestLogContext>();
  const runtime = options.lifecycle?.runtime ?? new DockerRuntimeController();
  const log = (
    level: keyof ApiLogger,
    event: string,
    fields: Record<string, unknown>,
  ): void => {
    logger?.[level](JSON.stringify({ service: "spark-manager-api", event, ...fields }));
  };
  const lifecycle = new LifecycleManager({
    registryPath: options.registryPath,
    runtime,
    timing: options.lifecycle?.timing,
    secrets: options.token ? [options.token] : [],
    onOperationFinished: (operation) => {
      log(operation.status === "failed" ? "warn" : "info", `model.${operation.kind}.finished`, {
        requestId: operation.requestId,
        operationId: operation.operationId,
        displayName: operation.displayName,
        status: operation.status,
        errorCode: operation.error?.code ?? null,
        exitCode: operation.command?.exitCode ?? null,
        signal: operation.command?.signal ?? null,
      });
    },
  });
  app.locals.lifecycle = lifecycle;
  app.disable("x-powered-by");

  app.use((request, response, next) => {
    if (!isModelLifecycleRequest(request)) {
      next();
      return;
    }
    const requestId = validRequestId(request.get("x-request-id")) ?? randomUUID();
    const context = { requestId, startedAt: performance.now() };
    requestLogContexts.set(request, context);
    response.setHeader("x-request-id", requestId);
    log("info", "request.started", {
      requestId,
      method: request.method,
      path: request.originalUrl,
      contentType: request.get("content-type") ?? null,
      contentLength: request.get("content-length") ?? null,
      authorizationPresent: Boolean(request.get("authorization")),
      remoteAddress: request.ip,
    });
    response.once("finish", () => {
      const durationMs = Math.round((performance.now() - context.startedAt) * 10) / 10;
      log(response.statusCode >= 400 ? "warn" : "info", "request.completed", {
        requestId,
        method: request.method,
        path: request.originalUrl,
        status: response.statusCode,
        durationMs,
      });
    });
    next();
  });

  if (options.token) {
    app.use(requireBearerToken(options.token));
  }
  app.use(express.json({ limit: "8kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ service: "spark-manager", status: "ok" });
  });

  app.get("/models", async (_request, response) => {
    const models = await getRegisteredModels(options.registryPath);
    response.json({ models: models.map(maskModel) });
  });

  app.get("/models/status", async (_request, response) => {
    const models = await lifecycle.getStatuses();
    response.json({ models });
  });

  app.get("/models/running", async (_request, response) => {
    const models = await getRunningRegisteredModels(
      options.registryPath,
      runtime,
    );
    response.json({ models: models.map(maskModel) });
  });

  app.get("/models/:displayName/status", async (request, response) => {
    const displayName = parseDisplayName(request.params.displayName);
    const model = await lifecycle.getStatus(displayName);
    response.json({ model });
  });

  app.get("/models/:displayName/logs", async (request, response) => {
    const displayName = parseDisplayName(request.params.displayName);
    const query = parseLogQuery(request.query);
    response.json(await lifecycle.getLogs(displayName, query));
  });

  app.post(
    "/models/:displayName/start",
    requireJsonRequest,
    async (request, response) => {
      const displayName = parseDisplayName(request.params.displayName);
      const body = parseBody(request.body, [
        "switchRunning",
        "launchOptionSelections",
      ]);
      if (
        body.switchRunning !== undefined &&
        typeof body.switchRunning !== "boolean"
      ) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "switchRunning must be a boolean.",
        );
      }
      const switchRunning = body.switchRunning ?? false;
      const launchOptionSelections = parseLaunchOptionSelections(
        body.launchOptionSelections,
      );
      const requestId = requestLogContexts.get(request)?.requestId ?? null;
      const operation = await lifecycle.start(
        displayName,
        {
          switchRunning,
          ...(launchOptionSelections ? { launchOptionSelections } : {}),
        },
        requestId,
      );
      log("info", "model.start.requested", {
        requestId,
        operationId: operation.operationId,
        displayName,
        switchRunning,
      });
      sendAccepted(response, operation);
    },
  );

  app.post(
    "/models/:displayName/stop",
    requireJsonRequest,
    async (request, response) => {
      const displayName = parseDisplayName(request.params.displayName);
      // express.json leaves the body undefined when the request has none.
      parseBody(request.body ?? {}, []);
      const requestId = requestLogContexts.get(request)?.requestId ?? null;
      const operation = await lifecycle.stop(displayName, requestId);
      log("info", "model.stop.requested", {
        requestId,
        operationId: operation.operationId,
        displayName,
      });
      sendAccepted(response, operation);
    },
  );

  app.get("/operations/:operationId", (request, response) => {
    const { operationId } = request.params;
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new HttpError(
        400,
        "INVALID_OPERATION_ID",
        "Operation IDs look like op_ followed by 32 lowercase hex characters.",
      );
    }
    const operation = lifecycle.getOperation(operationId);
    if (!operation) {
      throw new HttpError(
        404,
        "OPERATION_NOT_FOUND",
        `Unknown operation ${JSON.stringify(operationId)}.`,
      );
    }
    response.json({ operation });
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    const context = requestLogContexts.get(request);
    if (context) {
      log(error instanceof HttpError ||
        error instanceof LifecycleRequestError ||
        error instanceof UnknownModelError ||
        isBodyParserError(error)
        ? "warn"
        : "error", "request.failed", {
        requestId: context.requestId,
        method: request.method,
        path: request.originalUrl,
        error: describeError(error),
      });
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof LifecycleRequestError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message, ...error.details },
      });
      return;
    }
    if (error instanceof UnknownModelError) {
      // The core message names the registry path, which clients don't need.
      response.status(404).json({
        error: {
          code: "MODEL_NOT_FOUND",
          message: `Unknown model ${JSON.stringify(error.displayName)}.`,
        },
      });
      return;
    }
    if (isBodyParserError(error)) {
      response.status(error.status).json({
        error: {
          code: error.status === 413 ? "BODY_TOO_LARGE" : "INVALID_JSON",
          message:
            error.status === 413
              ? "Request body is too large."
              : "Request body must be valid JSON.",
        },
      });
      return;
    }
    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unexpected error.",
      },
    });
  };
  app.use(errorHandler);

  return app;
}

function validRequestId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function isModelLifecycleRequest(request: express.Request): boolean {
  return (
    request.method === "POST" &&
    /^\/models\/[^/]+\/(?:start|stop)$/.test(request.path)
  );
}

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    ...("code" in error ? { code: error.code } : {}),
    ...("status" in error ? { status: error.status } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const requireJsonRequest: RequestHandler = (request, _response, next) => {
  if (!request.is("application/json")) {
    next(
      new HttpError(
        415,
        "JSON_REQUIRED",
        "Mutation requests must use Content-Type: application/json.",
      ),
    );
    return;
  }
  next();
};

function requireBearerToken(expectedToken: string): RequestHandler {
  return (request, response, next) => {
    const authorization = request.get("authorization");
    const actualToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    if (!actualToken || !safeEqual(actualToken, expectedToken)) {
      response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid bearer token is required.",
        },
      });
      return;
    }
    next();
  };
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function parseDisplayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(
      400,
      "INVALID_MODEL_NAME",
      "Model display name must not be empty.",
    );
  }
  // Checked before the registry lookup so oversized or control-character names never reach logs or messages.
  if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(
      400,
      "INVALID_MODEL_NAME",
      "Model display name must be at most 256 characters with no control characters.",
    );
  }
  return value;
}

function parseBody(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "Request body must be a JSON object.",
    );
  }
  const unexpectedKey = Object.keys(value).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpectedKey !== undefined) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Unexpected request field: ${unexpectedKey}.`,
    );
  }
  return value as Record<string, unknown>;
}

function sendAccepted(response: express.Response, operation: Operation): void {
  const statusUrl = `/operations/${operation.operationId}`;
  response.status(202).location(statusUrl).json({
    operationId: operation.operationId,
    kind: operation.kind,
    model: operation.displayName,
    desiredState: operation.kind === "start" ? "running" : "stopped",
    lifecycleState: "queued",
    operationStatus: operation.status,
    statusUrl,
    modelStatusUrl: `/models/${encodeURIComponent(operation.displayName)}/status`,
  });
}

/** Hides values of secret-named variables in launch option environments. */
function maskModel(model: RegisteredModel): RegisteredModel {
  if (!model.launchOptions) {
    return model;
  }
  return {
    ...model,
    launchOptions: model.launchOptions.map((option) => ({
      ...option,
      choices: option.choices.map((choice) => ({
        ...choice,
        environment: maskSecretEnvironment(choice.environment),
      })),
    })),
  };
}

function parseLogQuery(query: Record<string, unknown>): { after: number; limit: number } {
  const bounds = { after: [0, Number.MAX_SAFE_INTEGER], limit: [1, 1000] } as const;
  const result = { after: 0, limit: 200 };
  for (const [name, value] of Object.entries(query)) {
    if (name !== "after" && name !== "limit") {
      throw new HttpError(400, "INVALID_LOG_QUERY", `Unexpected query parameter ${JSON.stringify(name)}.`);
    }
    const [min, max] = bounds[name];
    const number = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
    if (!(number >= min && number <= max)) {
      throw new HttpError(
        400,
        "INVALID_LOG_QUERY",
        `${name} must be a single integer from ${min} to ${max === Number.MAX_SAFE_INTEGER ? "2^53 - 1" : max}.`,
      );
    }
    result[name] = number;
  }
  return result;
}

function parseLaunchOptionSelections(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "launchOptionSelections must be an object.",
    );
  }
  const selections: Record<string, string> = {};
  for (const [optionId, choiceId] of Object.entries(value)) {
    if (typeof choiceId !== "string") {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        `launchOptionSelections.${optionId} must be a string.`,
      );
    }
    selections[optionId] = choiceId;
  }
  return selections;
}

function isBodyParserError(
  error: unknown,
): error is Error & { status: 400 | 413 } {
  return (
    error instanceof Error &&
    "status" in error &&
    (error.status === 400 || error.status === 413)
  );
}
