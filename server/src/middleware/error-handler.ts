import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@founderos/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { getRequestContext } from "../lib/request-context.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

/** Echo the requestId in the JSON error body so the client can quote it
 *  when reporting an issue, and a support engineer can grep server logs
 *  / Sentry by the same ID. */
function withRequestId<T extends Record<string, unknown>>(body: T): T & { requestId?: string } {
  const reqId = getRequestContext()?.requestId;
  return reqId ? { ...body, requestId: reqId } : body;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json(withRequestId({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    }));
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json(withRequestId({ error: "Validation error", details: err.errors }));
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json(withRequestId({ error: "Internal server error" }));
}
