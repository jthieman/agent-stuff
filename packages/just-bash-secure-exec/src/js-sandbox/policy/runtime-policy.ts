import type { FsPolicy, RuntimePolicy } from "../types.ts";
import { JsSandboxRuntimeError } from "../runtime/normalize-error.ts";

export const defaultFsPolicy: FsPolicy = {
  roots: ["/workspace", "/tmp"],
  read: true,
  write: true,
  mkdir: true,
  delete: false,
};

export const defaultRuntimePolicy: RuntimePolicy = {
  fs: defaultFsPolicy,
  env: false,
  cpuLimitMs: 5_000,
  wallClockLimitMs: 10_000,
  memoryLimitMb: 64,
  outputLimitBytes: 1_000_000,
  maxFileBytes: 10_485_760,
  maxBridgeCalls: 1_024,
  maxBindingCalls: 100,
  maxBindingCallDepth: 1,
};

export function resolveRuntimePolicy(override: Partial<RuntimePolicy> = {}): RuntimePolicy {
  const fs: RuntimePolicy["fs"] =
    override.fs === undefined
      ? { ...defaultFsPolicy }
      : override.fs === false
        ? false
        : {
            ...defaultFsPolicy,
            ...override.fs,
          };

  const policy: RuntimePolicy = {
    ...defaultRuntimePolicy,
    ...override,
    fs,
  };

  validateRuntimePolicy(policy);
  return policy;
}

function validateRuntimePolicy(policy: RuntimePolicy): void {
  assertPositiveFiniteNumber(policy.cpuLimitMs, "cpuLimitMs");
  assertPositiveFiniteNumber(policy.wallClockLimitMs, "wallClockLimitMs");
  assertPositiveFiniteNumber(policy.memoryLimitMb, "memoryLimitMb");
  assertPositiveFiniteNumber(policy.outputLimitBytes, "outputLimitBytes");
  assertPositiveFiniteNumber(policy.maxFileBytes, "maxFileBytes");
  assertPositiveFiniteNumber(policy.maxBridgeCalls, "maxBridgeCalls");
  assertPositiveFiniteNumber(policy.maxBindingCalls, "maxBindingCalls");
  assertPositiveFiniteNumber(policy.maxBindingCallDepth, "maxBindingCallDepth");
}

function assertPositiveFiniteNumber(value: number, field: string): void {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return;
  }

  throw new JsSandboxRuntimeError(
    "INVALID_RUNTIME_POLICY",
    `${field} must be a positive finite number`,
  );
}
