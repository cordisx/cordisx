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

The default profile uses the existing signed-in Codex/ChatGPT Host profile,
account, conversations, projects, models, and host configuration. CordisX
still keeps its own `CORDISX_HOME` configuration and state. An explicit named
separate Host root is needed only for an explicit `host-isolated` profile;
ordinary CordisX configuration remains independent through `CORDISX_HOME`:

```bash
npx cordisx@beta codex default --data shared
npx cordisx@beta codex work --data host-isolated
```

## Create a plugin

The creator supports three project shapes. The original positional command
continues to create one standalone plugin:

```bash
npm create cordisx-plugin@beta my-plugin
npx create-cordisx-plugin@beta another-plugin
```

A repository dedicated to several plugins uses one development composition and
separate plugin packages:

```bash
npx create-cordisx-plugin@beta --mode workspace my-plugin-suite \
  --plugin chatroom --plugin calendar
```

An existing business project keeps the CordisX environment under `.cordisx`:

```bash
cd my-business-project
npx create-cordisx-plugin@beta --mode embedded . \
  --plugin chatroom --plugin calendar
```

The generated shapes are:

```text
my-plugin/
├── package.json
├── tsconfig.json
└── src/
    ├── my-plugin.tsx
    └── overview-page.tsx

my-plugin-suite/
├── package.json
├── tsconfig.json
├── tsconfig.base.json
├── cordisx.config.json
└── plugins/
    ├── chatroom/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.tsx
    │       └── overview-page.tsx
    └── calendar/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.tsx
            └── overview-page.tsx

my-business-project/
└── .cordisx/
    ├── package.json
    ├── tsconfig.json
    ├── config.json
    └── plugins/
        ├── chatroom/
        │   └── src/
        │       ├── index.tsx
        │       └── overview-page.tsx
        └── calendar/
            └── src/
                ├── index.tsx
                └── overview-page.tsx
```

The embedded form never replaces the business project's TypeScript or package
configuration. `.cordisx` always owns its `package.json` and `tsconfig.json`.
With the default `--integration auto`, the creator adds `.cordisx` to an
existing pnpm, npm, Yarn, or Bun workspace. pnpm updates
`pnpm-workspace.yaml`; the other supported workspace forms update
`package.json#workspaces`. The package manager may share storage or use PnP,
but `.cordisx` remains a separate declared package and dependency boundary.
Use `--integration isolated` to keep installation and `node_modules` inside
`.cordisx`, or `--integration workspace` to require a detected workspace.
`--package-manager npm|pnpm|yarn|bun` makes automation deterministic.

Each generated plugin owns a version-1 manifest-bearing TypeScript entry, a
structured toolbar contribution, a named component-only React module, and a
README. Its surrounding standalone, workspace, or `.cordisx` package supplies
the check, build, test, and development scripts. For a standalone plugin:

```bash
cd my-plugin
npm install
npm run check
npm run dev:dry-run
npm run dev
```

For a dedicated workspace, run the same scripts at its root. For embedded
isolated mode, run them inside `.cordisx`; for workspace integration, install at
the containing workspace root and run the `.cordisx` package's scripts.

`dev:dry-run` validates the selected entries without launching Codex Desktop.
`dev` starts one development Host and one Vite server for all configured
plugins. Changes inside a component-only module use React Fast Refresh and can
preserve component state. Entry, manifest, `apply()`, and non-refresh-safe
changes replace the affected Cordis plugin generation with lifecycle cleanup
and rollback. The initial templates have no marketplace submission, package
signing, permission grants, or execution sandbox; plugins remain trusted local
renderer code.

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

The default shared command starts an independent Host process with an
automatically selected loopback CDP port and a persistent Chromium directory
under `CORDISX_HOME`. It explicitly retains `HOME` and `CODEX_HOME`, so the
existing account, conversations, projects, and models remain available without
copying or reading cookies:

