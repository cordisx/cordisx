# CordisX architecture

## Goal

CordisX lets trusted local plugins add or replace pieces of the Codex Desktop interface without modifying the installed Codex application. It is a UI-host project, not an alternative agent loop and not an authentication or API relay.

The initial design is based on two source snapshots inspected on 2026-08-22:

- `qqheling/codexplusplus@a114ae5`: launches Codex with a loopback CDP port, selects the Codex page target, installs scripts with `Page.addScriptToEvaluateOnNewDocument`, evaluates them in the current document, and repairs UI changes with DOM observation.
- `deepseek-ai/deepseek-harness@b150a55`: uses Cordis fibers and reversible effects for plugin lifetime, loads browser client modules separately from the agent loop, and exposes named slots instead of making each plugin patch a shell component directly.

The installed macOS host inspected during the spike is `/Applications/ChatGPT.app` 26.818.41509 (bundle 6962, identifier `com.openai.codex`). Its child process names still identify Codex renderers. The launcher therefore probes both the older standalone `Codex.app` location and the current unified `ChatGPT.app` location.

## Product boundary

OpenAI's [supported plugin UI](https://developers.openai.com/plugins/build/chatgpt-ui) is an MCP UI resource rendered in an isolated iframe alongside a conversation or in a host-controlled fullscreen presentation. That mechanism is suitable for plugin-owned task UI, but it does not expose arbitrary Codex shell replacement points such as the sidebar, header, or composer.

CordisX therefore has two explicit modes of extension:

1. Use official MCP UI for portable, conversation-owned UI.
2. Use CordisX only for local Codex shell augmentation where official UI resources cannot express the feature.

CordisX must never label its injected shell integration as an official Codex plugin API.

## Runtime

```text
cordisx.config.json
        |
        v
launcher -- esbuild browser composition -- plugin modules
        |
        v
loopback CDP -- addScript/evaluate -- Codex renderer
        |
        v
Cordis Context -- SlotService -- semantic slots -- Codex DOM adapter
        |                                  |
        +---- plugin fibers/effects -------+
```

### Launcher plane

The Node launcher owns configuration, plugin entry resolution, browser bundling, Codex process startup, CDP target discovery, injection identifiers, and cleanup. The browser bundle contains one Cordis copy and all enabled plugin modules so plugin contexts and services share one runtime identity.

The launcher binds CDP to `127.0.0.1`, records every `Page.addScriptToEvaluateOnNewDocument` identifier, and removes those identifiers on shutdown before asking the live page to dispose CordisX.

For UI development, the default command launches a second, directly tracked native process with a stable project-scoped Chromium `user-data-dir` and an ephemeral loopback CDP port. `HOME` and `CODEX_HOME` stay shared so authentication, conversations, projects, and model configuration remain available; the App main process, app-server stdio channel, renderer processes, UI storage, and window restoration remain separate. Direct spawning is equivalent to macOS `open -n` for instance isolation while retaining the child PID needed for deterministic cleanup. `--system` is the explicit escape hatch to the original profile.

Online Chrome DevTools support is opt-in. `--online-devtools` adds `https://chrome-devtools-frontend.appspot.com` to `--remote-allow-origins`; once connected, that origin has full renderer debugging authority for the isolated instance.

### Renderer plane

The injected bundle creates a new Cordis `Context`, mounts `SlotService` at `ctx.slots`, then mounts each configured plugin as a child fiber. A second injection first disposes the previous host. Plugin startup is fail-loud; already-started fibers unwind in reverse order if a later plugin fails.

The public plugin surface follows DeepSeek Harness: plugins declare `inject = ['slots']`, wait on a host declaration with `ctx.slots.inject(name, setup)`, and contribute with `ctx.slots.register({ name, id, order, priority }, component)`. Both methods install Cordis effects through the service proxy, so the caller's plugin fiber owns the registration. Unloading a plugin therefore removes its listeners, DOM, timers wrapped by the plugin, and slot registration on the same lifecycle axis. There is no parallel `ctx.cordisx.contribute()` facade.

### Slot plane

Plugins target semantic slot names. The host adapter declares the five root-scoped list slots for the renderer lifetime and alone translates each name into a current Codex DOM anchor and placement. `slots.inject()` therefore activates immediately in version 0.1 while retaining DSH's declaration-dependency syntax. A `MutationObserver` reconciles outlets after React replaces an anchor. When an outlet moves, the old component disposer runs before the contribution is mounted under the new anchor.

CordisX deliberately implements the DSH slot registration subset needed by an external DOM host: `name`, list-entry `id`, `order`, same-cell `priority` shadowing with lowest-live takeover, declaration injection, caller-fiber disposal, and mount remapping. DSH renders React components inside an owned React slot tree; CordisX cannot join Codex's private React tree, so its second `register()` argument is a DOM mount component receiving `{ container, document, signal, slot }`. Keyed, chain, child-declared, store, locale, and injected business-face seats remain deferred until a real CordisX use case requires them.

The first slot contract is deliberately small:

| Slot | Cardinality | Intended use |
|---|---:|---|
| `header.actions` | list | compact global actions |
| `composer.before` | list | session input helpers before the composer |
| `composer.after` | list | status or actions after the composer |
| `sidebar.footer` | list | persistent navigation-adjacent controls |
| `shell.overlay` | list | dialogs, toasts, inspectors, and floating panels |

The host may improve selectors without requiring plugin changes. Plugins that query Codex DOM directly opt out of that compatibility boundary.

## Trust and security

Version 0.1 uses a trusted-code model. A plugin is bundled into the renderer and can read or modify anything the renderer can access. Cordis provides lifecycle and dependency composition; it is not a security sandbox.

Before any public marketplace, CordisX needs a separate plugin execution realm, a capability/grant protocol, install-time source identity, CSP and network policy, and an explicit bridge for host operations. A manifest permission string without enforcement is not security and is intentionally absent from version 0.1.

## Compatibility strategy

Compatibility is owned by adapter probes rather than a single brittle selector. A resolver tries narrow stable attributes first, then structural fallbacks. If no candidate is found, the slot remains pending and does not modify the page. Plugin mount failures are contained to that contribution and shown in its outlet while other plugins continue.

Adapter releases should record the Codex versions they were tested against. Unknown versions may run in best-effort mode, but the launcher and future manager must present that state distinctly from verified compatibility.

The version-0.1 bundle and lifecycle were verified in a simulated renderer DOM. The installed 26.818.41509 host can also be exercised through an isolated second process, so live probes no longer require restarting the user's active application.

## Decisions deferred

- Whether the long-term distribution unit is an npm package, a signed archive, or a Codex universal plugin plus a CordisX-specific UI entry.
- Whether isolated UI should use an iframe, a dedicated Electron utility process, or both.
- Whether host replacement slots should allow one winner by priority or require an explicit user choice.
- How a plugin persists state across bundle rebuilds without receiving direct Codex storage access.
