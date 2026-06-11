import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Bash, EMPTY_BYTES } from "just-bash";
import type { CommandContext, SecureFetch } from "just-bash";
import { describe, expect, test } from "vite-plus/test";

import * as publicApi from "../src/index.ts";
import { MemoryJustBashFs, createJsSandbox } from "../src/index.ts";
import { AuditRecorder, createAuditRecord } from "../src/js-sandbox/audit/audit-recorder.ts";
import { parseNodeCommand } from "../src/js-sandbox/command/node-flags.ts";
import { resolveSandboxPath } from "../src/js-sandbox/fs/path-policy.ts";
import { SecureExecJustBashFileSystem } from "../src/js-sandbox/fs/secure-exec-vfs.ts";
import { resolveRuntimePolicy } from "../src/js-sandbox/policy/runtime-policy.ts";
import { createSecureExecPermissions } from "../src/js-sandbox/policy/secure-exec-permissions.ts";

describe("public API", () => {
  test("keeps runtime exports narrow", () => {
    expect(Object.keys(publicApi).sort()).toEqual(["MemoryJustBashFs", "createJsSandbox"]);
  });
});

describe("path policy", () => {
  test("accepts paths inside configured roots", () => {
    expect(
      resolveSandboxPath("/workspace/package.json", {
        cwd: "/workspace",
        roots: ["/workspace", "/tmp"],
        allowRelative: true,
      }).absolute,
    ).toBe("/workspace/package.json");
    expect(
      resolveSandboxPath("/workspace/src/../package.json", {
        cwd: "/workspace",
        roots: ["/workspace", "/tmp"],
        allowRelative: true,
      }).absolute,
    ).toBe("/workspace/package.json");
    expect(
      resolveSandboxPath("package.json", {
        cwd: "/workspace",
        roots: ["/workspace", "/tmp"],
        allowRelative: true,
      }).absolute,
    ).toBe("/workspace/package.json");
    expect(
      resolveSandboxPath("../package.json", {
        cwd: "/workspace/src",
        roots: ["/workspace", "/tmp"],
        allowRelative: true,
      }).absolute,
    ).toBe("/workspace/package.json");
  });

  test("rejects paths outside configured roots", () => {
    const options = {
      cwd: "/workspace/src",
      roots: ["/workspace", "/tmp"],
      allowRelative: true,
    };

    for (const path of [
      "/etc/passwd",
      "/workspace/../../etc/passwd",
      "../../etc/passwd",
      "/tmp2/foo",
      "/workspaceevil/foo",
    ]) {
      expect(() => resolveSandboxPath(path, options)).toThrow();
    }
  });
});

describe("node command parser", () => {
  test("parses supported forms", () => {
    expect(parseNodeCommand(["-e", "console.log(1)", "a"])).toEqual({
      kind: "eval",
      code: "console.log(1)",
      argv: ["a"],
    });
    expect(parseNodeCommand(["--eval", "console.log(1)"]).kind).toBe("eval");
    expect(parseNodeCommand(["--input-type=module", "-e", "export default 1"])).toEqual({
      kind: "eval",
      code: "export default 1",
      argv: [],
    });
    expect(parseNodeCommand(["script.mjs", "arg1", "arg2"])).toEqual({
      kind: "script",
      path: "script.mjs",
      argv: ["arg1", "arg2"],
    });
    expect(parseNodeCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseNodeCommand(["--version"])).toEqual({ kind: "version" });
  });

  test("rejects unsupported flags", () => {
    for (const args of [
      ["--inspect"],
      ["--require", "x"],
      ["-r", "x"],
      ["--loader", "./x.mjs"],
      ["--input-type=script", "-e", "console.log(1)"],
      ["--unknown"],
    ]) {
      expect(() => parseNodeCommand(args)).toThrow();
    }
  });

  test("reports missing node flag arguments clearly", () => {
    expect(() => parseNodeCommand(["-e"])).toThrow("Missing argument for -e");
    expect(() => parseNodeCommand(["--eval"])).toThrow("Missing argument for --eval");
    expect(() => parseNodeCommand(["--input-type"])).toThrow("Missing argument for --input-type");
    expect(() => parseNodeCommand(["--"])).toThrow("Missing argument for script path after --");
  });
});

describe("runtime policy", () => {
  test("rejects non-positive and non-finite numeric limits", () => {
    const invalidPolicies: Array<[string, Record<string, number>]> = [
      ["cpuLimitMs", { cpuLimitMs: 0 }],
      ["wallClockLimitMs", { wallClockLimitMs: -1 }],
      ["memoryLimitMb", { memoryLimitMb: Number.NaN }],
      ["outputLimitBytes", { outputLimitBytes: 0 }],
      ["maxFileBytes", { maxFileBytes: Number.POSITIVE_INFINITY }],
      ["maxBridgeCalls", { maxBridgeCalls: 0 }],
      ["maxBindingCalls", { maxBindingCalls: 0 }],
      ["maxBindingCallDepth", { maxBindingCallDepth: 0 }],
    ];

    for (const [field, policy] of invalidPolicies) {
      expect(() => {
        resolveRuntimePolicy(policy as Partial<ReturnType<typeof resolveRuntimePolicy>>);
      }, field).toThrow(`${field} must be a positive finite number`);
    }
  });
});