```bash
npm run dev
npm run dev -- codex
npm run dev -- codex work
npm run dev -- codex work --data host-isolated
```

The named profile is persisted in the CordisX home configuration. `default`
and an unknown explicit profile such as `work` use independent, persistent
Chromium directories while sharing `HOME` and `CODEX_HOME`. The per-profile
CordisX state and Chromium directory are stored under:

```text
~/.cordisx/apps/codex/profiles/<profile>/
```

Other supported modes are:

```bash
# Attach to a host that was already started with --remote-debugging-port=9229.
npm run dev -- codex --attach

# Explicitly use the normal Host Chromium profile. This escape hatch is not
# required for normal shared launches.
npm run dev -- codex --system

# Override the application executable when automatic discovery is insufficient.
npm run dev -- codex --executable /Applications/Codex.app/Contents/MacOS/Codex
npm run dev -- codex --executable /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

`--profile-dir <path>` overrides the selected profile's independent Chromium
path without changing `HOME` or `CODEX_HOME`. `--system` is the only mode that
uses the normal Host Chromium profile. The old `--isolated` flag remains
accepted only by `cordisx dev`; ordinary launch uses the explicit
`--data host-isolated` contract when a separate Host root is truly required.

A `shared` profile uses an independent Chromium profile plus the user's `HOME`
and `CODEX_HOME`, so the account, conversations, projects, and model
configuration remain available without a new login. A `host-isolated` profile
instead projects private Host and Chromium roots. Both use a loopback CDP port;
shutdown removes the tracked injection and stops only the exact process started
by this launcher. A launch that exits before injection reports the generic CDP
readiness failure; it is never reported as ready.

Project-local composition is an explicit developer mode only:

```bash
npm run dev -- dev --config cordisx.config.json
npm run dev -- dev ./plugins/example.ts --dry-run
```

These development commands keep project/config roots separate from Host state.
With `CORDISX_HOME=/absolute/home`, direct PublisherGrant state is stored below
`/absolute/home/state/publisher-grants` and the default project-scoped Chromium
profile below `/absolute/home/projects`; `--profile-dir` overrides only that
Chromium path. Before non-dry development writes state, the selected Home must
be a real, current-user-owned private directory; a safe existing `0755`
explicit Home is tightened to `0700`, while symlinks and non-owned directories
fail closed. New Chromium profile directories are `0700`. `--dry-run` writes
neither location.

`cordisx.config.ui-demos.json` is intentionally read-only developer
composition. For editable configuration and restart/readback testing, use the
separate `config/ui-demos/config.json` CordisX Home. A normal launch keeps this
CordisX configuration independent while its `shared` Host-data profile can use
the already signed-in Codex account:

```bash
CORDISX_HOME="$PWD/config/ui-demos" npm run dev -- codex ui-demo --data shared
```

On first use, CordisX tightens that exact user-owned `CORDISX_HOME` directory
to `0700`; it never recurses into the checkout or changes the Host profile.

Automated smoke instead copies the same template into a disposable private
CordisX Home and removes only that runner-created Home:

```bash
npm run smoke:isolated-app -- \
  --port 58323 \
  --profile-dir /tmp/cordisx-ui-demo-profile \
  --home-config "$PWD/config/ui-demos/config.json" -- \
  --manager-tab plugins \
  --manager-plugin form-schema-gallery \
  --manager-detail-tab config \
  --manager-form-exercise \
  --manager-screenshot /tmp/cordisx-ui-demo.png \
  --report /tmp/cordisx-ui-demo.json
