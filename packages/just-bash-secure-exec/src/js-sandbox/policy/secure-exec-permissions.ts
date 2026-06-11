import type { Permissions } from "secure-exec";

import type { AuditRecorder } from "../audit/audit-recorder.ts";
import type { RuntimePolicy } from "../types.ts";
import { resolveSandboxPath } from "../fs/path-policy.ts";

export function createSecureExecPermissions(options: {
  policy: RuntimePolicy;
  cwd: string;
  audit: AuditRecorder;
  internalPaths: string[];
  allowNetwork: boolean;
}): Permissions {
  const internalPaths = new Set(options.internalPaths);

  return {
    fs(request) {
      if (internalPaths.has(request.path)) {
        return { allow: true };
      }

      if (options.policy.fs === false) {
        options.audit.deniedFsOp(request.op, request.path, "filesystem disabled");
        return { allow: false, reason: "filesystem disabled" };
      }

      try {
        resolveSandboxPath(request.path, {
          cwd: options.cwd,
          roots: options.policy.fs.roots,
          allowRelative: true,
        });
      } catch {
        options.audit.deniedFsOp(request.op, request.path, "path outside allowed roots");
        return { allow: false, reason: "path outside allowed roots" };
      }

      if (isReadOp(request.op)) {
        if (options.policy.fs.read) {
          return { allow: true };
        }

        options.audit.deniedFsOp(request.op, request.path, "read disabled");
        return { allow: false, reason: "read disabled" };
      }

      if (request.op === "mkdir" || request.op === "createDir") {
        if (options.policy.fs.mkdir) {
          return { allow: true };
        }
        options.audit.deniedFsOp(request.op, request.path, "mkdir disabled");
        return { allow: false, reason: "mkdir disabled" };
      }

      if (request.op === "rm") {
        if (options.policy.fs.delete) {
          return { allow: true };
        }
        options.audit.deniedFsOp(request.op, request.path, "delete disabled");
        return { allow: false, reason: "delete disabled" };
      }

      if (request.op === "rename") {
        if (!options.policy.fs.write) {
          options.audit.deniedFsOp(request.op, request.path, "write disabled");
          return { allow: false, reason: "write disabled" };
        }

        if (!options.policy.fs.delete) {
          options.audit.deniedFsOp(request.op, request.path, "delete disabled");
          return { allow: false, reason: "delete disabled" };
        }

        return { allow: true };
      }

      if (options.policy.fs.write) {
        return { allow: true };
      }

      options.audit.deniedFsOp(request.op, request.path, "write disabled");
      return { allow: false, reason: "write disabled" };
    },

    network(request) {
      if (options.allowNetwork && (request.op === "fetch" || request.op === "http")) {
        return { allow: true };
      }

      return {
        allow: false,
        reason: `network ${request.op} disabled`,
      };
    },

    childProcess(request) {
      return {
        allow: false,
        reason: `child process disabled: ${request.command}`,
      };
    },

    env(request) {
      if (options.policy.env === false) {
        return { allow: false, reason: "environment access disabled" };
      }

      if (request.op === "read" && Object.hasOwn(options.policy.env, request.key)) {
        return { allow: true };
      }

      return { allow: false, reason: "environment key not allowed" };
    },
  };
}

function isReadOp(op: string): boolean {
  return op === "read" || op === "readdir" || op === "stat" || op === "exists" || op === "readlink";
}
