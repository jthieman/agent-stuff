import { Buffer } from "node:buffer";

import type { IFileSystem, SecureFetch } from "just-bash";
import {
  type NetworkAdapter,
  NodeExecutionDriver,
  NodeRuntime,
  createNodeDriver,
  type NodeRuntimeDriverFactory,
  type RunResult,
  type StdioEvent,
} from "secure-exec";

import { AuditRecorder, createAuditRecord } from "../audit/audit-recorder.ts";
import { createSandboxBindings } from "../bindings/binding-bridge.ts";
import { SecureExecJustBashFileSystem } from "../fs/secure-exec-vfs.ts";
import { SANDBOX_NODE_VERSION } from "../node-version.ts";
import { createSecureExecPermissions } from "../policy/secure-exec-permissions.ts";
import type { RunJsOptions, RunJsResult, RuntimePolicy, SandboxBindingTree } from "../types.ts";
import { resolveRuntimePolicy } from "../policy/runtime-policy.ts";
import { normalizeError } from "./normalize-error.ts";
import { OutputCapture } from "./output-capture.ts";
import { assertSerializable } from "./serialization.ts";

interface RunCodeOptions {
  code?: string;
  fs: IFileSystem;
  defaults: {
    cwd: string;
    filename: string;
    bindings: SandboxBindingTree;
  };
  policy?: RuntimePolicy;
  options?: RunJsOptions;
}

const WRAPPER_FILENAME = "/__secure_exec_entry_wrapper__.mjs";
const OUTPUT_BUDGET_HEADROOM_BYTES = 64 * 1024;

interface WrapperRunResult {
  value?: unknown;
  exitCode: number;
}

type CommandExecutor = NonNullable<
  NonNullable<Parameters<typeof createNodeDriver>[0]>["commandExecutor"]
>;

// Mirrors @secure-exec/core's GNU timeout convention; not exported by secure-exec.
const SECURE_EXEC_TIMEOUT_EXIT_CODE = 124;

export async function runCode<T = unknown>({
  code,
  fs,
  defaults,
  policy: resolvedPolicy,
  options = {},
}: RunCodeOptions): Promise<RunJsResult<T>> {
  const startedAtMs = Date.now();
  const cwd = options.cwd ?? defaults.cwd;
  const filename = options.filename ?? defaults.filename;
  const policy = resolvedPolicy ?? resolveRuntimePolicy(options.policy);
  const audit = new AuditRecorder(
    createAuditRecord({
      cwd,
      filename,
      policy,
    }),
  );
  const output = new OutputCapture(policy.outputLimitBytes);
  const bindings = createSandboxBindings({
    bindings: options.bindings ?? defaults.bindings,
    policy,
    audit,
  });
  const virtualFs = new SecureExecJustBashFileSystem(fs, audit, cwd, policy);
  if (code !== undefined) {
    virtualFs.addVirtualFile(filename, code);
  }
  const wrapperCode = createWrapperCode({
    entryPath: filename,
    cwd,
    argv: options.argv ?? [],
    stdin: normalizeStdin(options.stdin),
  });
  const internalPaths = code === undefined ? [WRAPPER_FILENAME] : [filename, WRAPPER_FILENAME];
  const permissions = createSecureExecPermissions({
    policy,
    cwd,
    audit,
    internalPaths,
    allowNetwork: options.fetch !== undefined,
  });
  audit.moduleLoaded(WRAPPER_FILENAME);
  if (code !== undefined) {
    audit.moduleLoaded(filename);
  }
  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: virtualFs,
      commandExecutor: createDenyOnlyCommandExecutor(),
      networkAdapter: createNetworkAdapter(options.fetch),
      permissions,
      processConfig: {
        argv: options.argv ?? [],
        cwd,
        env: policy.env === false ? {} : policy.env,
        stdin: normalizeStdin(options.stdin),
        platform: "sandbox",
        version: SANDBOX_NODE_VERSION,
      },
      osConfig: {
        platform: "sandbox",
        tmpdir: "/tmp",
        homedir: cwd,
      },
    }),
    runtimeDriverFactory: createBindingRuntimeDriverFactory({
      bindings,
    }),
    memoryLimit: policy.memoryLimitMb,
    cpuTimeLimitMs: policy.cpuLimitMs,
    onStdio: (event) => captureStdio(output, event),
    resourceBudgets: {
      maxOutputBytes: policy.outputLimitBytes + OUTPUT_BUDGET_HEADROOM_BYTES,
      maxBridgeCalls: policy.maxBridgeCalls,
      // Child process access is denied by permissions and the executor; keep the budget aligned.
      maxChildProcesses: 0,
    },
  });

  let value: T | undefined;
  let normalizedError = undefined as ReturnType<typeof normalizeError> | undefined;
  let exitCode = 0;
  let timedOut = false;

  try {
    const result = await runWithWallClockLimit<{ default?: WrapperRunResult }>({
      runtime,
      code: wrapperCode,
      filename: WRAPPER_FILENAME,
      timeoutMs: policy.wallClockLimitMs,
    });
    exitCode = result.code;
    if (result.code === 0) {
      const wrapperResult = assertSerializable(result.exports?.default) as
        | WrapperRunResult
        | undefined;
      exitCode = normalizeExitCode(wrapperResult?.exitCode);
      value = wrapperResult?.value as T;
    } else {
      normalizedError = normalizeRuntimeError(result.errorMessage, audit);
      timedOut = isTimeoutError(normalizedError, result.code, audit);
      if (timedOut) {
        normalizedError = withTimeoutCode(normalizedError);
      }
    }
  } catch (error) {
    normalizedError = normalizeRuntimeError(error, audit);
    timedOut = isTimeoutError(normalizedError, undefined, audit);
    if (timedOut) {
      normalizedError = withTimeoutCode(normalizedError);
    }
    exitCode = 1;
  } finally {
    await runtime.terminate().catch(() => undefined);
    runtime.dispose();
    audit.setOutput({
      stdoutBytes: output.stdoutBytes,
      stderrBytes: output.stderrBytes,
      truncated: output.truncated,
    });
  }

  if (output.truncated && normalizedError === undefined) {
    normalizedError = {
      code: "OUTPUT_LIMIT",
      message: "Output limit exceeded",
    };
    exitCode = 1;
  }

  const auditRecord = audit.finish({
    startedAtMs,
    exitCode,
    timedOut,
    error: normalizedError,
  });

  return {
    ok: normalizedError === undefined && exitCode === 0,
    value,
    error: normalizedError,
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode,
    durationMs: auditRecord.durationMs,
    audit: auditRecord,
  };
}

