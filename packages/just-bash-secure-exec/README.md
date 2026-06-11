# just-bash-secure-exec

Secure Exec-backed `node` support for [`just-bash`](https://www.npmjs.com/package/just-bash).

This package adapts `secure-exec` into the `just-bash` sandbox model:

- `just-bash` owns the shell, filesystem, environment, and network policy.
- `secure-exec` owns JavaScript execution.
- `just-bash-secure-exec` connects the two so sandboxed Bash scripts can run a locked-down Node-like command.

## Install

```bash
pnpm add just-bash-secure-exec just-bash secure-exec
```

## Quick Start

```ts
import { Bash } from "just-bash";
import { MemoryJustBashFs, createJsSandbox } from "just-bash-secure-exec";

const fs = new MemoryJustBashFs({
  "/workspace/main.mjs": `
    import fs from "node:fs/promises";

    const message = await fs.readFile("/workspace/input.txt", "utf8");
    console.log(message.toUpperCase());
  `,
  "/workspace/input.txt": "hello from the sandbox",
});

const sandbox = createJsSandbox({ fs });
const bash = new Bash({
  fs,
  cwd: "/workspace",
  customCommands: [sandbox.createNodeCommand()],
});

const result = await bash.exec("node main.mjs");

console.log(result.stdout); // HELLO FROM THE SANDBOX
```

## Bash Environment Behavior

The `node` command receives the `just-bash` command environment, not the host OS environment. Only variables exported in the `Bash` shell are forwarded to sandboxed `process.env`; unexported shell locals stay hidden.

With `just-bash` 3.0.1, custom commands currently fail after non-exported shell assignments because the upstream defense-in-depth layer reports a security violation. This is tracked upstream at [vercel-labs/just-bash#273](https://github.com/vercel-labs/just-bash/issues/273). These forms are affected:

```bash
SECRET=s node script.mjs
SECRET=s
node script.mjs
```

Use an exported variable when invoking through `Bash`:

```bash
export SECRET=s
node script.mjs
```

For programmatic calls, pass the environment explicitly through `sandbox.exec()` or `sandbox.run()` options.

## Runtime Lifecycle

Each `run()` or `exec()` call creates a fresh Secure Exec Node runtime session and disposes it when the call completes. The underlying Secure Exec runtime process may be reused by Secure Exec itself. `sandbox.dispose()` is intentionally a no-op kept for lifecycle symmetry; the `JsSandbox` object owns only the configured filesystem reference and default cwd.

## Public API

The runtime value exports are intentionally small: `createJsSandbox()` for the adapter and `MemoryJustBashFs` for examples/tests or simple in-memory sessions. Package-specific TypeScript option, result, audit, policy, and binding types are exported from the package root; parser, audit-recorder, path-policy, and Secure Exec plumbing helpers are internal.

## Per-Session Sandboxes

For agent or user sessions, create a separate `just-bash` filesystem and sandbox per session. Session lifecycle, quotas, persistence, and cleanup belong to the host application.

```ts
import { Bash, type NetworkConfig } from "just-bash";
import { MemoryJustBashFs, createJsSandbox } from "just-bash-secure-exec";

export function createSessionShell(
  sessionFiles: Record<string, string | Uint8Array>,
  sessionNetworkPolicy: NetworkConfig,
) {
  const fs = new MemoryJustBashFs(sessionFiles);
  const sandbox = createJsSandbox({ fs });

  return new Bash({
    fs,
    cwd: "/workspace",
    customCommands: [sandbox.createNodeCommand()],
    network: sessionNetworkPolicy,
  });
}
```

## Programmatic JavaScript Runs

Use `createJsSandbox()` directly when you want to run code without going through Bash command parsing.

```ts
import { createJsSandbox } from "just-bash-secure-exec";

const sandbox = createJsSandbox();

const result = await sandbox.run(
  `
    export default function main({ cwd, argv, stdin }) {
      return { cwd, argv, stdin };
    }
  `,
  {
    argv: ["one", "two"],
    stdin: "input",
  },
);

if (!result.ok) {
  throw new Error(result.error?.message ?? "sandbox failed");
}

console.log(result.value);
```

## Network Policy

Network policy stays in `just-bash`. This package does not define a second allow-list.

When you register `sandbox.createNodeCommand()` with a `Bash` instance, the command receives `CommandContext.fetch` from `just-bash` and passes it into Secure Exec. That means sandboxed `fetch()` and `node:http` use the same `NetworkConfig` that `curl` or other network-aware Bash commands use.

```ts
import { Bash } from "just-bash";
import { MemoryJustBashFs, createJsSandbox } from "just-bash-secure-exec";

const fs = new MemoryJustBashFs({
  "/workspace/request.mjs": `
    const response = await fetch("https://api.example.com/v1/status");
    console.log(await response.text());
  `,
});

const sandbox = createJsSandbox({ fs });
const bash = new Bash({
  fs,
  cwd: "/workspace",
  customCommands: [sandbox.createNodeCommand()],
  network: {
    allowedUrlPrefixes: ["https://api.example.com/v1/"],
    allowedMethods: ["GET"],
  },
});

await bash.exec("node request.mjs");
```

Network behavior:

- No `SecureFetch` means network access is denied.
- `fetch()` and `node:http`/`node:https` route through the provided `SecureFetch`.
- URL, redirect, method, timeout, response-size, and private-range rules are enforced by `just-bash`.
- Direct DNS lookup remains denied, even when `SecureFetch` is provided.

## Node Compatibility Notes

The `node` command is a focused Secure Exec adapter, not a full Node.js distribution.

- `node --version` and `process.version` both report `v0.0.0-secure-exec`, a sandbox runtime sentinel rather than the host Node.js version.
- `node:http` and `node:https` are implemented through the provided `SecureFetch`; redirect handling follows the `just-bash` network policy instead of Node's raw socket client behavior.
- Unsupported Node CLI flags fail closed with a nonzero exit code.

## Filesystem Policy

The sandbox filesystem is backed by a `just-bash` filesystem. JavaScript filesystem calls go through this path:

```text
sandbox JS
  -> node:fs / node:fs/promises
  -> secure-exec virtual filesystem
  -> just-bash-secure-exec path and capability policy
  -> just-bash filesystem
```

Default filesystem policy:

```ts
{
  roots: ["/workspace", "/tmp"],
  read: true,
  write: true,
  mkdir: true,
  delete: false,
}
```

Use absolute sandbox paths for JavaScript filesystem calls, or build paths from the `cwd` value passed into your `main()` function. Secure Exec's current Node fs bridge does not make relative fs paths follow `process.chdir()`, so this adapter treats `process.chdir()` as unsupported for filesystem path resolution. All filesystem operations must remain inside configured roots. The VFS adapter enforces roots and capability flags directly, in addition to Secure Exec's permission wrapper.

## Runtime Policy

Policy can be overridden per `run()` or `exec()` call:

```ts
await sandbox.run(
  `
    import fs from "node:fs/promises";
    await fs.writeFile("/workspace/out.txt", "nope");
  `,
  {
    policy: {
      fs: {
        roots: ["/workspace"],
        read: true,
        write: false,
        mkdir: false,
        delete: false,
      },
      env: false,
      wallClockLimitMs: 1_000,
      outputLimitBytes: 100_000,
      maxFileBytes: 10_485_760,
      maxBridgeCalls: 1_024,
    },
  },
);
```

Supported policy fields:

```ts
interface RuntimePolicy {
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
```

`maxBridgeCalls` caps total Secure Exec bridge operations, including filesystem, timer, network, and binding traffic. `maxBindingCalls` only caps calls into host bindings exposed under `SecureExec.bindings`.

`outputLimitBytes` caps captured stdout and stderr bytes, preserving UTF-8 character boundaries. Reaching the cap truncates captured output and sets `audit.output.truncated`. It is not an execution kill switch: Secure Exec may continue running after the stdio hook clips output, and `wallClockLimitMs` / `cpuLimitMs` remain the execution bounds. If the code finishes successfully after truncation, the result fails with `OUTPUT_LIMIT`; if it later times out or fails for another reason, that later runtime error remains primary while the audit records the output truncation.

## Bindings

Bindings are exposed directly under `SecureExec.bindings`.

```ts
const result = await sandbox.run(
  `
    const value = await SecureExec.bindings.tools.double(21);
    export default value;
  `,
  {
    bindings: {
      tools: {
        double: (value: unknown) => Number(value) * 2,
      },
    },
  },
);
```

Binding calls are subject to call count, call depth, timeout, and serializability limits. Treat bindings as trusted host code.

## Security Model

This package is an adapter between `just-bash` and `secure-exec`; it is not a complete multitenant isolation system by itself. JavaScript execution is delegated to `secure-exec`, filesystem access is mediated through the configured `just-bash` filesystem, and network access is mediated through the `just-bash` network policy passed to the `Bash` instance.

Per-user or per-agent filesystem creation, quotas, persistence, cleanup, and outer process or container isolation are application concerns. For hostile multitenant workloads, run each tenant or session with external process/container isolation in addition to this package's in-process sandbox boundaries.

`memoryLimitMb` is enforced by Secure Exec's runtime process. Under Secure Exec's default shared-process topology, an OOM or runtime crash in one session can abort other concurrent sessions using the same runtime process; the host process survives and the runtime respawns on the next call. Crash isolation between hostile tenants requires separate host processes or containers. See Secure Exec's process-isolation notes: https://secureexec.dev/docs/process-isolation.

The runtime is deny-by-default for host capabilities:

- Filesystem access is constrained to configured roots.
- Host environment variables are hidden unless explicitly provided.
- Child process creation is denied.
- Network access is denied unless a `SecureFetch` is provided by `just-bash`.
- Direct DNS lookup is denied.
- Symlink and hard-link creation are denied.
- Output, wall-clock time, CPU time, memory, file size, and binding calls are bounded.

The trusted computing base includes `just-bash`, `secure-exec`, this adapter, and any host bindings or `SecureFetch` implementation you provide.

## Audit Results

Every run returns an audit record with filesystem operations, denied filesystem operations, JS module files read by the runtime, binding calls, output byte counts, timing, and normalized error details.

```ts
const result = await sandbox.run("export default 42");

console.log(result.audit.fs.reads);
console.log(result.audit.fs.denied);
console.log(result.audit.modules.loaded);
```

`audit.modules.loaded` is deduped and records JavaScript module files read through the sandbox filesystem. Secure Exec does not currently expose a separate denied-module hook to this adapter, so denied imports surface through the normalized run error and filesystem denial audit instead.

## Development

From the repository root:

```bash
vp install
vp check
vp test
vp run -r build
```

The security-sensitive tests cover filesystem traversal, capability denial, symlink and hard-link denial, default network denial, DNS denial, `node:http` routing, and real `just-bash` `NetworkConfig` enforcement against a local HTTP server.
