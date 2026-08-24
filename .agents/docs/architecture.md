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

Dynamic package delivery evolves that composition into one stable Host runtime
plus independently built immutable plugin module generations. Configuration
live publication, owning-fiber restart, plugin dependency-closure replacement,
complete runtime-generation replacement, and app restart are separate apply
scopes. The package store, activation ledger, candidate/last-good transaction,
generation fencing, explicit-local directory/package/downloaded-tarball source
boundary, separate package/runtime manifests, staged registries, and atomic
closure publication order are specified in
[`dynamic-plugin-lifecycle.md`](dynamic-plugin-lifecycle.md). Until its runtime
slice lands, the single-bundle behavior in the next sections remains the
implemented current state.

The launcher implementation of that boundary is specified separately in
[`dynamic-package-store.md`](dynamic-package-store.md): it maps source-v1 and
package-v2 intake plus a Host-private journal/token/permission/rollback layer
onto the single package and activation stores implemented by the generation
runtime slice. It does not create another store/registry, switch renderer
generations, or render Manager UI.

The launcher binds CDP to `127.0.0.1`, records every `Page.addScriptToEvaluateOnNewDocument` identifier, and removes those identifiers on shutdown before asking the live page to dispose CordisX.

For UI development, the default command launches a second, directly tracked native process with a stable project-scoped Chromium `user-data-dir` and an ephemeral loopback CDP port. `HOME` and `CODEX_HOME` stay shared, so persisted authentication, conversation, project, and model-configuration data may be visible to both processes. That does not share request association, in-flight turns, subscriptions, approvals, current UI context, or live connection state. The App main process, app-server stdio channel, renderer processes, UI storage, and window restoration remain separate and can race as independent clients. Direct spawning is equivalent to macOS `open -n` for instance isolation while retaining the child PID needed for deterministic cleanup. `--system` is the explicit escape hatch to the original profile.

The second process is a UI development host, not a transparent platform bridge.
CordisX must not start another app-server to impersonate or replace the original
connection, and must not create a second AppHost that overwrites WebContents
registration. Reuse of a controlled existing connection remains experimental.
Until an official bridge or a safely controlled existing-connection adapter
exists, plugin-visible platform data is limited to read-only renderer snapshots.

The version-1 Platform capability architecture and its honest unavailable
default are specified in [`platform-capabilities.md`](platform-capabilities.md).
It introduces no second app-server and exposes no raw Desktop bridge.

Separately managed provider connections are specified in
[`multi-provider-sessions.md`](multi-provider-sessions.md). They run below a
launcher-owned Provider Fleet with provider-specific persistence and structured
session identity. They never claim to be the Desktop current connection. This
separation preserves the one-current-connection rule while allowing an
explicitly independent provider plugin to own its own Codex app-server and
conversation store.

The UI-neutral Agent event ledger, DSH-aligned messaging facade, permission
chain, and private Codex event adapter are specified in
[`agent-events.md`](agent-events.md). They share the Platform broker and host
adapter generation, retain only stable projection identities, and define no
Timeline, session header, DOM surface, or outlet.

Durable adapter history is a separate Node/Host read service specified in
[`agent-history.md`](agent-history.md). It gives plugins permission-scoped,
redacted Agent-v2 pages and opaque cursors without renderer filesystem access
or mutation of the live Agent ledger.

The plugin detail development Console, issuance-bound attribution, automatic
Host capability aspect, scoped console facade and explicit shared-renderer
blind spots are specified in
[`plugin-devtools-console.md`](plugin-devtools-console.md).

The Channel runtime is specified in
[`channel-runtime.md`](channel-runtime.md). It adds a launcher-owned Node
service extension point, durable inbox/outbox and binding core, and
Feishu/WeCom/WeChat adapters over the existing Platform/Agent authority. A
renderer plugin receives only a brokered snapshot/action API and controlled
manager/session surfaces; it never owns credentials, webhook/long-connection
transport, queues, cursors, or retry workers.

