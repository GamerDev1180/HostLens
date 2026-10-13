# Contributing to HostLens

Thanks for helping! HostLens is a local-first PC and server diagnostics tool: an **agent** (Node.js + Hono) on each machine, and an **app** (Tauri 2 + React) that pairs with agents.

## Setup

```sh
cd agent && pnpm install && pnpm start      # prints a pairing QR code on first run
cd HostLens-program && pnpm install && pnpm tauri dev
```

You don't need a second machine or a real agent for UI work: `pnpm dev` in `HostLens-program/` and open <http://localhost:1420> in a browser. `src/dev/browserPreview.ts` simulates hosts, a FiveM server, GPU data and diagnostics.

## Checks (same as CI)

| Where                       | Command                         |
| --------------------------- | ------------------------------- |
| `agent/`                    | `pnpm typecheck` and `pnpm test` |
| `HostLens-program/`         | `pnpm build` (typechecks the app and the agent API types) |
| `HostLens-program/src-tauri`| `cargo test` (`cargo test -- --ignored` also hits a live FiveM server) |

CI runs these on the maintainers' self-hosted runners for every push and same-repo pull request. Pull requests from forks don't trigger CI; run the checks locally and a maintainer will run them after review.

## Where things live

- `agent/types.ts`: the API contract. The app imports these types directly.
- `agent/app.ts`: routes. `agent/collectors/`: metrics. `windows.ts` and `linux.ts` implement `PlatformCollector` (`collectors/common.ts`), and cross-platform pieces (CPU, processes, GPU, connections) sit next to them. Keep parsers as pure exported functions and test them with sample output in `agent/test/parsers.test.ts`, so Linux code is tested on Windows too and vice versa.
- `agent/diagnostics.ts`: ping, traceroute, DNS and TCP tests. Only validated IP literals reach a command line, and nothing runs through a shell.
- `HostLens-program/src-tauri/src/lib.rs`: every network call the app makes, plus the agent route allowlist (`ALLOWED_ROUTES`).

## Changing the agent API

1. Update `agent/types.ts` and the route in `agent/app.ts`.
2. Add new endpoints to `ALLOWED_ROUTES` in `lib.rs` and to the mocks in `browserPreview.ts`.
3. Show the data in the app. New fields must be optional at runtime, because older agents won't send them.
4. Update the API section of `README.md`.

## Ground rules

- No admin/root needed for any feature; degrade to `null`/empty when something can't be read.
- Never log or print tokens, pairing codes or webhook URLs.
- Strip secrets from anything you paste into issues.
- Ideas that aren't being built yet go in `FUTURE.md`.
