# Repository Instructions

This is a Vite+ pnpm monorepo for focused agent runtime packages. Workspace packages live under `packages/*`.

Follow any nested `AGENTS.md` files before making package-specific changes.

## Toolchain

Use Vite+ through the `vp` CLI. Vite+ wraps package management, formatting, linting, type checking, tests, and builds.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

After pulling remote changes, run:

```bash
vp install
```

For normal validation, run:

```bash
vp check
vp run -r test
vp run -r build
```

The root ready script runs the same validation sequence:

```bash
vp run ready
```

If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

## Running Tests

Run tests through Vite+.

For the full monorepo test suite, run:

```bash
vp run -r test
```

For one package's test script, use a package task specifier:

```bash
vp run <package-name>#test
```

You can also filter recursive tasks when that is more convenient:

```bash
vp run -r --filter <package-name> test
```

## Development Guidance

- Keep package boundaries focused. Avoid adding generic framework code to a package when the concern belongs to the host application.
- Prefer existing package patterns, public APIs, and README-documented behavior over new abstractions.
- Check package `package.json` scripts and `vite.config.ts` before choosing validation commands.
- For security-sensitive behavior, prefer real boundary tests over mocks.
- Do not add machine-specific wrapper commands to repository instructions.