The host-neutral core, simulator, and source-bound Node Cordis `channel` service
are implemented. Plugin-package v3 / plugin-manifest v4 service entries are
source-validated, bundled for Node, included in the immutable package digest,
read back from the package store, resolved through the lifecycle authority, and
activated in a generation/source-bound Channel service context. Normal launcher
lifecycle orchestration of those service fibers and real transports remain
planned. The launcher-side package also validates
`cordisx.channel-service-config/v1` and generates the redacted
`cordisx.channel-service-config-descriptor/v1`. Connection credential fields are
restricted to opaque `keychain:` or `host-secret:` references and become only
readiness state in that descriptor. A service declaring `configuration.kind=none`
produces no placeholder document or Manager form. This Node service plane is
separate from renderer plugin Schemastery `Config`/`configApplies`: the built-in
Channel renderer module exports no Config and contributes only a structured
`manager.settings.navigation-items` record plus a same-owner
`manager.content` route and standard page. The Host now projects eligible B
records into its first-level navigation, renders the route-v2 navigation label
and the page-v3 standard header separately, and mounts a bounded child seat
only after same-owner, surface/outlet/page permission, generation, and route
checks. The internal Host body renderer consumes a bounded, redacted Channel
Manager projection for
read-only accounts, routes, composite task bindings, and diagnostics; it never
receives service configuration, `secretRef`, transports, queues, or credential
values. It presents a Host-owned searchable card list and card-detail tabs;
the only create result available before a Host writer exists is an explicitly
session-local, credential-free candidate, never an external connection. The
read-only Feishu target `cli_aaba90fcc4389cb3` is a known enabled test
application, not a connected account; no secret, callback, event subscription,
or external configuration is read or written by this renderer. Live launcher
projection, configuration writes, credential actions, and a single
launcher-to-Manager simulator orchestration remain planned. The
Channel config adapter consumes the shared
launcher service-configuration foundation: the closed manifest `restart`
declaration maps to `service-restart`, the schema is
`standard/renderable=false`, revision/generation/owner fencing and last-good
publication use the shared narrow API, and opaque credential handles are
preserved only launcher-side across non-secret updates.

Online Chrome DevTools support is opt-in. `--online-devtools` adds `https://chrome-devtools-frontend.appspot.com` to `--remote-allow-origins`; once connected, that origin has full renderer debugging authority for the isolated instance.

### Renderer plane

The injected bundle creates a new Cordis `Context`, mounts `SlotService` at `ctx.slots`, then mounts each configured plugin as a child fiber. A second injection first disposes the previous host. Plugin startup is fail-loud; already-started fibers unwind in reverse order if a later plugin fails.

The public plugin surface follows DeepSeek Harness: plugins declare injected
services and use `ctx.slots.inject/register` for structured shell data. Both
methods install Cordis effects through the service proxy, so the caller's fiber
owns every registration and update handle. There is no parallel
`ctx.cordisx.contribute()` facade.

### Slot plane

The five feasibility-era direct-DOM slots were removed together. Registrations
now contain only validated actions, navigation items, menu entries, sections,
rows, and update handles. The host owns DOM, styles, keyboard/a11y behavior,
loading/error projection, ordering, overflow, and cleanup.

Complex UI registers a page and route, then mounts only inside a declared
CordisX outlet. `app`, `main`, and `session.content` are initial host adapter
declarations, not a closed union. React anchor disconnection is only a
reconciliation signal: the same `contextKey` migrates the same outlet and page
state, while a changed key aborts/disposes the page. Native React nodes remain
in place, visible, and subscribed. The complete contract and test matrix live
in [`data-contribution-routing.md`](data-contribution-routing.md).

The current Codex session tree may retain a legacy thread drop-target around
the newer main-thread timeline seat. `session.content` treats that nesting as
one semantic region: one identity-matched current timeline seat wins, and the
legacy drop-target is considered only when no current seat exists. Multiple
matching seats at the same priority remain unavailable. This ordering is an
adapter compatibility rule, never a geometry or application-body fallback.

Structured shell surfaces are not page overlays. The private Codex adapter
projects them through minimal host-owned insertion seats in the resolved native
layout. Buttons sit before or after their semantic control, navigation rows
join the native list, and environment rows and sections join the native panel.
If a precise seat is unavailable the contribution remains pending; the adapter
does not fall back to a fixed covering card. Mutation repair may reinsert a
detached seat after React replaces its parent, but plugins never receive that
DOM.

