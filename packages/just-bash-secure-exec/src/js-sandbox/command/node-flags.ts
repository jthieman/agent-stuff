import { JsSandboxRuntimeError } from "../runtime/normalize-error.ts";
import type { ParsedNodeCommand } from "../types.ts";

export function parseNodeCommand(args: string[]): ParsedNodeCommand {
  let index = 0;

  while (index < args.length) {
    const arg = args[index];

    if (arg === "--help") {
      return { kind: "help" };
    }

    if (arg === "--version" || arg === "-v") {
      return { kind: "version" };
    }

    if (arg === "--input-type=module") {
      index += 1;
      continue;
    }

    if (arg === "--input-type") {
      const value = args[index + 1];
      if (value === undefined) {
        throw missingArgument(arg);
      }

      if (value !== "module") {
        throw unsupportedFlag(arg);
      }

      index += 2;
      continue;
    }

    if (arg === "-e" || arg === "--eval") {
      const code = args[index + 1];
      if (code === undefined) {
        throw missingArgument(arg);
      }

      return {
        kind: "eval",
        code,
        argv: args.slice(index + 2),
      };
    }

    if (arg.startsWith("--eval=")) {
      return {
        kind: "eval",
        code: arg.slice("--eval=".length),
        argv: args.slice(index + 1),
      };
    }

    if (arg === "--") {
      const path = args[index + 1];
      if (path === undefined) {
        throw missingArgument("script path after --");
      }

      return {
        kind: "script",
        path,
        argv: args.slice(index + 2),
      };
    }

    if (arg.startsWith("-")) {
      throw unsupportedFlag(arg);
    }

    return {
      kind: "script",
      path: arg,
      argv: args.slice(index + 1),
    };
  }

  throw unsupportedFlag("interactive mode");
}

function unsupportedFlag(flag: string): JsSandboxRuntimeError {
  return new JsSandboxRuntimeError("UNSUPPORTED_NODE_FLAG", `Unsupported node flag: ${flag}`);
}

function missingArgument(argument: string): JsSandboxRuntimeError {
  return new JsSandboxRuntimeError("MISSING_NODE_ARGUMENT", `Missing argument for ${argument}`);
}

export function nodeHelpText(): string {
  return [
    "secure-exec node",
    "",
    "Supported forms:",
    "  node -e <code>",
    "  node --eval <code>",
    "  node --input-type=module -e <code>",
    "  node <script.mjs> [...args]",
    "  node --help",
    "  node --version",
    "",
  ].join("\n");
}
