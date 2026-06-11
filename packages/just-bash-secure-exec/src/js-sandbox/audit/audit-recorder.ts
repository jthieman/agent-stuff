import { randomUUID } from "node:crypto";

import type { JsRunAuditRecord, JsSandboxError, RuntimePolicy } from "../types.ts";

export function createAuditRecord(options: {
  cwd: string;
  filename?: string;
  policy: RuntimePolicy;
}): JsRunAuditRecord {
  const startedAt = new Date().toISOString();

  return {
    runId: randomUUID(),
    cwd: options.cwd,
    filename: options.filename,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    exitCode: 0,
    timedOut: false,
    limits: {
      cpuLimitMs: options.policy.cpuLimitMs,
      wallClockLimitMs: options.policy.wallClockLimitMs,
      memoryLimitMb: options.policy.memoryLimitMb,
      outputLimitBytes: options.policy.outputLimitBytes,
      maxFileBytes: options.policy.maxFileBytes,
      maxBridgeCalls: options.policy.maxBridgeCalls,
    },
    fs: {
      reads: [],
      writes: [],
      deletes: [],
      denied: [],
    },
    modules: {
      loaded: [],
    },
    bindings: {
      calls: [],
      denied: [],
    },
    output: {
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
    },
  };
}

export class AuditRecorder {
  readonly record: JsRunAuditRecord;

  constructor(record: JsRunAuditRecord) {
    this.record = record;
  }

  fsRead(path: string): void {
    this.record.fs.reads.push(path);
  }

  fsWrite(path: string): void {
    this.record.fs.writes.push(path);
  }

  fsDelete(path: string): void {
    this.record.fs.deletes.push(path);
  }

  deniedFsOp(op: string, path: string, reason: string): void {
    this.record.fs.denied.push({ op, path, reason });
  }

  moduleLoaded(specifier: string): void {
    if (!this.record.modules.loaded.includes(specifier)) {
      this.record.modules.loaded.push(specifier);
    }
  }

  bindingCall(name: string, durationMs: number, ok: boolean): void {
    this.record.bindings.calls.push({ name, durationMs, ok });
  }

  bindingDenied(name: string, reason: string): void {
    this.record.bindings.denied.push({ name, reason });
  }

  setOutput(options: { stdoutBytes: number; stderrBytes: number; truncated: boolean }): void {
    this.record.output = options;
  }

  finish(options: {
    startedAtMs: number;
    exitCode: number;
    timedOut: boolean;
    error?: JsSandboxError;
  }): JsRunAuditRecord {
    const endedAtMs = Date.now();
    this.record.endedAt = new Date(endedAtMs).toISOString();
    this.record.durationMs = endedAtMs - options.startedAtMs;
    this.record.exitCode = options.exitCode;
    this.record.timedOut = options.timedOut;
    this.record.error = options.error;
    return this.snapshot();
  }

  snapshot(): JsRunAuditRecord {
    return structuredClone(this.record);
  }
}
