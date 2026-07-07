# just-bash-filtered-fs

Path-filtering wrapper for [`just-bash`](https://www.npmjs.com/package/just-bash) filesystems.

`FilteredFs` wraps an existing `IFileSystem` and hides selected virtual paths from the agent. Hidden paths read as missing, directory listings omit them, writes are blocked, and link/copy/move operations are checked so hidden targets cannot be exposed through visible paths.

## Install

```bash
pnpm add @jthieman/just-bash-filtered-fs just-bash
```

## Usage

```ts
import { Bash, InMemoryFs } from "just-bash";
import { FilteredFs } from "@jthieman/just-bash-filtered-fs";

const inner = new InMemoryFs({
  "/workspace/README.md": "# visible",
  "/workspace/.env": "SECRET=hidden",
});

const fs = new FilteredFs(inner, {
  exclude: [".env*", "*.pem"],
  filter: (path) => !path.includes("credentials"),
});

const bash = new Bash({ fs, cwd: "/workspace" });

await bash.exec("cat README.md");
```

## Filtering

`exclude` patterns match each path segment individually:

| Pattern    | Matches                    |
| ---------- | -------------------------- |
| `.env`     | exact segment              |
| `.env*`    | segment starts with `.env` |
| `*.pem`    | segment ends with `.pem`   |
| `*secret*` | segment contains `secret`  |

The optional `filter` callback receives the virtual path. Return `false` to hide it.

```ts
new FilteredFs(inner, {
  exclude: [".env*", "*.pem"],
  filter: (path) => !path.startsWith("/private"),
});
```

## Security Model

`FilteredFs` is an `IFileSystem` boundary wrapper. It must sit between the agent and the inner filesystem. Code with direct access to the inner filesystem can still read or mutate hidden paths.

Filtering is virtual-path based. It does not replace host filesystem isolation, process sandboxing, credential scoping, or backend access control.
