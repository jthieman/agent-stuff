import type { JsSandboxError } from "../types.ts";

export class JsSandboxRuntimeError extends Error {
  readonly code: string | number;
  readonly cause?: unknown;

  constructor(code: string | number, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "JsSandboxRuntimeError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export function normalizeError(error: unknown): JsSandboxError {
  if (error instanceof Error) {
    // Result and audit errors are public adapter output; keep host stacks and nested causes private.
    return {
      message: error.message.trim().length === 0 ? error.name : error.message,
      name: error.name,
      code: readErrorCode(error),
    };
  }

  const message = formatUnknownError(error);
  return {
    message: message.length === 0 ? "JavaScript threw a non-Error value" : message,
  };
}

function readErrorCode(error: Error): string | number | undefined {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    return code;
  }

  return undefined;
}

function formatUnknownError(error: unknown): string {
  if (error === undefined || error === null) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }

  if (typeof error === "symbol") {
    return error.description ?? "symbol";
  }

  if (typeof error === "function") {
    return error.name.length === 0 ? "function" : `function ${error.name}`;
  }

  if (typeof error === "object") {
    const maybeError = error as { message?: unknown };
    if (typeof maybeError.message === "string") {
      return maybeError.message;
    }

    try {
      const json = JSON.stringify(error);
      return json === undefined ? "" : json;
    } catch {
      return "";
    }
  }

  return "";
}