async function runWithWallClockLimit<T>(options: {
  runtime: NodeRuntime;
  code: string;
  filename: string;
  timeoutMs: number;
}): Promise<RunResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutResult = new Promise<RunResult<T>>((resolve) => {
    timeout = setTimeout(() => {
      void options.runtime.terminate().catch(() => undefined);
      resolve({
        code: SECURE_EXEC_TIMEOUT_EXIT_CODE,
        errorMessage: `Execution timed out after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      options.runtime.run<T>(options.code, options.filename),
      timeoutResult,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function createWrapperCode(options: {
  entryPath: string;
  cwd: string;
  argv: string[];
  stdin: string;
}): string {
  return `
    const __context = Object.freeze({
      cwd: ${JSON.stringify(options.cwd)},
      argv: Object.freeze(${JSON.stringify(options.argv)}),
      stdin: ${JSON.stringify(options.stdin)},
    });

    let __value;
    let __processExitCode;

    try {
      const __entry = await import(${JSON.stringify(options.entryPath)});
      __value =
        typeof __entry.default === "function"
          ? await __entry.default(__context)
          : __entry.default;
    } catch (__error) {
      if (__error !== null && typeof __error === "object") {
        if (__error.name === "ProcessExitError") {
          __processExitCode = Number(__error.code);
        } else if (typeof __error.message === "string") {
          const __normalizedError = new Error(__error.message);
          if (typeof __error.name === "string") {
            __normalizedError.name = __error.name;
          }
          throw __normalizedError;
        } else {
          throw __error;
        }
      } else {
        throw __error;
      }
    }

    const __rawExitCode =
      __processExitCode === undefined ? globalThis.process?.exitCode : __processExitCode;
    const __exitCode = Number(__rawExitCode ?? 0);

    export default {
      value: __value,
      exitCode: Number.isFinite(__exitCode) ? __exitCode : 1,
    };
  `;
}

function createBindingRuntimeDriverFactory(options: {
  bindings: SandboxBindingTree;
}): NodeRuntimeDriverFactory {
  return {
    createRuntimeDriver(runtimeOptions) {
      return new NodeExecutionDriver({
        ...runtimeOptions,
        bindings: options.bindings,
      });
    },
  };
}

function captureStdio(output: OutputCapture, event: StdioEvent): void {
  try {
    output.write(event.channel, event.message);
  } catch {
    // OutputCapture has already clipped the stream. Secure Exec treats stdio hook
    // failures as non-fatal, so the isolate may continue and a later runtime
    // failure or timeout should remain the primary error.
  }
}

function normalizeStdin(stdin: string | Uint8Array | undefined): string {
  if (stdin === undefined) {
    return "";
  }

  return typeof stdin === "string" ? stdin : new TextDecoder().decode(stdin);
}

function createDenyOnlyCommandExecutor(): CommandExecutor {
  return {
    spawn(command) {
      throw new Error(`Child process access denied: ${command}`);
    },
  };
}

function createDenyOnlyNetworkAdapter(): NetworkAdapter {
  const deny = (target: string) => {
    throw new Error(`Network access denied: ${target}`);
  };

  return {
    async fetch(url) {
      return deny(url);
    },
    async dnsLookup(hostname) {
      return deny(hostname);
    },
    async httpRequest(url) {
      return deny(url);
    },
  };
}

function createNetworkAdapter(fetch: SecureFetch | undefined): NetworkAdapter {
  if (fetch === undefined) {
    return createDenyOnlyNetworkAdapter();
  }

  return {
    async fetch(url, options) {
      const response = await secureFetchRequest(fetch, url, options);
      return {
        ...response,
        ok: response.status >= 200 && response.status < 300,
        redirected: response.url !== url,
      };
    },
    async dnsLookup(hostname) {
      return {
        error: `DNS lookup denied: ${hostname}`,
        code: "EACCES",
      };
    },
    async httpRequest(url, options) {
      return await secureFetchRequest(fetch, url, options);
    },
  };
}

async function secureFetchRequest(
  fetch: SecureFetch,
  url: string,
  options: Parameters<NetworkAdapter["fetch"]>[1],
): Promise<Awaited<ReturnType<NetworkAdapter["httpRequest"]>>> {
  const fetchOptions: NonNullable<Parameters<SecureFetch>[1]> = {};

  if (options.method !== undefined) {
    fetchOptions.method = options.method;
  }
  if (options.headers !== undefined) {
    fetchOptions.headers = options.headers;
  }
  if (options.body !== undefined && options.body !== null) {
    fetchOptions.body = options.body;
  }

  const response = await fetch(url, fetchOptions);

  return {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...response.headers,
      "x-body-encoding": "base64",
    },
    body: Buffer.from(response.body).toString("base64"),
    url: response.url,
  };
}

function isTimeoutError(
  error: ReturnType<typeof normalizeError> | undefined,
  exitCode: number | undefined,
  audit: AuditRecorder,
): boolean {
  return (
    exitCode === SECURE_EXEC_TIMEOUT_EXIT_CODE ||
    error?.name === "AbortError" ||
    audit.record.bindings.denied.some((denial) => denial.reason === "binding call timed out")
  );
}

function withTimeoutCode(
  error: ReturnType<typeof normalizeError>,
): ReturnType<typeof normalizeError> {
  return {
    ...error,
    code: error.code ?? "TIMEOUT",
  };
}

function normalizeRuntimeError(
  error: unknown,
  audit: AuditRecorder,
): ReturnType<typeof normalizeError> {
  const normalized = normalizeError(error);
  if (normalized.message !== "[object Object]") {
    return normalized;
  }

  // Secure Exec 0.2.x exposes run failures through errorMessage only. Host binding
  // failures can stringify to "[object Object]", so recover the audited denial
  // reason here until Secure Exec exposes a structured runtime error channel.
  const bindingDenial = audit.record.bindings.denied.at(-1);
  if (bindingDenial === undefined) {
    return normalized;
  }

  return {
    ...normalized,
    message: formatBindingDenial(bindingDenial.name, bindingDenial.reason),
  };
}

function formatBindingDenial(name: string, reason: string): string {
  if (reason === "bindings disabled by policy") {
    return `Binding not allowed: ${name}`;
  }

  if (reason === "binding call timed out") {
    return `Binding call timed out: ${name}`;
  }

  if (reason === "max binding call count exceeded") {
    return "Maximum binding call count exceeded";
  }

  if (reason === "max binding call depth exceeded") {
    return "Maximum binding call depth exceeded";
  }

  if (reason.includes("JSON-serializable")) {
    return `Binding result denied: ${reason}`;
  }

  return `Binding denied: ${name}`;
}

function normalizeExitCode(exitCode: number | undefined): number {
  if (exitCode === undefined) {
    return 0;
  }

  if (!Number.isFinite(exitCode)) {
    return 1;
  }

  return Math.max(0, Math.min(255, Math.trunc(exitCode)));
}