The host-neutral surface/outlet vocabulary, current Codex adapter availability,
DeepSeek Harness intent mapping, explicit replacement refusals, contextual
identity boundary, PR order, and validation matrix are maintained in
[`ui-extension-catalog-codex-adapter.md`](ui-extension-catalog-codex-adapter.md).
The catalog distinguishes implemented, experimental, and reserved points;
protocol reservation is never evidence that the current Codex adapter can
project a point.

The manager-settings A compatibility pair remains host-neutral:
`manager.settings.tabs` accepts structured tab records and
`manager.settings.content` accepts same-owner routes/pages for controlled body
mounts. These are Manager extension points, not Codex adapter surfaces, and
require no selector or native anchor. The current product IA has no top-level
Settings destination, so both points remain registered and diagnosable but
report current context `not-mounted`; CordisX must not manufacture an empty
Settings page to project them. Their closed versions, point-policy identities,
Host-owned header boundary, and fallback semantics for a Host that does expose
Settings remain specified in
[`manager-settings-tabs.md`](manager-settings-tabs.md).

Catalog v4 adds the distinct B pair
`manager.settings.navigation-items` / `manager.content`. B inserts a
Host-rendered first-level Manager destination across the stable virtual
settings seam and opens a standard Manager page; no visible Host Settings row
is required. Its item contains only a same-owner route. Route v2 supplies
navigation title and description, while page v3 supplies the required Host
icon and standard header title/description/actions. The active destination
falls back to `host:plugins` when it becomes ineligible. A's stable id and
body-only outlet remain unchanged. The merge model, routing, lifecycle,
configuration planes, file-overlap audit, delivery order, and validation
matrix are normative in
[`manager-settings-navigation.md`](manager-settings-navigation.md).

Native menu contributions use the same boundary: CordisX inserts host-rendered
rows into the opened Codex Help or account menu and never adds an independent
fallback menu trigger. Compact shell actions are icon-only and inherit the
interaction pattern of adjacent native Codex controls. Their host-owned glyph
token reduces only the decorative SVG by four pixels while preserving the
existing wrapper, native button hit box, alignment, tooltip, focus, and
accessible name; the separately sized brand manager trigger and composer
toolbar appearance are excluded.

For `session.header.actions`, the host renders a new button inside its own
`no-drag` seat before the complete adjacent native control wrapper. A native
TooltipTrigger may use a `display: contents` wrapper; CordisX anchors beside
that wrapper and never inserts into it, delegates activation to it, or reuses
its tooltip. The CordisX tooltip is a body portal owned and disposed by the
current renderer generation. The same public host control boundary marks the
seat, icon button, and every rendered descendant as Electron `no-drag`; this is
shared by title-bar/header structured controls rather than implemented by an
Agent Trace selector or plugin listener. Native drag space stays outside the
seat, and the host verifies the button remains the pointer hit-test target.

Toolbar button state and spacing are also Host-owned. The renderer does not
copy a native reference button's `className`: Codex may add unconditional
pressed background/foreground utilities to that node, and copying the class
would project one native toggle's state onto every CordisX sibling. CordisX
uses a stable 28-pixel toolbar variant and projects idle, hover, focus-visible,
open, disabled, and route-toggle pressed states on each generated button. Only
an exact presented route produces `aria-pressed="true"` and the pressed style.
The Host-owned pressed semantic token uses the current theme text color at five
percent, with a ten-percent hover/open layer, primary foreground, the existing
focus ring, and 40-percent disabled opacity. It is scoped to the exact
generated button state rather than its toolbar seat, so no sibling or native
control is activated with it.
The independent `--cordisx-toolbar-action-gap` and
`--cordisx-toolbar-outer-group-gap` tokens are both verified as six pixels for
the current host: the first separates actions inside the CordisX seat and the
second separates the seat from the adjacent native summary toggle. Workspace
slot sizing continues to add only measured contribution widths to the native
minimum; it must not add `roots.length * gap`, so the verified two-root slot
remains 126 pixels and retains the native `ms-auto` alignment.