```

The template contains no credentials or external provider endpoints. Its
profile-scoped plugin revisions make the Host configuration writer available,
so edits can be verified instead of showing a read-only developer projection.
An explicit custom `--smoke-entry` may also set the runner-only
`--renderer-timeout-ms` from `30000` through `600000` before the separator for
a cold production-sized bootstrap. Ordinary and built-in harness defaults stay
unchanged; use `CORDISX_CDP_INJECTION_TIMEOUT_MS` separately when the injection
operation itself needs the documented process-local capture budget.

### Local-development checkpoint gate

Run the deterministic local-development gate after a clean install. It builds
the workspace dependencies first, then exercises generation, rollback/join,
Manager privacy, Home/profile isolation, and cleanup contracts without opening
Codex Desktop:

```bash
npm ci
npm run checkpoint:local-dev
```

Before freezing a Host candidate, run the separate slow real-App gate. It
creates a private checkpoint root, chooses a loopback port, launches a fresh
isolated profile, and uses a runner-owned fixture. It verifies DEV-1, a syntax
failure retaining last-good, automatic DEV-2 recovery, a second renderer join
with an exact digest/module/runtime/lifecycle/config/last-good match, its close,
and a post-close DEV-3 generation. It also asserts public-snapshot
path privacy, Manager-private source/status projection, `0700` Home/state/new
profile roots, the `0600` direct publisher grant, no cwd/owning-repository
state writes through exact file-list/content snapshots, and launcher-PGID,
profile-path, and port cleanup readback:

```bash
npm run checkpoint:local-dev:app -- \
  --executable /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

The default command uses the just-built workspace CLI and records that fact as
`cliMode: workspace-build`. To validate an already packed or installed CLI,
pass its absolute executable as `--cli-bin`; `--cli` selects a particular
built `dist/src/cli.js`. `--artifacts` must be a new absolute directory owned
by the runner. The gate writes one JSON report, launcher log, three screenshots,
stage hashes, PID/port inventory, and cleanup checklist there, then stops only
its own launcher process group. It preserves that evidence root for review and
never deletes a caller-selected directory. The real-App gate is deliberately
not part of `npm run check`; it requires an installed Codex Desktop executable
and an interactive desktop environment. A status projection racing a renderer
that has already reached WebSocket `CLOSED` remains a non-blocking diagnostic;
the report counts both all projection failures and this known closed-target
subset instead of hiding it.

`--online-devtools` additionally permits the official Chrome DevTools frontend
to connect to the loopback endpoint. That frontend receives full debugging
authority over the isolated renderer and must not be enabled for a normal
user instance.

## Live smoke probes

After live injection, run the read-only probe against the printed port:

```bash
npm run smoke -- --port <printed-port> --screenshot artifacts/live-smoke.png
npm run smoke -- --port <printed-port> --manager-screenshot artifacts/manager.png
npm run smoke -- --port <printed-port> --manager-tab plugins \
  --manager-plugin <plugin-id> --manager-detail-tab config \
  --manager-form-exercise --manager-viewport-width 520 \
  --manager-screenshot artifacts/host-form.png --report artifacts/host-form.json
npm run smoke -- --port <printed-port> --manager-tab plugins \
  --manager-open-local-path-form --manager-form-exercise \
  --manager-screenshot artifacts/local-path.png --report artifacts/local-path.json
npm run smoke -- --port <printed-port> --color-scheme dark \
  --trigger-screenshot artifacts/brand-trigger-dark.png
npm run smoke -- --port <printed-port> --color-scheme light \
  --authorization-plugin <plugin-id> --authorization-screenshot artifacts/authorization-light.png
npm run smoke -- --port <printed-port> --color-scheme dark \
  --authorization-plugin <plugin-id> --authorization-decline-optional \
  --authorization-decision allow --authorization-screenshot artifacts/authorization-dark.png
npm run smoke -- --port <printed-port> \
  --select-thread local:<session-id> --exercise \
  --report artifacts/live-smoke/structured-exercise.json \
  --screenshot artifacts/live-smoke/main-page.png
npm run smoke -- --port <printed-port> --generation \
  --report artifacts/live-smoke/generation.json
npm run smoke -- --port <printed-port> --manager-settings-navigation-exercise \
  --plugin-owner settings-tab-demo --generation \
  --manager-settings-navigation-item settings-tab-demo:navigation \
  --manager-screenshot artifacts/live-smoke/settings-navigation-demo.png \
  --report artifacts/live-smoke/settings-navigation-demo.json
```

