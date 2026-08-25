# Local UI Playground

`npm run dev:ui` starts a loopback-only browser page for CordisX and plugin
developers. It runs an independent Cordis renderer generation and bundles the
configured plugin modules with the same production `buildRendererBundle`,
runtime, Manager, HostForm, theme projection, icon, dialog, and lifecycle
code. It does not start Codex Desktop, Chromium, a ChatGPT profile, or an
app-server, and it does not need an authenticated session.

```sh
npm run dev:ui
npm run dev:ui -- --config /absolute/path/to/cordisx.config.json --port 43124
```

The default fixture is `cordisx.config.example.json`. A provided composition
file is read once, then materialized below a fresh temporary `CORDISX_HOME`.
Its plugin entries become absolute paths, while writable configuration,
candidate state, cache, and reset data stay in that temporary root. Closing the
process closes the loopback server and removes the root. The source composition
is never written. `重置 fixture` restores the materialized composition and
clears its temporary state.

## What it proves

- configured local plugin modules bundle, load, activate, dispose, and rebuild
  as a new renderer generation through the normal CordisX runtime;
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
