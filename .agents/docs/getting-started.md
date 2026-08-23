# CordisX getting started

This document owns the npm beta user path, repository-local development,
launcher operation, live smoke testing, and the minimal plugin example.

## npm beta installation

Use Node.js 22.19 or newer and install Codex Desktop before starting CordisX.
The functional prerelease is published only through the `beta` dist-tag;
unqualified npm commands still resolve the non-functional `0.0.0` name
reservation on `latest`.

The zero-install path is:

```bash
npx cordisx@beta --help
npx cordisx@beta setup
npx cordisx@beta codex --dry-run
npx cordisx@beta codex
```

For repeated use, install the same channel globally:

```bash
npm install --global cordisx@beta
cordisx setup
cordisx codex --dry-run
cordisx codex
```

`setup` creates `~/.cordisx/config.json`. Its version-1 defaults select
`codex/default/shared` and contain `providers: []` and `plugins: []`; CordisX never activates a demo
plugin implicitly. `setup` is idempotent and refuses an unrelated or invalid
existing file rather than overwriting it.

## Configure CLIProxyAPI providers

Copy [`cordisx.cli-proxy.example.json`](../../cordisx.cli-proxy.example.json) to
the active CordisX configuration and replace its endpoint and environment
variable names. Each entry is an independent provider connection:

```json
{
  "id": "gateway-a",
  "kind": "cli-proxy-api",
  "displayName": "CLIProxy Gateway A",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyEnv": "CLIPROXY_A_API_KEY"
}
```

Set the named environment variable before launching CordisX. Credential values
do not belong in the JSON file. Remote endpoints require HTTPS; cleartext HTTP
is accepted only for loopback development. Each provider gets a private
`providers/<providerId>/codex-home` session store, and the normal
`cli-proxy-api` plugin contributes the existing sidebar navigation and `main`
page. The native Codex Desktop current connection remains a separate, honestly
reported connection plane.

The default profile shares the existing host account, conversations, projects,
models, and host configuration while keeping the CordisX process, Chromium
profile, CDP endpoint, UI storage, and lifecycle separate. An explicit named
isolated profile gets its own host data roots and is reused on later launches:

```bash
npx cordisx@beta codex default --data shared
npx cordisx@beta codex work --data isolated
```

## Create a plugin

Both creator command forms resolve the beta package when the channel is
specified:

```bash
npm create cordisx-plugin@beta my-plugin
npx create-cordisx-plugin@beta another-plugin
```

The generated project owns a version-1 manifest-bearing TypeScript entry, a
structured toolbar contribution, a README, and check/build/test scripts:

```bash
cd my-plugin
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`dev:dry-run` executes `cordisx dev <entry> --dry-run` and bundles the complete
plugin without launching Codex Desktop. `dev` starts the separate development
host. The initial template has no marketplace submission, package signing,
permission grants, execution sandbox, or HMR dependency; plugins remain trusted
local renderer code.

Generated projects start with `license: UNLICENSED` so the plugin author makes
the licensing choice explicitly. Under the CordisX Independent Plugin
Exception, an independent plugin that uses only documented, versioned public
plugin interfaces may be commercial, sold, marketplace-distributed, and
licensed under author-chosen terms. Copying or modifying CordisX host code or
using private interfaces remains under the host's AGPL terms.

## Local setup

Use Node.js 22.19 or newer.

```bash
npm install
npm run check
npm run dev -- setup
npm run dev -- codex --dry-run
```

The first `setup` or ordinary launch creates `${CORDISX_HOME ||
~/.cordisx}/config.json` with `codex/default/shared`, no external providers,
and no plugins. Ordinary
launch never reads a project-local `cordisx.config.json`.

## Launch modes

The default command starts a separately tracked Codex instance with an
independent Chromium profile and an automatically selected loopback CDP port:

```bash
npm run dev
npm run dev -- codex
npm run dev -- codex work
npm run dev -- codex work --data isolated
```

The named profile is persisted in the home configuration. `default` initially
shares the host's `HOME` and `CODEX_HOME`; an unknown explicit profile such as
`work` is created as isolated and reused on later launches. Its host and
Chromium roots are stored under:

```text
~/.cordisx/apps/codex/profiles/<profile>/
```

Other supported modes are:

```bash
# Attach to a host that was already started with --remote-debugging-port=9229.
npm run dev -- codex --attach

# Use the system Chromium profile. Exit the ordinary instance first.
npm run dev -- codex --system

# Override the application executable when automatic discovery is insufficient.
npm run dev -- codex --executable /Applications/Codex.app/Contents/MacOS/Codex
npm run dev -- codex --executable /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

`--profile-dir <path>` overrides the selected Chromium profile path. The old
`--isolated` flag remains accepted only by `cordisx dev`; ordinary launch uses
the unambiguous `--data isolated` profile contract.

Every normal launch has separate Codex/Electron processes, Chromium data, CDP
port, UI storage, window restoration, and AppServer stdio lifecycle. A
`shared` profile also shares `HOME` and `CODEX_HOME`, so the account,
conversations, projects, and model configuration remain available. An
`isolated` profile instead projects private `HOME` and `CODEX_HOME` roots.
Shutdown removes the tracked injection and stops only the process started by
this launcher.

Project-local composition is an explicit developer mode only:

```bash
npm run dev -- dev --config cordisx.config.json
npm run dev -- dev ./plugins/example.ts --dry-run
```

`--online-devtools` additionally permits the official Chrome DevTools frontend
to connect to the loopback endpoint. That frontend receives full debugging
authority over the isolated renderer and must not be enabled for a normal
user instance.

## Live smoke probes

After live injection, run the read-only probe against the printed port:

```bash
npm run smoke -- --port <printed-port> --screenshot artifacts/live-smoke.png
npm run smoke -- --port <printed-port> --manager-screenshot artifacts/manager.png
npm run smoke -- --port <printed-port> --color-scheme dark \
  --trigger-screenshot artifacts/brand-trigger-dark.png
npm run smoke -- --port <printed-port> \
  --select-thread local:<session-id> --exercise \
  --report artifacts/live-smoke/structured-exercise.json \
  --screenshot artifacts/live-smoke/main-page.png
npm run smoke -- --port <printed-port> --generation \
  --report artifacts/live-smoke/generation.json
```

`--color-scheme light|dark` emulates the media preference and applies a
temporary matching color context only to the native row containing the Codex
mode switcher and CordisX trigger. The smoke script restores the row styles
after capture; this verifies the trigger's `currentColor` contrast strategy
without claiming that the complete Codex application theme was changed.

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
