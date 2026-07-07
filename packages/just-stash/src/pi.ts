import type { PersistentFs } from "./wrappers/persistent-fs.ts";
import type { SnapshotId } from "./types.ts";

/**
 * Minimal shape we need from a Pi-style command runtime.
 * Structurally typed so this module doesn't take a hard dependency
 * on any specific Pi version.
 */
export interface CommandRegistry {
  register(
    name: string,
    handler: (args: {
      args: string;
      reply: (msg: string) => void | Promise<void>;
    }) => void | Promise<void>,
  ): void;
}

/**
 * Register `/snapshot`, `/snapshots`, and `/rollback` commands.
 *
 *   import { registerSnapshotCommands } from '@jthieman/just-stash/pi';
 *
 *   const fs = new PersistentFs(inner, { backend });
 *   await fs.boot();
 *   registerSnapshotCommands(piRegistry, fs);
 */
export function registerSnapshotCommands(registry: CommandRegistry, fs: PersistentFs): void {
  registry.register("snapshot", async ({ args, reply }) => {
    try {
      const note = args.trim() || undefined;
      const info = await fs.commit({ trigger: "manual", note });
      const shortId = info.snapshotId.slice(0, 12);
      await reply(`✓ Snapshot ${shortId}${note ? ` — ${note}` : ""}`);
    } catch (e) {
      await reply(`✗ Snapshot failed: ${(e as Error).message}`);
    }
  });

  registry.register("snapshots", async ({ reply }) => {
    try {
      const history = await fs.log({ limit: 20 });
      if (history.length === 0) {
        await reply("No snapshots yet.");
        return;
      }
      const lines = history.map((c) => {
        const shortId = c.snapshotId.slice(0, 12);
        const date = new Date(c.timestamp).toISOString().slice(0, 19).replace("T", " ");
        return `  ${shortId}  ${date}  ${c.trigger}  ${c.message}`;
      });
      await reply(lines.join("\n"));
    } catch (e) {
      await reply(`✗ Failed to list snapshots: ${(e as Error).message}`);
    }
  });

  registry.register("rollback", async ({ args, reply }) => {
    const target = args.trim() as SnapshotId;
    if (!target) {
      await reply("Usage: /rollback <snapshot-id-prefix>");
      return;
    }
    try {
      // Allow prefix matching for convenience
      const history = await fs.log({ limit: 100 });
      const match = history.find((c) => c.snapshotId.startsWith(target));
      if (!match) {
        await reply(`✗ No snapshot matches '${target}'`);
        return;
      }
      await fs.rollback(match.snapshotId);
      await reply(`✓ Rolled back to ${match.snapshotId.slice(0, 12)}`);
    } catch (e) {
      await reply(`✗ Rollback failed: ${(e as Error).message}`);
    }
  });
}
