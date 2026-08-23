# CordisX architecture

## Goal

CordisX lets trusted local plugins augment the Codex Desktop interface without modifying the installed application or replacing native React content. It is a UI-host project, not an alternative agent loop and not an authentication or API relay.

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

For UI development, the default command launches a second, directly tracked native process with a stable project-scoped Chromium `user-data-dir` and an ephemeral loopback CDP port. `HOME` and `CODEX_HOME` stay shared, so persisted authentication, conversation, project, and model-configuration data may be visible to both processes. That does not share request association, in-flight turns, subscriptions, approvals, current UI context, or live connection state. The App main process, app-server stdio channel, renderer processes, UI storage, and window restoration remain separate and can race as independent clients. Direct spawning is equivalent to macOS `open -n` for instance isolation while retaining the child PID needed for deterministic cleanup. `--system` is the explicit escape hatch to the original profile.

The second process is a UI development host, not a transparent platform bridge.
CordisX must not start another app-server to impersonate or replace the original
connection, and must not create a second AppHost that overwrites WebContents
registration. Reuse of a controlled existing connection remains experimental.
Until an official bridge or a safely controlled existing-connection adapter
exists, plugin-visible platform data is limited to read-only renderer snapshots.

Online Chrome DevTools support is opt-in. `--online-devtools` adds `https://chrome-devtools-frontend.appspot.com` to `--remote-allow-origins`; once connected, that origin has full renderer debugging authority for the isolated instance.

### Renderer plane

The injected bundle creates a new Cordis `Context`, mounts `SlotService` at `ctx.slots`, then mounts each configured plugin as a child fiber. A second injection first disposes the previous host. Plugin startup is fail-loud; already-started fibers unwind in reverse order if a later plugin fails.

The public plugin surface follows DeepSeek Harness: plugins declare `inject = ['slots']`, wait on a host declaration with `ctx.slots.inject(name, setup)`, and contribute with `ctx.slots.register({ name, id, order, priority }, component)`. Both methods install Cordis effects through the service proxy, so the caller's plugin fiber owns the registration. Unloading a plugin therefore removes its listeners, DOM, timers wrapped by the plugin, and slot registration on the same lifecycle axis. There is no parallel `ctx.cordisx.contribute()` facade.

### Slot plane

> Migration note: the version-0.1 free-DOM slot implementation below records
> the current feasibility baseline. The approved next contract is documented in
> [`data-contribution-routing.md`](data-contribution-routing.md). It replaces
> direct plugin DOM mounts in all five native-shell slots with structured,
> host-rendered contributions. Complex plugin DOM is restricted to declared
> CordisX page outlets. The migration is intentionally one-way during the
> experimental stage; the same shell semantic is not exposed through both old
> and new facades.

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

These five direct-DOM semantics are experimental and scheduled for removal by
the structured-contribution slice. They are not a compatibility promise.

The host may improve selectors without requiring plugin changes. Plugins that query Codex DOM directly opt out of that compatibility boundary.

### Built-in manager plane

The local plugin manager is host chrome, not a plugin contribution and not a
new public slot. Its trigger is mounted beside Codex's workspace switcher by a
private adapter probe, and a mutation observer remounts it when the host React
tree replaces that row. The manager and every listener, observer, and DOM node
it creates are disposed with the CordisX renderer generation.

The manager reads a runtime-owned snapshot rather than scraping plugin UI. The
snapshot joins three internal sources:

- build metadata supplies the CordisX package version;
- the runtime tracks each bundled plugin module, Cordis fiber, configuration,
  and active or blocked state;
- the slot registry attributes registrations to the calling plugin fiber and
  reports their semantic slot, entry id, priority, order, and mounted state.

Blocking a plugin disposes only that plugin's Cordis fiber, which reverses its
slot registrations and effects. Restoring it creates a fresh fiber from the
already bundled trusted module. The blocked-id set may be retained in renderer
storage for the current Chromium profile, but this is activation state rather
than package removal: module top-level code is already in the trusted bundle,
and the manager does not edit `cordisx.config.json`, install packages, enforce
permissions, or create a security boundary.

The initial manager has three navigation views:

1. CordisX runtime and version information;
2. semantic extension points with their currently active plugin contributions;
3. searchable plugin inventory, runtime blocking/restoration, and details
   derived from module/configuration data available today.

