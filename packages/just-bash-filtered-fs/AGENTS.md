# just-bash-filtered-fs Instructions

This package is a focused `just-bash` `IFileSystem` policy wrapper.

## Design Boundaries

- `just-bash` owns shell execution and the base filesystem contract.
- This package owns agent-visible path filtering for an existing `IFileSystem`.
- Filesystem persistence, snapshots, quotas, session lifecycle, and cleanup are host-application concerns.

## API Shape

- Keep the public API narrow: `FilteredFs`, `FilteredFsOptions`, `isPathExcluded`, and `matchSegment`.
- Do not add persistence, snapshot, or backend concepts here.
- Filtering must be enforced through the `IFileSystem` methods, not only through documentation or helper calls.

## Security Expectations

This package is security-sensitive. Changes need real behavior tests against the wrapper.

Important coverage areas:

- Hidden paths read as missing.
- Directory listings omit hidden entries.
- Writes to hidden paths are blocked.
- Symlinks and hard links cannot expose hidden targets.
- Recursive copy and move cannot relocate hidden descendants into visible paths.

## Running Tests

Run this package's tests through Vite+:

```bash
vp run just-bash-filtered-fs#test
```

For workspace validation, run:

```bash
vp check
vp run -r test
vp run -r build
```
