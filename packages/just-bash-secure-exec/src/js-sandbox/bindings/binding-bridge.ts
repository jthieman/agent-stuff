import { AsyncLocalStorage } from "node:async_hooks";

import type { AuditRecorder } from "../audit/audit-recorder.ts";
import { assertJsonSerializable } from "../runtime/serialization.ts";
import type { RuntimePolicy, SandboxBindingFunction, SandboxBindingTree } from "../types.ts";

const bindingCallDepth = new AsyncLocalStorage<number>();

export function createSandboxBindings(options: {
  bindings?: SandboxBindingTree;
  policy: RuntimePolicy;
  audit: AuditRecorder;
}): SandboxBindingTree {
  const source = options.bindings ?? {};
  let callCount = 0;

  return wrapBindingTree(source, []);

  function wrapBindingTree(node: SandboxBindingTree, path: string[]): SandboxBindingTree {
    const wrapped: SandboxBindingTree = {};

    for (const [key, value] of Object.entries(node)) {
      const childPath = [...path, key];

      if (typeof value === "function") {
        wrapped[key] = wrapBindingFunction(childPath.join("."), value);
        continue;
      }

      if (isBindingTree(value)) {
        wrapped[key] = wrapBindingTree(value, childPath);
        continue;
      }

      throw new TypeError(`Invalid binding at ${childPath.join(".")}`);
    }

    return wrapped;
  }

  function wrapBindingFunction(
    name: string,
    binding: SandboxBindingFunction,
  ): SandboxBindingFunction {
    return async (...args: unknown[]) => {
      const startedAt = Date.now();
      const callDepth = bindingCallDepth.getStore() ?? 0;
      let callStarted = false;

      try {
        if (callCount >= options.policy.maxBindingCalls) {
          options.audit.bindingDenied(name, "max binding call count exceeded");
          throw new Error("Maximum binding call count exceeded");
        }

        if (callDepth >= options.policy.maxBindingCallDepth) {
          options.audit.bindingDenied(name, "max binding call depth exceeded");
          throw new Error("Maximum binding call depth exceeded");
        }

        callCount += 1;
        callStarted = true;

        let result: unknown;
        try {
          result = await bindingCallDepth.run(callDepth + 1, () =>
            withBindingTimeout(Promise.resolve(binding(...args)), options.policy.wallClockLimitMs),
          );
        } catch (error) {
          if (error instanceof Error && error.message === "Binding call timed out") {
            options.audit.bindingDenied(name, "binding call timed out");
          }

          throw error;
        }

        let serializable: unknown;
        try {
          serializable = assertJsonSerializable(result);
        } catch (error) {
          if (error instanceof Error) {
            options.audit.bindingDenied(name, error.message);
          }

          throw error;
        }

        options.audit.bindingCall(name, Date.now() - startedAt, true);
        return serializable;
      } catch (error) {
        if (callStarted) {
          options.audit.bindingCall(name, Date.now() - startedAt, false);
        }

        throw error;
      }
    };
  }
}

function isBindingTree(value: unknown): value is SandboxBindingTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withBindingTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Binding call timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