Plugin inventory is a list page rather than a permanent list/detail split.
Selecting a plugin opens a second-level detail page inside the manager; its
header provides an icon-only back action and the breadcrumb `插件 / <name>`.
Every manager header reserves one fixed-size leading slot: a primary page puts
its page glyph in that slot, while a second- or third-level page replaces the
glyph with the back action. Both controls share the same geometry, so changing
levels never moves the title horizontally. The back action has an accessible
name without visible text. Returning preserves the list search query. The same
list-to-detail navigation pattern is used by marketplace discovery so dense
details do not crowd catalog results.

Installed plugin detail is local tab navigation inside that second-level page,
not another semantic extension point. Its default `README` tab renders the
plugin's adjacent `README.md`; `配置管理` shows the configuration available to
the current bundle; `运行状态` owns activation state, injected services,
failures, and block/restore actions; and `扩展点位` lists attributed slot
registrations and mount state. The launcher reads the adjacent README while
composing the browser bundle so the renderer does not gain filesystem access.
The manager renders a deliberately limited Markdown subset by creating DOM
nodes and text nodes only: raw HTML is never interpreted, and remote media or
script execution is not supported. A missing README produces an explicit empty
state rather than synthesized package documentation.

Marketplace discovery adds two manager views without adding execution
authority: a searchable catalog assembled from validated feeds, and a general
CordisX settings view whose first editable section owns the ordered list of
marketplace JSON URLs and profile-local block state. The settings page is also
local tab navigation: `插件商店` owns feed URLs, `运行状态` explains the
profile-local activation state, and `启动器` exposes the current read-only
`cordisx.config.json` boundary. Launcher-owned composition fields remain visibly
file-managed until generation-aware configuration writes exist. Feed aggregation keys
plugins by canonical `(source, id)` identity; the first configured feed wins a
duplicate. Source settings and blocked plugin ids are separate profile-local
state. Catalog entries can link to their public source but cannot install or
activate code in this stage.

Codex's `app://` renderer rejects direct arbitrary network reads, including the
official raw GitHub feed. The launcher therefore owns a narrow, private CDP
binding for marketplace JSON retrieval. It accepts only configured public
HTTPS URLs, resolves and rejects non-public network addresses, follows a small
number of individually revalidated HTTPS redirects, applies timeout/response
size/concurrency limits, and returns text to the manager for protocol
validation. The binding is reserved host infrastructure rather than a plugin
API and catalog code is never evaluated. This reserved name is not capability
enforcement: plugins are still trusted renderer code and can inspect globals,
so the public-HTTPS, address, redirect, concurrency, timeout, and size limits
are damage-reduction boundaries rather than isolation from a malicious bundled
plugin.

Manifest metadata, dependency graphs, compatibility declarations, persisted
launcher configuration, package installation/update/removal, capabilities,
signatures, and marketplace operations remain later delivery stages.

## Trust and security

Version 0.1 uses a trusted-code model. A plugin is bundled into the renderer and can read or modify anything the renderer can access. Cordis provides lifecycle and dependency composition; it is not a security sandbox.

Before any public marketplace, CordisX needs a separate plugin execution realm, a capability/grant protocol, install-time source identity, CSP and network policy, and an explicit bridge for host operations. A manifest permission string without enforcement is not security and is intentionally absent from version 0.1.

## Compatibility strategy

Compatibility is owned by adapter probes rather than a single brittle selector. A resolver tries narrow stable attributes first, then structural fallbacks. If no candidate is found, the slot remains pending and does not modify the page. Plugin mount failures are contained to that contribution and shown in its outlet while other plugins continue.

Adapter releases should record the Codex versions they were tested against. Unknown versions may run in best-effort mode, but the launcher and future manager must present that state distinctly from verified compatibility.

The built-in manager trigger follows the same rule: its workspace-switcher
probe stays in the host adapter, remains pending when no unique visible target
exists, and must not make plugins depend on Codex-owned class names.

The version-0.1 bundle and lifecycle were verified in a simulated renderer DOM. The installed 26.818.41509 host can also be exercised through an isolated second process, so live probes no longer require restarting the user's active application.

## Decisions deferred

- Whether the long-term distribution unit is an npm package, a signed archive, or a Codex universal plugin plus a CordisX-specific UI entry.
- Whether isolated UI should use an iframe, a dedicated Electron utility process, or both.
- Whether a future explicitly declared host-replacement protocol should allow one winner or require an explicit user choice; the structured-contribution slice does not expose replacement slots.
- How a plugin persists state across bundle rebuilds without receiving direct Codex storage access.
