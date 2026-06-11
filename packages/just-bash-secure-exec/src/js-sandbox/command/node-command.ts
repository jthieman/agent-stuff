import { decodeBytesToUtf8, defineCommand } from "just-bash";
import type { Command } from "just-bash";

import type { ExecJsOptions, ProcessResult } from "../types.ts";

export interface NodeCommandSandbox {
  exec(args: string[], options?: ExecJsOptions): Promise<ProcessResult>;
}

export function createNodeCommand(jsSandbox: NodeCommandSandbox): Command {
  return defineCommand("node", async (args, context) => {
    const result = await jsSandbox.exec(args, {
      cwd: context.cwd,
      stdin: context.stdin ? decodeBytesToUtf8(context.stdin) : "",
      env: context.exportedEnv ?? {},
      fetch: context.fetch,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  });
}