describe("run semantics", () => {
  test("returns default export values and calls default export functions", async () => {
    const sandbox = createJsSandbox();

    await expectValue(await sandbox.run("export default 42"), 42);
    await expectValue(
      await sandbox.run(
        `
        export default function main({ cwd, argv, stdin }) {
          return { cwd, argv, stdin };
        }
      `,
        {
          argv: ["a"],
          stdin: "input",
        },
      ),
      {
        cwd: "/workspace",
        argv: ["a"],
        stdin: "input",
      },
    );
  });

  test("keeps dispose as an intentional no-op", async () => {
    const sandbox = createJsSandbox();

    await sandbox.dispose();
    await expectValue(await sandbox.run("export default 42"), 42);
  });

  test("uses the sandbox filesystem through node:fs/promises", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/package.json": JSON.stringify({ name: "demo" }),
    });
    const sandbox = createJsSandbox({ fs });

    const result = await sandbox.run(`
      import fs from "node:fs/promises";

      export default async function main({ cwd }) {
        const pkg = JSON.parse(await fs.readFile(cwd + "/package.json", "utf8"));
        await fs.writeFile("/workspace/out.txt", pkg.name);
        return pkg.name;
      }
    `);

    await expectValue(result, "demo");
    expect(await fs.readFile("/workspace/out.txt", "utf8")).toBe("demo");
    expect(result.audit.fs.reads).toContain("/workspace/package.json");
    expect(result.audit.fs.writes).toContain("/workspace/out.txt");
  });

  test("documents relative filesystem path behavior after process.chdir", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/file.txt": "initial",
      "/workspace/dir/file.txt": "changed",
    });
    const sandbox = createJsSandbox({ fs });

    const result = await sandbox.run(`
      import fs from "node:fs/promises";

      process.chdir("/workspace/dir");
      export default {
        cwd: process.cwd(),
        text: await fs.readFile("file.txt", "utf8"),
      };
    `);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/outside allowed roots/i);
    expect(result.audit.fs.denied).toContainEqual({
      op: "read",
      path: "/file.txt",
      reason: "path outside allowed roots",
    });
  });

  test("loads relative modules from the sandbox filesystem", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/lib.mjs": "export const value = 41;",
      "/workspace/main.mjs": `
        import { value } from "./lib.mjs";
        export default value + 1;
      `,
    });
    const sandbox = createJsSandbox({ fs });
    const result = await sandbox.exec(["main.mjs"]);

    expect(result.exitCode).toBe(0);
    expect(result.audit.modules.loaded).toContain("/workspace/lib.mjs");
    expect(result.audit.modules.loaded).toContain("/workspace/main.mjs");
    expect(new Set(result.audit.modules.loaded).size).toBe(result.audit.modules.loaded.length);
    expect(Object.hasOwn(result.audit.modules, "denied")).toBe(false);
  });

  test("captures stdout and stderr", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(`
      console.log("hello");
      console.error("bad");
      export default "ok";
    `);

    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("bad\n");
    await expectValue(result, "ok");
  });

  test("returns useful syntax, runtime, non-error, and serialization errors", async () => {
    const sandbox = createJsSandbox();

    const syntax = await sandbox.run("export default ;");
    expect(syntax.ok).toBe(false);
    expect(syntax.error?.message).toMatch(/syntax|unexpected|parse/i);

    const runtime = await sandbox.run("throw new Error('boom')");
    expect(runtime.ok).toBe(false);
    expect(runtime.error?.message).toContain("boom");

    const withCause = await sandbox.run("throw new Error('outer', { cause: new Error('inner') })");
    expect(withCause.ok).toBe(false);
    expect(withCause.error?.message).toBe("outer");
    expect(Object.hasOwn(withCause.error ?? {}, "stack")).toBe(false);
    expect(Object.hasOwn(withCause.error ?? {}, "cause")).toBe(false);
    expect(Object.hasOwn(withCause.audit.error ?? {}, "stack")).toBe(false);
    expect(Object.hasOwn(withCause.audit.error ?? {}, "cause")).toBe(false);

    const nonError = await sandbox.run("throw 'boom'");
    expect(nonError.ok).toBe(false);
    expect(nonError.error?.message).toBeTruthy();

    const serialization = await sandbox.run(`
      export default function main() {
        return () => 1;
      }
    `);
    expect(serialization.ok).toBe(false);
    expect(serialization.error?.message).toMatch(/serializ/i);
  });
});

