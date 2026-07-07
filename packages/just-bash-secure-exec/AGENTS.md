# just-bash-secure-exec Instructions

This package is a focused adapter between `just-bash` and `secure-exec`.

## Design Boundaries

- `just-bash` owns shell execution, filesystem state, environment, and network policy.
- `secure-exec` owns JavaScript execution.
- This package connects the two so a `just-bash` shell can expose a locked-down Node-like command.
- Per-user or per-agent session lifecycle, filesystem persistence, quotas, cleanup, and outer process/container isolation are host-application concerns.

## API Shape

- Keep the public API narrow and package-specific.
- Prefer `createJsSandbox({ fs }).createNodeCommand()` for Bash integration.
- Do not add standalone aliases, compatibility shims, or generic session-management APIs.
- Bindings should be accepted as a plain object and exposed under `SecureExec.bindings`; avoid adding a separate code-mode abstraction unless there is a concrete need.
- Network behavior should inherit `just-bash` policy through `CommandContext.fetch`; do not add a second network allow-list in this package.

## Security Expectations

This package is security-sensitive. Changes to filesystem, network, runtime policy, bindings, or command execution need real tests of the actual behavior.

Important coverage areas:

- Filesystem root enforcement and traversal denial.
- Read/write/mkdir/delete capability denial.
- Symlink and hard-link denial.
- Default network denial.
- `fetch()` and `node:http`/`node:https` routing through the `just-bash` secure fetch layer.
- Real `just-bash` `NetworkConfig` enforcement against a local HTTP server.
- Direct DNS denial, including when secure fetch is provided.
- Host environment and child-process denial.
- Output, timeout, memory, and binding-call limits.

## Running Tests

Run this package's tests through Vite+.

From the repository root, run the package test script directly:

```bash
vp run @jthieman/just-bash-secure-exec#test
```

To run all workspace package tests, use:

```bash
vp run -r test
```

For security-sensitive changes, make sure the relevant real boundary tests run. Do not replace filesystem or network boundary coverage with mocks only.

## Validation

From the repository root, run:

```bash
vp check
vp run -r test
vp run -r build
```

When iterating only inside this package, also check the package scripts in `package.json` and tasks in `vite.config.ts`.
