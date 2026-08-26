# Local UI Playground

`npm run dev:ui` starts a loopback-only Vite development page for CordisX and
plugin developers. The page uses React Fast Refresh and native ESM HMR for the
Host shell and React component tree. It runs an independent Cordis renderer
generation and composes the configured plugin modules with the same runtime,
Manager, HostForm, theme projection, icon, dialog, and lifecycle source used by
the production renderer. It does not start Codex Desktop, Chromium, a ChatGPT
profile, or an app-server, and it does not need an authenticated session.

Vite is a development transport, not a second renderer implementation. The
production `app://` path still uses `buildRendererBundle` and an injected,
self-contained IIFE. Vite HMR is not claimed for that injected bundle: real
Codex verification remains a production rebuild and isolated reinjection.

```sh
npm run dev:ui
npm run dev:ui -- --config /absolute/path/to/cordisx.config.json --port 43124
```

The default fixture is `cordisx.config.playground.json` (`Comprehensive UI
demos`). It activates seven local, credential-free renderer plugins:
`slot-showcase`, `hello-toolbar`, `form-schema-gallery`, `settings-tab-demo`,
`console-showcase`, built-in `channel`, and built-in `cli-proxy-api`. This
covers structured slots/pages/routes, schema-driven configuration, Manager
content navigation, Console entries, and the Channel/Provider projections. The
last two remain honestly unavailable when no launcher-side connection or
configured provider exists; the fixture never invents one.

`console-showcase` intentionally performs one optional `models.read` probe, so
the first runtime may show the normal Host-owned permission confirmation. It is
local to the temporary Playground profile: allowing or denying it neither
creates a Codex connection nor contacts a provider. Denying it leaves the
Console and all unavailable diagnostics available for inspection.

The sidebar reports the fixture name, active plugin count, and every current
plugin status. To select another real composition, start with `--config`; the
minimal `cordisx.config.example.json` remains a documentation example and is
not the Playground default. A provided composition file is read once, then
materialized below a fresh temporary `CORDISX_HOME`.
Its plugin entries become absolute paths, while writable configuration,
candidate state, cache, and reset data stay in that temporary root. Closing the
process closes the loopback server and removes the root. The source composition
is never written. `重置 fixture` restores the materialized composition and
clears its temporary state.

## What it proves

- configured local plugin modules bundle, load, activate, dispose, and rebuild
  as a new renderer generation through the normal CordisX runtime;
- Host React components update through Vite Fast Refresh without maintaining a
  copied Playground-only Manager implementation;
- Manager pages, plugin details, configuration forms, Host dialogs, theme
  tokens, icons, locale attributes, and explicit `app`/`main`/`session.content`
  page seats render in a normal browser; and
- configuration writes use the existing revision-fenced Config bridge, but
  target only the temporary materialized composition.

The Playground adapter is intentionally separate from the Codex adapter. It
uses only explicit `data-cordisx-playground-*` Host seats and never probes or
inserts Codex selectors, DOM, native anchors, a current connection, or a raw
bridge. Missing simulated shell seats remain inspectable/pending in Manager;
they are not silently replaced with a Codex-shaped fallback.

## What it cannot prove

The page deliberately reports current connection, live Codex session, native
anchor resolution, and any native Host bridge as unavailable. It cannot prove
the actual Codex theme extraction path, native-anchor placement, CDP injection,
or Host session data flow. Those require the existing isolated real `app://`
smoke after the owning change is merged.