`--manager-form-exercise` records the visible Host form primitive map,
label/help/error accessibility relationships, responsive grid and overflow
state, then uses CDP mouse and native Tab input to prove focus movement.
`--manager-open-local-path-form` opens the launcher-owned local-package form,
captures it, and cancels it before the interactive-dialog cleanup gate. For a
developer composition, `smoke:isolated-app` also accepts
`--dev-config <absolute-or-project-relative-config>` before the `--` separator;
the normal launcher form and persistence smoke should continue to use a named
launcher profile rather than developer mode.

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

`--manager-settings-navigation-exercise` uses pointer and keyboard input
against the real first-level Manager navigation entry. It checks the Host-owned
standard header and controlled body mount, policy deny/restore, locale
reprojection, Plugins fallback/focus, and unchanged `app://` URL. Combine it
with `--generation` to record active Manager-content cleanup after the
screenshot is captured.

## Minimal plugin

Configured TypeScript plugin entries enter the development Vite module graph.
The plugin surface follows the Cordis service and fiber lifecycle:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['i18n', 'commands', 'slots']

export function apply(ctx: Context) {
  ctx.i18n.define({
    namespace: 'example',
    locale: 'en',
    default: true,
    messages: { 'hello.title': 'Say hello' },
  })
  ctx.commands.register({
    id: 'hello',
    title: { namespace: 'example', key: 'hello.title' },
  }, () => console.info('hello'))
  ctx.slots.register({
    name: 'workspace.toolbar.items',
    id: 'hello',
    order: 10,
  }, {
    anchor: 'workspace.primary',
    placement: 'after',
    label: { namespace: 'example', key: 'hello.title' },
    icon: 'host:open',
    command: { id: 'hello' },
  })
}
```

For an editable Manager form, export a Schemastery `Config`. It is also a
Standard Schema validator, so the same object supplies defaults and runtime
validation. `configApplies` defaults to `plugin-restart`; choose `live` only when the
plugin consumes committed changes through `ctx.settings.watch()`:

```ts
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const Config = Schema.object({
  timeout: Schema.number().default(30).min(1).max(120)
    .role('duration')
    .extra('extra', { label: { 'zh-CN': '请求超时', en: 'Request timeout' } })
    .description('Maximum wait time in seconds.'),
})
export const configApplies = 'live'
export const inject = ['settings', 'configRenderers']

export function apply(ctx: Context, config: { timeout: number }) {
  useTimeout(config.timeout)
  ctx.settings.watch<{ timeout: number }>(next => useTimeout(next.timeout))
  ctx.configRenderers.register({
    id: 'duration',
    selector: { role: 'duration' },
    order: 10,
  }, (container, field) => {
    const input = container.ownerDocument.createElement('input')
    input.type = 'range'
    input.value = String(field.value)
    input.addEventListener('input', () => field.setDraft(Number(input.value)))
    container.append(input)
    return () => input.remove()
  })
}
```

The Host still owns the field label, help/error projection, save/reset state,
focus, and accessibility. Renderer registration and mounts are fiber effects.
Selectors may use one role, exact field path, or owner namespace. Sensitive
roles such as `secret` and `credential` are Host-reserved and cannot be passed
to a custom renderer; the current beta intentionally leaves them unavailable
until a launcher credential broker exists.

Shell slots accept structured contribution data only. The initial surfaces
cover sidebar footer controls/menu, sidebar navigation, workspace toolbar, and
the environment information panel. Complex DOM belongs only in a registered
CordisX page mounted inside a host-declared outlet; version-sensitive Codex DOM
probes stay in the private adapter.

For runtime, manager, marketplace-discovery, trust, and compatibility details,
continue with [architecture.md](architecture.md). For implemented and planned
delivery boundaries, see [development-plan.md](development-plan.md).