describe("exec semantics and security denials", () => {
  test("executes node -e and script files", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/script.mjs": "console.log(process.argv.join('|'));",
    });
    const sandbox = createJsSandbox({ fs });

    expect((await sandbox.exec(["-e", "console.log(1 + 1)"])).stdout).toBe("2\n");
    expect((await sandbox.exec(["script.mjs", "x"])).stdout).toBe("node|/workspace/script.mjs|x\n");

    const version = await sandbox.exec(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toBe("v0.0.0-secure-exec\n");
    expect((await sandbox.exec(["-e", "console.log(process.version)"])).stdout).toBe(
      version.stdout,
    );
  });

  test("honors process.exitCode without exiting the parent", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.exec(["-e", "process.exitCode = 7; console.log('done')"]);

    expect(result.stdout).toBe("done\n");
    expect(result.exitCode).toBe(7);
    expect(result.audit.exitCode).toBe(7);
  });

  test("returns a failed process result when script paths are denied", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.exec(["/etc/passwd"]);

    expect(result.exitCode).toBe(1);
    expect(result.audit.error?.message).toContain("outside allowed roots");
    expect(result.stderr).toContain("outside allowed roots");
  });

  test("denies filesystem escape and child process access", async () => {
    const sandbox = createJsSandbox();

    const fsEscape = await sandbox.run(`
      import fs from "node:fs/promises";
      export default async function main() {
        return await fs.readFile("/etc/passwd", "utf8");
      }
    `);
    expect(fsEscape.ok).toBe(false);
    expect(fsEscape.error?.message).toMatch(/outside allowed roots|permission denied|EACCES/i);

    const childProcess = await sandbox.run(`
      import cp from "node:child_process";
      export default function main() {
        return cp.spawn("echo", ["hi"]);
      }
    `);
    expect(childProcess.ok).toBe(false);
    expect(childProcess.error?.message).toMatch(/child process|spawn|permission|EACCES|resource/i);
  });

  test("denies write escapes and write-disabled filesystem policy", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/inside.txt": "original",
    });
    const sandbox = createJsSandbox({ fs });

    const absoluteEscape = await sandbox.run(`
      import fs from "node:fs/promises";
      await fs.writeFile("/etc/pwned", "nope");
      export default true;
    `);
    expect(absoluteEscape.ok).toBe(false);
    expect(absoluteEscape.error?.message).toMatch(
      /outside allowed roots|permission denied|EACCES/i,
    );
    expect(await fs.exists("/etc/pwned")).toBe(false);

    const relativeEscape = await sandbox.run(`
      import fs from "node:fs/promises";
      await fs.writeFile("../etc/pwned", "nope");
      export default true;
    `);
    expect(relativeEscape.ok).toBe(false);
    expect(relativeEscape.error?.message).toMatch(
      /outside allowed roots|permission denied|EACCES/i,
    );
    expect(await fs.exists("/etc/pwned")).toBe(false);

    const writeDisabled = await sandbox.run(
      `
        import fs from "node:fs/promises";
        await fs.writeFile("/workspace/inside.txt", "changed");
        export default true;
      `,
      {
        policy: {
          fs: fsPolicy({ write: false }),
        },
      },
    );
    expect(writeDisabled.ok).toBe(false);
    expect(writeDisabled.error?.message).toMatch(/write disabled|permission denied|EACCES/i);
    expect(await fs.readFile("/workspace/inside.txt", "utf8")).toBe("original");
  });

  test("enforces mkdir, delete, and filesystem-disabled policy", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/keep.txt": "keep",
      "/workspace/readable.txt": "readable",
    });
    const sandbox = createJsSandbox({ fs });

    const mkdirDisabled = await sandbox.run(
      `
        import fs from "node:fs/promises";
        await fs.mkdir("/workspace/new-dir");
        export default true;
      `,
      {
        policy: {
          fs: fsPolicy({ mkdir: false }),
        },
      },
    );
    expect(mkdirDisabled.audit.fs.denied).toEqual(
      expect.arrayContaining([
        {
          op: "createDir",
          path: "/workspace/new-dir",
          reason: "mkdir disabled",
        },
      ]),
    );
    expect(await fs.exists("/workspace/new-dir")).toBe(false);

    const deleteDefault = await sandbox.run(`
      import fs from "node:fs/promises";
      await fs.unlink("/workspace/keep.txt");
      export default true;
    `);
    expect(deleteDefault.ok).toBe(false);
    expect(deleteDefault.error?.message).toMatch(/delete disabled|permission denied|EACCES/i);
    expect(await fs.readFile("/workspace/keep.txt", "utf8")).toBe("keep");

    const fsDisabled = await sandbox.run(
      `
        import fs from "node:fs/promises";
        export default await fs.readFile("/workspace/readable.txt", "utf8");
      `,
      {
        policy: {
          fs: false,
        },
      },
    );
    expect(fsDisabled.ok).toBe(false);
    expect(fsDisabled.error?.message).toMatch(/filesystem disabled|permission denied|EACCES/i);
  });

  test("requires delete permission for rename", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/source.txt": "source",
      "/workspace/allowed-source.txt": "allowed",
    });
    const sandbox = createJsSandbox({ fs });

    const renameDefault = await sandbox.run(`
      import fs from "node:fs/promises";
      await fs.rename("/workspace/source.txt", "/workspace/renamed.txt");
      export default true;
    `);
    expect(renameDefault.ok).toBe(false);
    expect(renameDefault.error?.message).toMatch(/delete disabled|permission denied|EACCES/i);
    expect(await fs.readFile("/workspace/source.txt", "utf8")).toBe("source");
    expect(await fs.exists("/workspace/renamed.txt")).toBe(false);

    const renameAllowed = await sandbox.run(
      `
        import fs from "node:fs/promises";
        await fs.rename("/workspace/allowed-source.txt", "/workspace/allowed-renamed.txt");
        export default true;
      `,
      {
        policy: {
          fs: fsPolicy({ delete: true }),
        },
      },
    );
    await expectValue(renameAllowed, true);
    expect(await fs.exists("/workspace/allowed-source.txt")).toBe(false);
    expect(await fs.readFile("/workspace/allowed-renamed.txt", "utf8")).toBe("allowed");
    expect(renameAllowed.audit.fs.deletes).toContain("/workspace/allowed-source.txt");
    expect(renameAllowed.audit.fs.writes).toContain("/workspace/allowed-renamed.txt");
  });

  test("denies read operations when read is disabled even if write is enabled", () => {
    const policy = resolveRuntimePolicy({
      fs: fsPolicy({ read: false, write: true }),
    });
    const audit = createTestAudit(policy);
    const permissions = createSecureExecPermissions({
      policy,
      cwd: "/workspace",
      audit,
      internalPaths: [],
      allowNetwork: false,
    });

    expect(permissions.fs?.({ op: "read", path: "/workspace/file.txt" })).toEqual({
      allow: false,
      reason: "read disabled",
    });
    expect(audit.record.fs.denied).toContainEqual({
      op: "read",
      path: "/workspace/file.txt",
      reason: "read disabled",
    });
  });

  test("environment permissions only allow own policy keys", () => {
    const env = Object.create({ constructor: "blocked" }) as Record<string, string>;
    env.ALLOWED = "yes";
    const policy = resolveRuntimePolicy({ env });
    const audit = createTestAudit(policy);
    const permissions = createSecureExecPermissions({
      policy,
      cwd: "/workspace",
      audit,
      internalPaths: [],
      allowNetwork: false,
    });

    expect(permissions.env?.({ op: "read", key: "ALLOWED" })).toEqual({ allow: true });
    expect(permissions.env?.({ op: "read", key: "constructor" })).toEqual({
      allow: false,
      reason: "environment key not allowed",
    });
  });

  test("enforces max file bytes for read, write, truncate, and pwrite", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/big.txt": "abcde",
      "/workspace/out.txt": "ok",
    });
    const sandbox = createJsSandbox({ fs });
    const options = { policy: { maxFileBytes: 4 } };

    const readTooLarge = await sandbox.run(
      `
        import fs from "node:fs/promises";
        export default await fs.readFile("/workspace/big.txt", "utf8");
      `,
      options,
    );
    expect(readTooLarge.ok).toBe(false);
    expect(readTooLarge.error?.message).toMatch(/file size limit exceeded/i);
    expect(readTooLarge.audit.fs.reads).not.toContain("/workspace/big.txt");
    expect(readTooLarge.audit.fs.denied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "read",
          path: "/workspace/big.txt",
          reason: expect.stringMatching(/file size limit exceeded/i),
        }),
      ]),
    );

    const writeTooLarge = await sandbox.run(
      `
        import fs from "node:fs/promises";
        await fs.writeFile("/workspace/new.txt", "abcde");
        export default true;
      `,
      options,
    );
    expect(writeTooLarge.ok).toBe(false);
    expect(writeTooLarge.error?.message).toMatch(/file size limit exceeded/i);
    expect(await fs.exists("/workspace/new.txt")).toBe(false);

    const truncateTooLarge = await sandbox.run(
      `
        import fs from "node:fs";
        const fd = fs.openSync("/workspace/out.txt", "r+");
        fs.ftruncateSync(fd, 5);
        export default true;
      `,
      options,
    );
    expect(truncateTooLarge.ok).toBe(false);
    expect(truncateTooLarge.error?.message).toMatch(/file size limit exceeded/i);
    expect(await fs.readFile("/workspace/out.txt", "utf8")).toBe("ok");

    const pwriteTooLarge = await sandbox.run(
      `
        import fs from "node:fs";
        import { Buffer } from "node:buffer";
        const fd = fs.openSync("/workspace/out.txt", "r+");
        fs.writeSync(fd, Buffer.from("z"), 0, 1, 4);
        export default true;
      `,
      options,
    );
    expect(pwriteTooLarge.ok).toBe(false);
    expect(pwriteTooLarge.error?.message).toMatch(/file size limit exceeded/i);
    expect(await fs.readFile("/workspace/out.txt", "utf8")).toBe("ok");
  });

  test("allows safe truncate and pwrite operations under write-only policies", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/big.txt": "abcde",
      "/workspace/out.txt": "abcdef",
    });
    const sandbox = createJsSandbox({ fs });

    const shrinkOversized = await sandbox.run(
      `
        import fs from "node:fs";
        fs.truncateSync("/workspace/big.txt", 3);
        export default true;
      `,
      { policy: { maxFileBytes: 4 } },
    );
    await expectValue(shrinkOversized, true);
    expect(await fs.readFile("/workspace/big.txt", "utf8")).toBe("abc");
    expect(shrinkOversized.audit.fs.reads).not.toContain("/workspace/big.txt");
    expect(shrinkOversized.audit.fs.writes).toContain("/workspace/big.txt");

    const writeOnly = await sandbox.run(
      `
        import fs from "node:fs";

        fs.truncateSync("/workspace/out.txt", 3);
        export default true;
      `,
      {
        policy: {
          fs: fsPolicy({ read: false, write: true }),
        },
      },
    );
    await expectValue(writeOnly, true);
    expect(await fs.readFile("/workspace/out.txt", "utf8")).toBe("abc");
    expect(writeOnly.audit.fs.reads).not.toContain("/workspace/out.txt");
    expect(writeOnly.audit.fs.writes).toContain("/workspace/out.txt");

    const policy = resolveRuntimePolicy({
      fs: fsPolicy({ read: false, write: true }),
    });
    const audit = createTestAudit(policy);
    const vfs = new SecureExecJustBashFileSystem(fs, audit, "/workspace", policy);
    await vfs.pwrite("/workspace/out.txt", 1, new TextEncoder().encode("Z"));
    await vfs.pwrite("/workspace/new.bin", 2, new TextEncoder().encode("XY"));

    expect(await fs.readFile("/workspace/out.txt", "utf8")).toBe("aZc");
    expect(Array.from(await fs.readFileBuffer("/workspace/new.bin"))).toEqual([0, 0, 88, 89]);
    expect(audit.record.fs.reads).toEqual([]);
    expect(audit.record.fs.writes).toEqual(
      expect.arrayContaining(["/workspace/out.txt", "/workspace/new.bin"]),
    );
  });

  test("uses maxBridgeCalls for filesystem bridge volume independently of bindings", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 30 }, (_unused, index) => [
        `/workspace/file-${index}.txt`,
        String(index),
      ]),
    );
    const fs = new MemoryJustBashFs(files);
    const sandbox = createJsSandbox({ fs });
    const readerScript = `
      import fs from "node:fs/promises";

      let total = 0;
      for (let index = 0; index < 30; index += 1) {
        total += Number(await fs.readFile(\`/workspace/file-\${index}.txt\`, "utf8"));
      }

      export default total;
    `;

    const limitedBridge = await sandbox.run(readerScript, {
      policy: {
        maxBridgeCalls: 20,
        maxBindingCalls: 1_000,
      },
    });
    expect(limitedBridge.ok).toBe(false);
    expect(limitedBridge.error?.message).toMatch(/bridge calls|resource|budget/i);

    const lowBindingLimit = await sandbox.run(readerScript, {
      policy: {
        maxBridgeCalls: 200,
        maxBindingCalls: 1,
      },
    });
    await expectValue(lowBindingLimit, 435);
    expect(lowBindingLimit.audit.limits.maxBridgeCalls).toBe(200);
  });

  test("enforces sandbox memory limits", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(
      `
        const chunks = [];
        for (let index = 0; index < 2_000_000; index += 1) {
          chunks.push({ index, value: String(index).padStart(64, "0") });
        }
        export default chunks.length;
      `,
      {
        policy: {
          memoryLimitMb: 16,
          cpuLimitMs: 3_000,
          wallClockLimitMs: 3_000,
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(
      /memory|heap|resource|limit|terminated|runtime process killed/i,
    );
    expect(result.audit.limits.memoryLimitMb).toBe(16);
  });

  test("denies symlink and hardlink creation", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/file.txt": "content",
    });
    const sandbox = createJsSandbox({ fs });

    const symlink = await sandbox.run(`
      import fs from "node:fs/promises";
      await fs.symlink("/workspace/file.txt", "/workspace/link.txt");
      export default true;
    `);
    expect(symlink.ok).toBe(false);
    expect(symlink.error?.message).toMatch(/symlink|denied|permission/i);
    expect(symlink.audit.fs.denied).toEqual(
      expect.arrayContaining([
        {
          op: "symlink",
          path: "/workspace/link.txt",
          reason: "Symlinks are denied",
        },
      ]),
    );
    expect(await fs.exists("/workspace/link.txt")).toBe(false);

    const hardlink = await sandbox.run(`
      import fs from "node:fs/promises";
      await fs.link("/workspace/file.txt", "/workspace/hardlink.txt");
      export default true;
    `);
    expect(hardlink.ok).toBe(false);
    expect(hardlink.error?.message).toMatch(/hard links|link|denied|permission/i);
    expect(hardlink.audit.fs.denied).toEqual(
      expect.arrayContaining([
        {
          op: "link",
          path: "/workspace/hardlink.txt",
          reason: "Hard links are denied",
        },
      ]),
    );
    expect(await fs.exists("/workspace/hardlink.txt")).toBe(false);
  });

  test("audits denied readlink and chown operations", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/file.txt": "content",
    });
    const sandbox = createJsSandbox({ fs });

    const readlink = await sandbox.run(`
      import fs from "node:fs/promises";
      export default await fs.readlink("/workspace/file.txt");
    `);
    expect(readlink.ok).toBe(false);
    expect(readlink.error?.message).toMatch(/symlink|denied|permission/i);
    expect(readlink.audit.fs.denied).toEqual(
      expect.arrayContaining([
        {
          op: "readlink",
          path: "/workspace/file.txt",
          reason: "Symlinks are denied",
        },
      ]),
    );

    const chown = await sandbox.run(`
      import fs from "node:fs";
      fs.chownSync("/workspace/file.txt", 1, 1);
      export default true;
    `);
    expect(chown.ok).toBe(false);
    expect(chown.error?.message).toMatch(/chown|denied|permission/i);
    expect(chown.audit.fs.denied).toEqual(
      expect.arrayContaining([
        {
          op: "chown",
          path: "/workspace/file.txt",
          reason: "chown is denied",
        },
      ]),
    );
  });

  test("denies pre-existing symlinks that resolve outside configured roots", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/public.txt": "PUBLIC",
      "/secret-root/secret.txt": "TOPSECRET-OUT-OF-ROOT",
    });
    await fs.symlink("/workspace/public.txt", "/workspace/public-link.txt");
    await fs.symlink("/secret-root/secret.txt", "/workspace/secret-link.txt");
    const sandbox = createJsSandbox({ fs });

    await expectValue(
      await sandbox.run(`
        import fs from "node:fs/promises";
        export default await fs.readFile("/workspace/public-link.txt", "utf8");
      `),
      "PUBLIC",
    );

    const readEscape = await sandbox.run(`
      import fs from "node:fs/promises";
      export default await fs.readFile("/workspace/secret-link.txt", "utf8");
    `);
    expect(readEscape.ok).toBe(false);
    expect(readEscape.error?.message).toMatch(/outside allowed roots|symlink/i);
    expect(readEscape.audit.fs.denied).toEqual(
      expect.arrayContaining([
        {
          op: "read",
          path: "/workspace/secret-link.txt",
          reason: "path outside allowed roots after symlink resolution",
        },
      ]),
    );

    const statEscape = await sandbox.run(`
      import fs from "node:fs/promises";
      export default (await fs.stat("/workspace/secret-link.txt")).size;
    `);
    expect(statEscape.ok).toBe(false);
    expect(statEscape.error?.message).toMatch(/outside allowed roots|symlink/i);
  });

  test("readDirWithTypes reports symlinks without following targets", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/file.txt": "content",
    });
    await fs.symlink("/workspace/file.txt", "/workspace/link.txt");
    await fs.symlink("/workspace/missing.txt", "/workspace/dangling.txt");
    const policy = resolveRuntimePolicy();
    const audit = createTestAudit(policy);
    const vfs = new SecureExecJustBashFileSystem(fs, audit, "/workspace", policy);

    const entries = await vfs.readDirWithTypes("/workspace");

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          name: "file.txt",
          isDirectory: false,
          isSymbolicLink: false,
        },
        {
          name: "link.txt",
          isDirectory: false,
          isSymbolicLink: true,
        },
        {
          name: "dangling.txt",
          isDirectory: false,
          isSymbolicLink: true,
        },
      ]),
    );
  });

  test("audits metadata reads and writes", async () => {
    const fs = new MemoryJustBashFs({
      "/workspace/file.txt": "content",
    });
    const policy = resolveRuntimePolicy();
    const audit = createTestAudit(policy);
    const vfs = new SecureExecJustBashFileSystem(fs, audit, "/workspace", policy);

    expect(await vfs.exists("/workspace/file.txt")).toBe(true);
    await vfs.lstat("/workspace/file.txt");
    await vfs.realpath("/workspace/file.txt");
    await vfs.chmod("/workspace/file.txt", 0o600);
    await vfs.utimes("/workspace/file.txt", 1_000, 2_000);

    expect(audit.record.fs.reads.filter((path) => path === "/workspace/file.txt")).toHaveLength(3);
    expect(audit.record.fs.writes.filter((path) => path === "/workspace/file.txt")).toHaveLength(2);
  });

  test("denies default network and host env access", async () => {
    const sandbox = createJsSandbox();

    const network = await sandbox.run(`
      export default async function main() {
        return await fetch("https://example.com");
      }
    `);
    expect(network.ok).toBe(false);
    expect(network.error?.message).toMatch(/network|fetch|connect|permission|EACCES/i);

    await expectValue(await sandbox.run("export default process.env.PATH"), undefined);
  });

  test("denies node:http, node:https, and DNS when no network is provided", async () => {
    const sandbox = createJsSandbox();

    const http = await sandbox.run(`
      import http from "node:http";

      export default await new Promise((resolve, reject) => {
        const request = http.get("http://example.com", resolve);
        request.on("error", reject);
      });
    `);
    expect(http.ok).toBe(false);
    expect(http.error?.message).toMatch(/network|connect|permission|EACCES/i);

    const https = await sandbox.run(`
      import https from "node:https";

      export default await new Promise((resolve, reject) => {
        const request = https.get("https://example.com", resolve);
        request.on("error", reject);
      });
    `);
    expect(https.ok).toBe(false);
    expect(https.error?.message).toMatch(/network|connect|permission|EACCES/i);

    const dns = await sandbox.run(`
      import dns from "node:dns";

      export default await new Promise((resolve, reject) => {
        dns.lookup("example.com", (error, address) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(address);
        });
      });
    `);
    expect(dns.ok).toBe(false);
    expect(dns.error?.message).toMatch(/network|dns|connect|permission|EACCES/i);
  });

  test("uses provided just-bash secure fetch for sandbox network", async () => {
    const sandbox = createJsSandbox();
    const calls: Array<{ url: string; method: string }> = [];
    const fetch: SecureFetch = async (url, options) => {
      calls.push({ url, method: options?.method ?? "GET" });
      if (url !== "https://allowed.test/data") {
        throw new Error(`Network access denied by just-bash: ${url}`);
      }

      return textFetchResult(url, `method=${options?.method ?? "GET"}`);
    };

    const result = await sandbox.run(
      `
        const response = await fetch("https://allowed.test/data", { method: "POST" });
        export default {
          ok: response.ok,
          status: response.status,
          text: await response.text(),
        };
      `,
      { fetch },
    );

    await expectValue(result, { ok: true, status: 200, text: "method=POST" });
    expect(calls).toEqual([{ url: "https://allowed.test/data", method: "POST" }]);
  });

  test("propagates just-bash secure fetch denials", async () => {
    const sandbox = createJsSandbox();
    const fetch: SecureFetch = async (url) => {
      throw new Error(`Network access denied by just-bash: ${url}`);
    };

    const result = await sandbox.run(
      `
        export default await fetch("https://blocked.test/data");
      `,
      { fetch },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Network access denied by just-bash");
  });

  test("routes node:http through just-bash secure fetch", async () => {
    const sandbox = createJsSandbox();
    const fetch: SecureFetch = async (url) => textFetchResult(url, "from-http-policy");

    const result = await sandbox.run(
      `
        import http from "node:http";

        export default await new Promise((resolve, reject) => {
          const request = http.get("http://allowed.test/from-http", (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => {
              resolve({ statusCode: response.statusCode, body });
            });
          });
          request.on("error", reject);
        });
      `,
      { fetch },
    );

    await expectValue(result, { statusCode: 200, body: "from-http-policy" });
  });

  test("routes node:https through just-bash secure fetch", async () => {
    const sandbox = createJsSandbox();
    const fetch: SecureFetch = async (url) => textFetchResult(url, "from-https-policy");

    const result = await sandbox.run(
      `
        import https from "node:https";

        export default await new Promise((resolve, reject) => {
          const request = https.get("https://allowed.test/from-https", (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => {
              resolve({ statusCode: response.statusCode, body });
            });
          });
          request.on("error", reject);
        });
      `,
      { fetch },
    );

    await expectValue(result, { statusCode: 200, body: "from-https-policy" });
  });

  test("keeps direct DNS denied even when secure fetch is provided", async () => {
    const sandbox = createJsSandbox();
    const fetch: SecureFetch = async (url) => textFetchResult(url, "ok");

    const result = await sandbox.run(
      `
        import dns from "node:dns";

        export default await new Promise((resolve, reject) => {
          dns.lookup("example.com", (error, address) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(address);
          });
        });
      `,
      { fetch },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/network|dns|connect|permission|EACCES/i);
  });

  test("inherits real just-bash NetworkConfig allow-list and method firewall", async () => {
    const server = await createTestHttpServer((request, response) => {
      if (request.url === "/allowed") {
        writeTextResponse(response, 200, "allowed");
        return;
      }

      writeTextResponse(response, 200, "unexpected");
    });
    const fs = new MemoryJustBashFs({
      "/workspace/request.mjs": `
        const method = process.argv[3] ?? "GET";
        const options = { method };
        if (method !== "GET") {
          options.body = "body";
        }

        const response = await fetch(process.argv[2], options);
        console.log(response.status + ":" + await response.text());
      `,
    });
    const sandbox = createJsSandbox({ fs });
    const bash = new Bash({
      fs,
      cwd: "/workspace",
      customCommands: [sandbox.createNodeCommand()],
      network: {
        allowedUrlPrefixes: [`${server.origin}/allowed`],
        allowedMethods: ["GET"],
      },
    });

    try {
      const allowed = await bash.exec(`node request.mjs ${server.origin}/allowed`);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toBe("200:allowed\n");

      const blockedUrl = await bash.exec(`node request.mjs ${server.origin}/blocked`);
      expect(blockedUrl.exitCode).toBe(1);
      expect(blockedUrl.stderr).toMatch(/network|denied|not allowed/i);

      const blockedMethod = await bash.exec(`node request.mjs ${server.origin}/allowed POST`);
      expect(blockedMethod.exitCode).toBe(1);
      expect(blockedMethod.stderr).toMatch(/method|denied|not allowed/i);

      expect(server.requests).toEqual(["GET /allowed"]);
    } finally {
      await server.close();
    }
  });

  test("node command forwards just-bash secure fetch", async () => {
    const command = createJsSandbox().createNodeCommand();
    const fetch: SecureFetch = async (url) => textFetchResult(url, "from-policy");
    const result = await command.execute(
      [
        "-e",
        `
          const response = await fetch("https://allowed.test/from-command");
          console.log(await response.text());
        `,
      ],
      createCommandContext({ fetch }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from-policy\n");
  });

  test("node command forwards only exported shell environment variables", async () => {
    const command = createJsSandbox().createNodeCommand();
    const result = await command.execute(
      [
        "-e",
        `
          console.log(process.env.SECRET ?? "missing");
          console.log(process.env.PUBLIC ?? "missing");
        `,
      ],
      createCommandContext({
        env: new Map([
          ["SECRET", "hidden"],
          ["PUBLIC", "shown"],
        ]),
        exportedEnv: {
          PUBLIC: "shown",
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("missing\nshown\n");
  });

  test("keeps eval and Function constructor from reaching the host", async () => {
    const sandbox = createJsSandbox();

    expect(
      (
        await sandbox.run(`
          export default function main() {
            return Function("return process")();
          }
        `)
      ).ok,
    ).toBe(false);
    expect(
      (
        await sandbox.run(`
          export default function main() {
            return eval("process");
          }
        `)
      ).ok,
    ).toBe(false);
  });

  test("enforces output limits", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(
      `
        console.log("abcdef");
        export default true;
      `,
      {
        policy: {
          outputLimitBytes: 4,
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("OUTPUT_LIMIT");
    expect(result.error?.message).toContain("Output limit exceeded");
    expect(result.stdout).toBe("abcd");
    expect(result.audit.output.truncated).toBe(true);
  });

  test("keeps capped output while later runtime limits remain primary", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(
      `
        console.log("abcdef");
        await SecureExec.bindings.echo("a");
        await SecureExec.bindings.echo("b");
      `,
      {
        bindings: {
          echo: (input: unknown) => input,
        },
        policy: {
          maxBindingCalls: 1,
          outputLimitBytes: 4,
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.message).toBe("Maximum binding call count exceeded");
    expect(result.stdout).toBe("abcd");
    expect(result.audit.output.stdoutBytes).toBe(4);
    expect(result.audit.output.truncated).toBe(true);
    expect(result.audit.bindings.denied).toContainEqual({
      name: "echo",
      reason: "max binding call count exceeded",
    });
  });

  test("enforces wall-clock limits independently of the CPU limit", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(
      `
        await new Promise((resolve) => setTimeout(resolve, 2000));
        export default true;
      `,
      {
        policy: {
          cpuLimitMs: 3000,
          wallClockLimitMs: 50,
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.error?.message).toContain("50ms");
    expect(result.audit.timedOut).toBe(true);
  });

  test("truncates output at UTF-8 character boundaries", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(
      `
        console.log("a🙂");
        export default true;
      `,
      {
        policy: {
          outputLimitBytes: 2,
        },
      },
    );

    expect(result.error?.message).toContain("Output limit exceeded");
    expect(result.stdout).toBe("a");
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.audit.output.stdoutBytes).toBe(1);
    expect(result.audit.output.truncated).toBe(true);
  });
});

describe("custom bindings", () => {
  test("calls direct and nested Secure Exec bindings", async () => {
    const sandbox = createJsSandbox();

    const result = await sandbox.run(
      `
        const value = await SecureExec.bindings.echo({ message: "hi" });
        const nested = await SecureExec.bindings.group.twice(21);
        export default value;
      `,
      {
        bindings: {
          echo: (input: unknown) => ({ ok: (input as { message: string }).message }),
          group: {
            twice: (value: unknown) => Number(value) * 2,
          },
        },
      },
    );

    await expectValue(result, { ok: "hi" });
    expect(result.audit.bindings.calls).toMatchObject([
      { name: "echo", ok: true },
      { name: "group.twice", ok: true },
    ]);
  });

  test("rejects binding results that cannot round-trip over JSON", async () => {
    const cases: Array<[string, () => unknown]> = [
      ["bigint", () => 1n],
      ["map", () => new Map([["key", "value"]])],
      ["set", () => new Set(["value"])],
      ["date", () => new Date("2026-06-13T00:00:00.000Z")],
      ["typedArray", () => new Uint8Array([1, 2, 3])],
      ["nan", () => Number.NaN],
      ["infinity", () => Number.POSITIVE_INFINITY],
    ];

    for (const [name, value] of cases) {
      const sandbox = createJsSandbox();
      const result = await sandbox.run(
        `
          export default await SecureExec.bindings.value();
        `,
        {
          bindings: {
            value,
          },
        },
      );

      expect(result.ok, name).toBe(false);
      expect(result.error?.message, name).toMatch(/JSON-serializable|serializable/i);
      expect(result.error?.message, name).not.toBe("[object Object]");
      expect(result.audit.bindings.calls).toEqual(
        expect.arrayContaining([
          {
            name: "value",
            durationMs: expect.any(Number),
            ok: false,
          },
        ]),
      );
    }
  });

  test("recovers audited binding-denial messages from runtime error text", async () => {
    const sandbox = createJsSandbox();
    const result = await sandbox.run(
      `
        export default await SecureExec.bindings.value();
      `,
      {
        bindings: {
          value: () => 1n,
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/^Binding result denied: .*JSON-serializable/i);
    expect(result.error?.message).not.toBe("[object Object]");
    expect(result.audit.bindings.denied.at(-1)).toMatchObject({
      name: "value",
      reason: expect.stringMatching(/JSON-serializable/i),
    });
  });

  test("fails missing, timed-out, and excessive binding calls", async () => {
    const sandbox = createJsSandbox();

    const missing = await sandbox.run(`
      export default async function main() {
        return await SecureExec.bindings.echo("ok");
      }
    `);
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toMatch(/echo|function|undefined/i);

    const timedOut = await sandbox.run(
      `
        export default async function main() {
          return await SecureExec.bindings.slow();
        }
      `,
      {
        bindings: {
          slow: () => new Promise((resolve) => setTimeout(resolve, 100)),
        },
        policy: { wallClockLimitMs: 5 },
      },
    );
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error?.message).toMatch(/timed out|timeout/i);

    const excessiveCalls = await sandbox.run(
      `
        export default async function main() {
          await SecureExec.bindings.echo("a");
          return await SecureExec.bindings.echo("b");
        }
      `,
      {
        bindings: {
          echo: (input: unknown) => input,
        },
        policy: { maxBindingCalls: 1 },
      },
    );
    expect(excessiveCalls.ok).toBe(false);
    expect(excessiveCalls.error?.message).toContain("Maximum binding call count");
    expect(excessiveCalls.audit.bindings.denied).toContainEqual({
      name: "echo",
      reason: "max binding call count exceeded",
    });
    expect(excessiveCalls.audit.bindings.calls).toHaveLength(1);
    expect(excessiveCalls.audit.bindings.calls[0]).toMatchObject({
      name: "echo",
      durationMs: expect.any(Number),
      ok: true,
    });
  });

  test("allows concurrent binding calls at default call depth", async () => {
    const sandbox = createJsSandbox();

    const result = await sandbox.run(
      `
        export default await Promise.all([
          SecureExec.bindings.delay("a"),
          SecureExec.bindings.delay("b"),
        ]);
      `,
      {
        bindings: {
          delay: (value: unknown) =>
            new Promise((resolve) => {
              setTimeout(() => resolve(value), 5);
            }),
        },
        policy: {
          maxBindingCallDepth: 1,
        },
      },
    );

    await expectValue(result, ["a", "b"]);
  });
});

async function expectValue<T>(
  result: { ok: boolean; error?: unknown; value?: T },
  value: T,
): Promise<void> {
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.value).toEqual(value);
}

function textFetchResult(url: string, body: string): Awaited<ReturnType<SecureFetch>> {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/plain" },
    body: new TextEncoder().encode(body),
    url,
  };
}

function fsPolicy(
  override: Partial<{
    roots: string[];
    read: boolean;
    write: boolean;
    mkdir: boolean;
    delete: boolean;
  }>,
) {
  return {
    roots: ["/workspace", "/tmp"],
    read: true,
    write: true,
    mkdir: true,
    delete: false,
    ...override,
  };
}

function createTestAudit(policy = resolveRuntimePolicy()): AuditRecorder {
  return new AuditRecorder(
    createAuditRecord({
      cwd: "/workspace",
      filename: "/workspace/test.mjs",
      policy,
    }),
  );
}

async function createTestHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{
  origin: string;
  requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    const rejectOnce = (error: Error) => {
      server.off("listening", resolveOnce);
      reject(error);
    };
    const resolveOnce = () => {
      server.off("error", rejectOnce);
      resolve();
    };

    server.once("error", rejectOnce);
    server.once("listening", resolveOnce);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected HTTP server to listen on a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function writeTextResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(body);
}

function createCommandContext(
  options: {
    env?: Map<string, string>;
    exportedEnv?: Record<string, string>;
    fetch?: SecureFetch;
  } = {},
): CommandContext {
  return {
    fs: new MemoryJustBashFs(),
    cwd: "/workspace",
    env: options.env ?? new Map(),
    exportedEnv: options.exportedEnv,
    stdin: EMPTY_BYTES,
    fetch: options.fetch,
  };
}