Route-backed controls may opt into protocol-v3 `toggle` behavior. The host
binds contextual session parameters, compares the exact owner-qualified route
and parameters with current outlet state, and projects `aria-pressed`; plugins
do not keep a parallel open boolean. Re-activation, Escape, policy close,
session change, plugin block, and generation disposal all converge on the same
outlet lifecycle. An explicit close restores focus to the still-connected
host-rendered trigger when practical.

Page-v2 `body-only` is a general structured chrome policy with a host outlet
gate. The current adapter accepts it only for `session.content`, whose overlay
begins below the retained native session header. The host does not create a
CordisX header/title/close row in that mode; `app` and `main` reject it because
they cover native chrome. No plugin can supply substitute header DOM, CSS, or a
selector.

Route and page outlets remain independent overlays. `app` paints through the
native title-bar and supplies its own draggable chrome with a macOS
traffic-light safe inset; `main` paints the entire region to the right of the
sidebar from `y=0` through a body-level portal and supplies draggable chrome
there. The portal avoids being trapped below the native main-toolbar stacking
context while its geometry still follows sidebar collapse and width changes.
Interactive controls are always explicit `no-drag` regions. This keeps native
window dragging and ordinary page controls from competing for the same
hit-test region.

Both chrome variants are the same host-owned structured projection. Plugins
declare only validated title/icon/breadcrumb/tab/action data, and header
actions reference commands that the host dispatches after checking the active
outlet policy. Plugins receive a body mount container, never a header seat,
node, component, or render callback. Covering the native header therefore
changes geometry only; it does not transfer shell rendering authority to the
plugin.

The host may improve selectors without requiring plugin changes. Plugins that query Codex DOM directly opt out of that compatibility boundary.

### Host-owned form plane

Host-owned configuration, import, Marketplace, permission, Provider, and
Channel forms share the scoped primitive, theme, validation, and state model in
[`host-form-system.md`](host-form-system.md). Plugins still provide structured
schema data and bounded custom field content only; they never receive a UI
library instance, form root, selector, CSS, or portal authority.

The Host bundles a reproducible subset of the official
`tdesign-web-components@1.2.10` Web Components implementation. It imports only
the supported controls, keeps component CSS in their open Shadow roots, scopes
base tokens to `.cxf-scope`, and attaches dropdowns to a CordisX-owned Shadow
portal. The full npm graph and global stylesheet are not installed. A thin
Host adapter supplies the missing accessibility/theme seams without a React
root or second schema registry. This is an implementation boundary, not a new
plugin contract.

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
- the structured registries attribute commands, surfaces, routes, pages, and
  outlets to the calling plugin fiber and report validation, context, and mount
  state.

Blocking a plugin disposes only that plugin's Cordis fiber, which reverses its
slot registrations and effects. Restoring it creates a fresh fiber from the
already bundled trusted module. The blocked-id set may be retained in renderer
storage for the current Chromium profile, but this is activation state rather
than package removal: module top-level code is already in the trusted bundle,
and the manager does not edit `cordisx.config.json`, install packages, enforce
permissions, or create a security boundary.

The dynamic lifecycle follow-up replaces renderer-local block state with a
launcher-owned profile activation record for package enable/disable. It keeps
explicit reload as an owning-fiber operation and uses plugin generations only
for code, entry, version, or dependency changes. The manager remains a brokered
projection and never receives filesystem or arbitrary module-loading authority.

The manager has five non-spoofable Host primary navigation views:

1. searchable installed-plugin inventory and local runtime controls;
2. semantic extension points with attributed plugin use and enforced policy;
3. routes/pages as a separate associated-resource inventory;
4. marketplace discovery from validated feeds; and
5. product identity, version, and verified external support links on About.

Eligible `manager.settings.navigation-items` records may join only on the two
sides of the virtual settings seam. They are independent plugin pages rather
than fixed Host views. Host core order and bottom-anchored About cannot be
overridden.

