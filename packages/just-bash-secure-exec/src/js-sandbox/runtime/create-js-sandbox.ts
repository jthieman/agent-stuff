import type { Command, IFileSystem } from "just-bash";

import { execNodeCommand } from "./exec-node-command.ts";
import { runCode } from "./run-code.ts";
import { createNodeCommand } from "../command/node-command.ts";
import { MemoryJustBashFs } from "../fs/memory-just-bash-fs.ts";
import type {
  CreateJsSandboxOptions,
  ExecJsOptions,
  JsSandbox,
  RunJsOptions,
  RunJsResult,
} from "../types.ts";

export function createJsSandbox(options: CreateJsSandboxOptions = {}): JsSandbox {
  return new SecureExecJsSandbox(
    options.fs ?? new MemoryJustBashFs(),
    options.defaultCwd ?? "/workspace",
  );
}

class SecureExecJsSandbox implements JsSandbox {
  constructor(
    private readonly fs: IFileSystem,
    private readonly defaultCwd: string,
  ) {}

  async run<T = unknown>(code: string, options?: RunJsOptions): Promise<RunJsResult<T>> {
    return await runCode<T>({
      code,
      fs: this.fs,
      defaults: {
        cwd: this.defaultCwd,
        filename: "/__entry__.mjs",
        bindings: {},
      },
      options,
    });
  }

  async exec(args: string[], options?: ExecJsOptions) {
    return await execNodeCommand({
      args,
      fs: this.fs,
      defaults: {
        cwd: this.defaultCwd,
        bindings: {},
      },
      options,
    });
  }

  createNodeCommand(): Command {
    return createNodeCommand(this);
  }

  async dispose(): Promise<void> {
    // Runtime sessions are created and disposed per run; this object only owns defaults.
    await Promise.resolve();
  }
}
