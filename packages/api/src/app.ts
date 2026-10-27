import { timingSafeEqual } from "node:crypto";

import {
  getModelStatus,
  getRegisteredModel,
  getRegisteredModels,
  startRegisteredModel,
  stopModel,
  UnknownModelError,
  type CommandResult,
  type RegisteredModel,
} from "@spark-manager/core";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";

export interface AppOptions {
  registryPath?: string;
  token?: string;
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");

  if (options.token) {
    app.use(requireBearerToken(options.token));
  }
  app.use(express.json({ limit: "8kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ service: "spark-manager", status: "ok" });
  });

  app.get("/models", async (_request, response) => {
    const models = await getRegisteredModels(options.registryPath);
    response.json({ models });
  });

  app.get("/models/status", async (_request, response) => {
    const registeredModels = await getRegisteredModels(options.registryPath);
    const models: Array<
      RegisteredModel &
        ({ command: CommandResult } | { error: { message: string } })
    > = [];
    for (const model of registeredModels) {
      try {
        const command = await getModelStatus({
          displayName: model.displayName,
          registryPath: options.registryPath,
        });
        models.push({ ...model, command });
      } catch (error) {
        models.push({
          ...model,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    response.json({ models });
  });

  app.get("/models/:displayName/status", async (request, response) => {
    const displayName = parseDisplayName(request.params.displayName);
    const model = await getRegisteredModel(
      displayName,
      options.registryPath,
    );
    const command = await getModelStatus({
      displayName: model.displayName,
      registryPath: options.registryPath,
    });
    response.json({ model: { ...model, command } });
  });

  app.post(
    "/models/:displayName/start",
    requireJsonRequest,
    async (request, response) => {
      const displayName = parseDisplayName(request.params.displayName);
      const bodyValue: unknown = request.body;
      if (
        typeof bodyValue !== "object" ||
        bodyValue === null ||
        Array.isArray(bodyValue)
      ) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Request body must be a JSON object.",
        );
      }
      const body = bodyValue as Record<string, unknown>;
      const unexpectedKeys = Object.keys(body).filter(
        (key) => key !== "switchRunning",
      );
      if (unexpectedKeys.length > 0) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          `Unexpected request field: ${unexpectedKeys[0]}.`,
        );
      }
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
      const result = await startRegisteredModel({
        displayName,
        registryPath: options.registryPath,
        confirmSwitch: async () => switchRunning,
      });

      if (result.outcome === "cancelled") {
        response.status(409).json({
          error: {
            code: "MODEL_ALREADY_RUNNING",
            message:
              "Another registered model is running. Retry with switchRunning set to true to stop it first.",
            runningModels: result.runningModels,
          },
        });
        return;
      }
      if (result.outcome === "stop-failed") {
        sendCommandFailure(
          response,
          `Unable to stop ${JSON.stringify(result.model.displayName)} before starting the requested model.`,
          result.result,
        );
        return;
      }
      if (commandFailed(result.result)) {
        sendCommandFailure(response, "The model start command failed.", result.result);
        return;
      }

      response.json({
        model: { displayName },
        stoppedModels: result.stoppedModels,
        command: result.result,
      });
    },
  );

  app.post(
    "/models/:displayName/stop",
    requireJsonRequest,
    async (request, response) => {
      const displayName = parseDisplayName(request.params.displayName);
      const model = await getRegisteredModel(
        displayName,
        options.registryPath,
      );
      const command = await stopModel({
        displayName: model.displayName,
        registryPath: options.registryPath,
      });
      if (commandFailed(command)) {
        sendCommandFailure(response, "The model stop command failed.", command);
        return;
      }
      response.json({ model, command });
    },
  );

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof UnknownModelError) {
      response.status(404).json({
        error: { code: "MODEL_NOT_FOUND", message: error.message },
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

    console.error(error);
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
      "INVALID_REQUEST",
      "Model display name must not be empty.",
    );
  }
  return value;
}

function commandFailed(result: CommandResult): boolean {
  return result.exitCode !== 0 || result.signal !== null;
}

function sendCommandFailure(
  response: express.Response,
  message: string,
  command: CommandResult,
): void {
  response.status(502).json({
    error: { code: "COMMAND_FAILED", message, command },
  });
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
