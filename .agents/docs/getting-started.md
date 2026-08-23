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
npm run smoke -- --port <printed-port> \
  --select-thread local:<session-id> --exercise \
  --report artifacts/live-smoke/structured-exercise.json \
  --screenshot artifacts/live-smoke/main-page.png
npm run smoke -- --port <printed-port> --generation \
  --report artifacts/live-smoke/generation.json
```

`--exercise` uses real CDP input for sidebar drag and exercises collapse,
bottom/right panels, page history/close, locale reprojection, native session
switching, plugin block/restore, and native-DOM continuity. `--generation`
disposes the current injected generation and records deterministic cleanup; run
it last because a fresh launcher generation is required afterwards.

## Minimal plugin

Configured TypeScript plugin entries are composed into the renderer bundle.
The plugin surface follows the Cordis service and fiber lifecycle:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'cordisx/contracts'

export const inject = ['i18n', 'commands', 'slots']

export function apply(ctx: Context) {
  ctx.i18n.define({
    namespace: 'example', locale: 'en', default: true,
    messages: { 'hello.title': 'Say hello' },
  })
  ctx.commands.register({
    id: 'hello', title: { namespace: 'example', key: 'hello.title' },
  }, () => console.info('hello'))
  ctx.slots.register({
    name: 'workspace.toolbar.items', id: 'hello', order: 10,
  }, {
    anchor: 'workspace.primary', placement: 'after',
    label: { namespace: 'example', key: 'hello.title' },
    icon: 'host:open', command: { id: 'hello' },
  })
}
```

Shell slots accept structured contribution data only. The initial surfaces
cover sidebar footer controls/menu, sidebar navigation, workspace toolbar, and
the environment information panel. Complex DOM belongs only in a registered
CordisX page mounted inside a host-declared outlet; version-sensitive Codex DOM
probes stay in the private adapter.

For runtime, manager, marketplace-discovery, trust, and compatibility details,
continue with [architecture.md](architecture.md). For implemented and planned
delivery boundaries, see [development-plan.md](development-plan.md).
