## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass in `agent/`
- [ ] `pnpm build` passes in `HostLens-program/` (typechecks the app and the agent's API types)
- [ ] `cargo test` passes in `HostLens-program/src-tauri/` (if Rust changed)
- [ ] If the agent API changed: `agent/types.ts`, the app, the Rust allowlist, the browser preview mocks and the README API section are updated (see CONTRIBUTING.md)
- [ ] Tested on: <!-- Windows / Linux / Android, and how -->
- [ ] Screenshot attached (UI changes)
