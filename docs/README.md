# Terax contributor docs

Long-form guides that elaborate on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

## Architecture

- [Two-process model](architecture/two-process-model.md) - IPC boundary and command reference
- [PTY shell integration](architecture/pty-shell-integration.md) - PTY, shell init scripts, OSC, ConPTY, Job Object
- [Terminal renderer pool](architecture/terminal-renderer-pool.md) - renderer pool and DormantRing invariants

## Contributing

- [Testing](contributing/testing.md) - testing contract and core-subsystem invariants
- [Releasing](release.md) - how to cut a release, trigger the workflow, and how the changelog is generated
