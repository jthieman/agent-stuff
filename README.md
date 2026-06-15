# agent-stuff

Workspace for focused agent runtime packages and experiments.

## Packages

- [`just-bash-secure-exec`](packages/just-bash-secure-exec) adapts [`secure-exec`](https://secureexec.dev/) into [`just-bash`](https://www.npmjs.com/package/just-bash) as a locked-down Node.js command.
- [`just-stash`](packages/just-stash) provides restorable, forkable persistence for `just-bash` filesystems and sandbox working trees.
- [`just-bash-filtered-fs`](packages/just-bash-filtered-fs) provides a path-filtering `IFileSystem` wrapper for hiding selected virtual paths from agents.

## Development

- Install dependencies after pulling changes:

```bash
vp install
```

- Check, test, and build everything:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```
