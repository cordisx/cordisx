# Project layouts and Vite development

Choose the layout from how the user already organizes work. All modes keep
plugin source and dependencies out of CordisX Host source.

## Creation modes

The direct creator syntax is:

```bash
npx create-cordisx-plugin@beta <target> [options]
```

Use one of these shapes:

| Mode                       | Use it when                                                                                  | Creator options                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Standalone single plugin   | One repository publishes or develops one plugin                                              | default, or `--mode single`; the target directory determines the package and plugin id |
| Dedicated plugin workspace | One repository owns several related plugins                                                  | `--mode workspace --plugin <id> --plugin <id>`                                         |
| Embedded business project  | CordisX plugins are tooling or product integration inside an existing application repository | `--mode embedded --plugin <id>`; the target may already contain the business project   |

For embedded mode, choose dependency integration with
`--integration auto|workspace|isolated` and detect or specify the package
manager with `--package-manager auto|npm|pnpm|yarn|bun`. Prefer `auto` unless
the repository or user requires a particular result.

Do not replace an existing manifest, lockfile, workspace declaration, tsconfig,
or source tree casually. Inspect the generated diff and retain the project's
package-manager conventions.

A standalone project owns one package, tsconfig, lifecycle entry, and separate
refresh-compatible React component module. A dedicated workspace owns one root
config and development command, then gives every `plugins/<id>` its own package,
tsconfig, source, and build output:

```text
plugin-suite/
├── cordisx.config.json
├── package.json
├── tsconfig.base.json
├── tsconfig.json
└── plugins/
    ├── chatroom/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/...
    └── calendar/
        ├── package.json
        ├── tsconfig.json
        └── src/...
```

## Embedded boundary

The conventional embedded root is:

```text
business-project/
└── .cordisx/
    ├── config.json
    ├── package.json
    ├── tsconfig.json
    └── plugins/
        ├── chatroom/
        │   └── src/...
        └── calendar/
            └── src/...
```

`.cordisx/config.json` lists every plugin explicitly. Entry paths are relative
to the config file:

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "chatroom",
      "entry": "./plugins/chatroom/src/chatroom.tsx",
      "enabled": true
    },
    {
      "id": "calendar",
      "entry": "./plugins/calendar/src/calendar.tsx",
      "enabled": true
    }
  ]
}
```

In isolated integration, install from `.cordisx` and keep its dependency tree
and lock state separate from the business application. In workspace
integration, add `.cordisx` as a workspace package and use the repository's
root package manager and lockfile. pnpm workspaces are first-class; npm, Yarn,
and Bun workspaces use their native workspace declarations. Workspace linking
may place physical dependency data at the repository root, but `.cordisx`
retains its own `package.json`, tsconfig, scripts, and dependency declarations.
Do not make the business application's tsconfig or implicit dependencies part
of the plugin compile contract.

## Config discovery and multiple plugins

An explicit `cordisx dev --config <path>` wins. Without it, development walks
upward from the current directory. The nearest project wins, and within each
directory `.cordisx/config.json` wins over the compatible
`cordisx.config.json`. A positional `cordisx dev <entry>` remains the concise
single-plugin path.

A config project uses one `cordisx dev` process, one Vite server, and one
Electron App for all enabled `plugins[]` entries. Do not launch one Vite server
or App per plugin. Shared libraries stay in Vite's module graph, while plugin
entry boundaries preserve per-plugin Cordis lifecycle replacement.

## Update behavior

- A refresh-compatible React component module uses Vite React Fast Refresh and can retain local component state.
- A plugin entry, manifest, `apply`, or non-refresh-safe module change reloads the affected plugin through its Cordis generation boundary and disposes its previous contributions.
- A Host renderer change outside a refresh boundary restarts CordisX inside the current document.
- Project config, installed dependencies, and Node-side launcher or bridge changes require restarting `cordisx dev`.
- The Manager's **Reload plugin** action explicitly reloads one active local-development plugin. It is independent from automatic file detection and does not imply package lifecycle operations for unmanaged local entries.

The development module graph uses the same Host React singleton for
`cordisx/react`, its JSX runtimes, `cordisx/ui`, and compatible React peer
dependencies. Plugin authors should import React APIs through `cordisx/react`
and avoid bundling a private React or component-library copy.

CDP installs the initial bootstrap into the native `app://` renderer. Before
reloading it grants loopback access to that exact target origin and enables CSP
bypass. Module loading and subsequent notifications use Vite HTTP and Vite's
own HMR WebSocket. Source maps are separate and loaded only when requested.
Stopping the launcher restores the permission to `prompt`, disables CSP bypass,
waits for an in-flight HMR connection before disconnecting it, removes
Vite-injected styles, closes the Vite server, and clears in-memory
session/source-map state. Vite's
dependency optimizer data remains in a stable user-private
`CORDISX_HOME/cache/native-vite` tree keyed by the CLI root and workspace root
so the next launch of that workspace can reuse it. The launcher rejects a
symlinked or foreign-owned cache leaf before Vite can use it.
Normal native development also waits for the Host/plugin dependency scan and
cache commit before it opens Electron; `--dry-run` skips that prebundle work.

Production plugin delivery remains immutable package/generation activation.
Do not describe development Fast Refresh as a production update or security
isolation mechanism; local renderer plugins remain trusted code.
