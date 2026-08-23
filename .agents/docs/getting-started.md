# CordisX development entrypoint

This document owns local setup, launcher operation, live smoke testing, and the
minimal plugin example. The repository README intentionally stays focused on
the product rather than these implementation details.

## Local setup

Use Node.js 22.19 or newer.

```bash
npm install
cp cordisx.config.example.json cordisx.config.json
npm run check
npm run dev -- --dry-run
```

## Launch modes

The default command starts a separately tracked Codex instance with a
project-scoped Chromium profile and an automatically selected loopback CDP
port:

```bash
npm run dev -- --config cordisx.config.json
```

The profile is stored under:

```text
~/.cordisx/projects/<project-key>/cache/codex-app-profile/
```

Other supported modes are:

```bash
# Attach to a host that was already started with --remote-debugging-port=9229.
npm run dev -- --config cordisx.config.json --attach

# Use the system Chromium profile. Exit the ordinary instance first.
npm run dev -- --config cordisx.config.json --system

# Override the application executable when automatic discovery is insufficient.
npm run dev -- --executable /Applications/Codex.app/Contents/MacOS/Codex
npm run dev -- --executable /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

`--profile-dir <path>` overrides the project profile path. `--isolated` remains
an explicit compatibility spelling for the default isolated mode.

The isolated instance has separate Codex/Electron processes, Chromium data,
CDP port, UI storage, window restoration, and AppServer stdio lifecycle. It
shares `HOME` and `CODEX_HOME`, so the account, conversations, projects, and
model configuration remain available. Shutdown removes the tracked injection
and stops only the process started by this launcher.

`--online-devtools` additionally permits the official Chrome DevTools frontend
to connect to the loopback endpoint. That frontend receives full debugging
authority over the isolated renderer and must not be enabled for a normal
user instance.

## Live smoke probes

After live injection, run the read-only probe against the printed port:

```bash
npm run smoke -- --port <printed-port> --screenshot artifacts/live-smoke.png
npm run smoke -- --port <printed-port> --manager-screenshot artifacts/manager.png
```

## Minimal plugin

Configured TypeScript plugin entries are composed into the renderer bundle.
The plugin surface follows the Cordis service and fiber lifecycle:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'cordisx/contracts'

export const inject = ['slots']

export function apply(ctx: Context) {
  ctx.slots.inject('header.actions', () => ctx.slots.register({
    name: 'header.actions',
    id: 'my-header-button',
    order: 10,
  }, ({ container, document }) => {
    const button = document.createElement('button')
    button.textContent = 'Hello'
    container.append(button)
    return () => button.remove()
  }))
}
```

The current semantic slots are `header.actions`, `composer.before`,
`composer.after`, `sidebar.footer`, and `shell.overlay`. Plugins target these
names; version-sensitive host DOM probes stay in the adapter.

For runtime, manager, marketplace-discovery, trust, and compatibility details,
continue with [architecture.md](architecture.md). For implemented and planned
delivery boundaries, see [development-plan.md](development-plan.md).
