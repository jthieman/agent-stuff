import type { Command, IFileSystem, SecureFetch } from "just-bash";

export type SandboxBindingFunction = (...args: unknown[]) => unknown;

export interface SandboxBindingTree {
  [key: string]: SandboxBindingFunction | SandboxBindingTree;
}

export interface FsPolicy {
  roots: string[];
  read: boolean;
  write: boolean;
  mkdir: boolean;
  delete: boolean;
}

export interface RuntimePolicy {
  fs: FsPolicy | false;
  env: false | Record<string, string>;
  cpuLimitMs: number;
  wallClockLimitMs: number;
  memoryLimitMb: number;
  outputLimitBytes: number;
  maxFileBytes: number;
  maxBridgeCalls: number;
  maxBindingCalls: number;
  maxBindingCallDepth: number;
}

export interface RunJsOptions {
  cwd?: string;
  stdin?: string | Uint8Array;
  argv?: string[];
  filename?: string;
  fetch?: SecureFetch;
  policy?: Partial<RuntimePolicy>;
  bindings?: SandboxBindingTree;
}

export interface ExecJsOptions {
  cwd?: string;
  stdin?: string | Uint8Array;
  argv?: string[];
  env?: Record<string, string>;
  fetch?: SecureFetch;
  policy?: Partial<RuntimePolicy>;
  bindings?: SandboxBindingTree;
}

export interface RunJsResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: JsSandboxError;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  audit: JsRunAuditRecord;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  audit: JsRunAuditRecord;
}

export interface JsSandboxError {
  message: string;
  name?: string;
  code?: string | number;
}

export interface JsRunAuditRecord {
  runId: string;
  cwd: string;
  filename?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  limits: {
    cpuLimitMs: number;
    wallClockLimitMs: number;
    memoryLimitMb: number;
    outputLimitBytes: number;
    maxFileBytes: number;
    maxBridgeCalls: number;
  };
  fs: {
    reads: string[];
    writes: string[];
    deletes: string[];
    denied: Array<{
      op: string;
      path: string;
      reason: string;
    }>;
  };
  modules: {
    loaded: string[];
  };
  bindings: {
    calls: Array<{
      name: string;
      durationMs: number;
      ok: boolean;
    }>;
    denied: Array<{
      name: string;
      reason: string;
    }>;
  };
  output: {
    stdoutBytes: number;
    stderrBytes: number;
    truncated: boolean;
  };
  error?: JsSandboxError;
}

export interface ResolvedSandboxPath {
  input: string;
  absolute: string;
  root: string;
}

export interface SandboxMainContext {
  cwd: string;
  argv: string[];
  stdin: string | Uint8Array;
}

export interface JsSandbox {
  run<T = unknown>(code: string, options?: RunJsOptions): Promise<RunJsResult<T>>;
  exec(args: string[], options?: ExecJsOptions): Promise<ProcessResult>;
  createNodeCommand(): Command;
  dispose(): Promise<void>;
}

export interface CreateJsSandboxOptions {
  fs?: IFileSystem;
  defaultCwd?: string;
}

export type ParsedNodeCommand =
  | {
      kind: "eval";
      code: string;
      argv: string[];
    }
  | {
      kind: "script";
      path: string;
      argv: string[];
    }
  | {
      kind: "help";
    }
  | {
      kind: "version";
    };