Manager-owned content follows one semantic context at a time: a title,
breadcrumb, or selected tab is not restated by body headings or redundant
cards. The reusable hierarchy, flat-list/card, exceptional-state,
accessibility, and visual-regression rules are normative in
[`manager-content-design.md`](manager-content-design.md).

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
failures and block/restore actions; `扩展点位` lists only attributed surface or
outlet use; and `路由` separately owns routes, pages, and their outlet
associations. Runtime status does not repeat route/page inventory. The launcher
reads the adjacent README while
composing the browser bundle so the renderer does not gain filesystem access.
The manager renders a deliberately limited Markdown subset by creating DOM
nodes and text nodes only: raw HTML is never interpreted, and remote media or
script execution is not supported. A missing README produces an explicit empty
state rather than synthesized package documentation.

Marketplace discovery adds a searchable catalog assembled from validated
feeds with a two-tab `概览` / `作者与来源` detail. Source management belongs to
the Plugin Store workflow rather than a general Manager Settings category.
The current IA removes the top-level `配置` destination and its empty
`运行状态` / `启动器` placeholders. The former settings-content extension
points remain registered compatibility identities with current context
`not-mounted`; the Host does not render a shell solely for them. Feed
aggregation keys
plugins by canonical `(source, id)` identity; the first configured feed wins a
duplicate. Source settings and blocked plugin ids are separate profile-local
state. Catalog entries can link to authors, their public source, optional
homepage, manifest/icon, and feed provenance, but cannot install or activate
code in this stage. External navigation first hides the manager modal and then
uses the browser's uncancelled `_blank` navigation with `noopener noreferrer`.

The primary manager navigation keeps Host `插件`, `扩展点`, `路由`, and
`插件商店` as separate top-level contexts. Eligible B entries are grouped on
the two sides of the stable virtual settings seam; there is no rendered
`配置` row. About remains anchored last. Searchable browse pages omit aggregate
result and usage counts. The content viewport is the single vertical scroll
owner and restores query/scroll state after a detail back action.

Configuration has two distinct application planes. CLI-resolved executable,
debug port, profile, launch environment, and other process-start values are
frozen for the current process and are not Manager global settings. Runtime
configuration stays in the owning plugin detail beside permissions and
declares `live`, `plugin-restart`, `service-restart`, or `app-restart`.
CLIProxy owns Provider configuration. A staged app-restart value does not
mutate the current fiber or watchers; service-restart requires an owning
launcher handler and is not downgraded to a plugin restart. Removing Manager
placeholders does not remove CLI parsing, launcher stores, or diagnostics.

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

Manifest metadata, dependency graphs, compatibility declarations, immutable
local packages, and activation transactions are the next staged delivery in
[`dynamic-plugin-lifecycle.md`](dynamic-plugin-lifecycle.md). Publisher
signatures, remote marketplace installation, and untrusted-code isolation
remain later security stages.

The Platform slice adds versioned capability declarations, an identity-bound
Permission Broker, and manager permission projections. These controls govern
cooperative `ctx.platform` calls only; package installation, signatures,
untrusted execution isolation, and marketplace activation remain later stages.

The multi-provider Platform slice routes every model and session operation by
structured provider-aware identity. Its launcher-private RPC exposes normalized
operations only; credentials, child processes, app-server messages, and raw
transport stay outside the renderer. An external provider becoming available
does not change the honest status of the native current-connection adapter.
The renderer adapter authenticates the narrow CDP binding with a per-launch
closure-bound token before any Platform operation is dispatched. Plugins use
only `ctx.platform`, so the Permission Broker retains canonical source identity,
composite requested session/model targets, policy outcome, and user-visible
audit state. This reduces accidental binding bypass inside the current trusted
renderer model; it is not a substitute for a future isolated plugin realm.

## Trust and security

Version 0.1 uses a trusted-code model. A plugin is bundled into the renderer and can read or modify anything the renderer can access. Cordis provides lifecycle and dependency composition; it is not a security sandbox.

Before any public marketplace installation, CordisX still needs a separate
plugin execution realm, publisher signatures and source identity, CSP and
network policy, and an explicit bridge for host operations. The current
Permission Broker controls cooperative Host services but does not sandbox
trusted renderer code. The local-only dynamic package stage must not describe
content hashing as publisher verification.

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
- A public signed-package source and transparency policy after the local-only
  package generation boundary is proven.
