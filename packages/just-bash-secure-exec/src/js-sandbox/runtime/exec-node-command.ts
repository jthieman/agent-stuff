import type { IFileSystem } from "just-bash";

import { AuditRecorder, createAuditRecord } from "../audit/audit-recorder.ts";
import { parseNodeCommand, nodeHelpText } from "../command/node-flags.ts";
import { resolveSandboxPath } from "../fs/path-policy.ts";
import { SANDBOX_NODE_VERSION } from "../node-version.ts";
import { resolveRuntimePolicy } from "../policy/runtime-policy.ts";
import type { ExecJsOptions, ProcessResult, SandboxBindingTree } from "../types.ts";
import { normalizeError } from "./normalize-error.ts";
import { runCode } from "./run-code.ts";

interface ExecNodeCommandOptions {
  args: string[];
  fs: IFileSystem;
  defaults: {
    cwd: string;
    bindings: SandboxBindingTree;
  };
  options?: ExecJsOptions;
}

export async function execNodeCommand({
  args,
  fs,
  defaults,
  options = {},
}: ExecNodeCommandOptions): Promise<ProcessResult> {
  const startedAtMs = Date.now();
  const cwd = options.cwd ?? defaults.cwd;
  const policy = resolveRuntimePolicy({
    ...options.policy,
    env: options.policy?.env ?? options.env ?? false,
  });

  let parsed;
  try {
    parsed = parseNodeCommand(args);
  } catch (error) {
    return failedProcessResult({
      startedAtMs,
      cwd,
      policy,
      error,
    });
  }

  if (parsed.kind === "help") {
    const audit = new AuditRecorder(
      createAuditRecord({
        cwd,
        policy,
      }),
    ).finish({
      startedAtMs,
      exitCode: 0,
      timedOut: false,
    });
    return {
      stdout: nodeHelpText(),
      stderr: "",
      exitCode: 0,
      durationMs: audit.durationMs,
      audit,
    };
  }

  if (parsed.kind === "version") {
    const audit = new AuditRecorder(
      createAuditRecord({
        cwd,
        policy,
      }),
    ).finish({
      startedAtMs,
      exitCode: 0,
      timedOut: false,
    });
    return {
      stdout: `${SANDBOX_NODE_VERSION}\n`,
      stderr: "",
      exitCode: 0,
      durationMs: audit.durationMs,
      audit,
    };
  }

  if (parsed.kind === "eval") {
    const argv = ["node", ...parsed.argv];
    const result = await runCode({
      code: parsed.code,
      fs,
      defaults: {
        cwd,
        filename: "/__eval__.mjs",
        bindings: options.bindings ?? defaults.bindings,
      },
      policy,
      options: {
        ...runOptionsFromExecOptions(options),
        argv,
        cwd,
        filename: "/__eval__.mjs",
      },
    });

    return toProcessResult(result);
  }

  let filename;
  try {
    if (policy.fs === false) {
      throw new Error("Filesystem disabled");
    }

    filename = resolveSandboxPath(parsed.path, {
      cwd,
      roots: policy.fs.roots,
      allowRelative: true,
    }).absolute;
  } catch (error) {
    return failedProcessResult({
      startedAtMs,
      cwd,
      filename: parsed.path,
      policy,
      error,
    });
  }

  const result = await runCode({
    fs,
    defaults: {
      cwd,
      filename,
      bindings: options.bindings ?? defaults.bindings,
    },
    policy,
    options: {
      ...runOptionsFromExecOptions(options),
      argv: ["node", filename, ...parsed.argv],
      cwd,
      filename,
    },
  });

  return toProcessResult(result);
}

function runOptionsFromExecOptions({
  policy: _policy,
  ...options
}: ExecJsOptions): Omit<ExecJsOptions, "policy"> {
  return options;
}

function failedProcessResult(options: {
  startedAtMs: number;
  cwd: string;
  filename?: string;
  policy: ReturnType<typeof resolveRuntimePolicy>;
  error: unknown;
}): ProcessResult {
  const normalized = normalizeError(options.error);
  const audit = new AuditRecorder(
    createAuditRecord({
      cwd: options.cwd,
      filename: options.filename,
      policy: options.policy,
    }),
  ).finish({
    startedAtMs: options.startedAtMs,
    exitCode: 1,
    timedOut: false,
    error: normalized,
  });

  return {
    stdout: "",
    stderr: `${normalized.message}\n`,
    exitCode: 1,
    durationMs: audit.durationMs,
    audit,
  };
}

function toProcessResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: { message: string };
  durationMs: number;
  audit: ProcessResult["audit"];
}): ProcessResult {
  const errorText = result.error === undefined ? "" : `${result.error.message}\n`;

  return {
    stdout: result.stdout,
    stderr: result.stderr + errorText,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    audit: result.audit,
  };
}
