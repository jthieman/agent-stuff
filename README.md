# agent-stuff

Workspace for focused agent runtime packages and experiments.

The main package right now is [`just-bash-secure-exec`](packages/just-bash-secure-exec), which adapts [`secure-exec`](https://secureexec.dev/) into [`just-bash`](https://www.npmjs.com/package/just-bash) as a locked-down Node.js command.

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
