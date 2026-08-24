# UI extension catalog and Codex adapter

Status: approved architecture and delivery contract. The catalog is
host-neutral. The availability column records the target state of the current
Codex adapter and must be reconciled with automated fixtures and an isolated
real-renderer report before a release claims a point is available.

## Outcome

CordisX exposes one versioned catalog of semantic UI extension points. Plugins
submit structured data, command references, and route references; the host
owns native-shell DOM, icon projection, style, accessibility, tooltips,
ordering, direct-action limits, overflow, native-menu integration, permission
checks, diagnostics, and generation cleanup.

Trusted-local page bodies are the only plugin callbacks that receive a mount
container, and that container belongs to a declared CordisX page outlet. A
surface never exposes a Codex selector, native node, React component, native
container, arbitrary HTML/SVG/CSS, popover implementation, or renderer
replacement callback.

The five feasibility-era free-DOM slots (`header.actions`, `composer.before`,
`composer.after`, `sidebar.footer`, and `shell.overlay`) remain retired. New
structured surfaces are neither aliases nor downgrade targets for those APIs.

## Catalog states

- **implemented**: the adapter has a unique semantic seat, deterministic
  projection and cleanup, automated replacement fixtures, and isolated live
  evidence for the supported host version.
- **experimental**: the protocol shape and adapter diagnostic exist, but the
  adapter keeps a contribution pending unless it resolves one unique native
  seat in the current state. Experimental never means overlay fallback.
- **reserved**: the host-neutral identity and payload family are documented so
  plugins do not invent incompatible names, but the Codex adapter does not
  declare or project the point.

Availability is adapter- and host-version-specific. A registered contribution
to an unavailable or ambiguous point is retained for diagnostics and is never
visually simulated.

The verified Codex/ChatGPT host `26.818.41509` (build `6962`) no longer emits
the earlier thread-reference marker for an active local session. The
`session.content` resolver therefore accepts either that exact legacy seat or
the exact current main-thread timeline seat, but only when one visible
candidate contains both the response annotation and composer identity for the
same selected local session. It does not fall back to the application body,
the generic main layout, localized labels, or geometry-only matching. A zero
or ambiguous result remains unavailable with the existing semantic-anchor
diagnostic.

## Payload families

The catalog uses a small set of shapes instead of one API per visual style:

1. **action** and **menu item**: `LocalizedText` label and optional accessible
   label, a host icon token, exactly one command or route activation, optional
   `group`, `order`, `when`, and disabled state, plus an optional surface-owned
   semantic `anchor` and `placement`.
2. **contextual action**: the same declared data, but invocation receives a
   frozen host-generated context. Plugins cannot submit, override, or smuggle
   workspace, session, turn, message, tool-call, item, step, or context
   identity through contribution data or command arguments. Every identity
   value is marked with its host provenance.
3. **tab**: localized title, optional host icon and badge, route reference,
   `order`, and `when`. The host owns selection, focus, navigation, overflow,
   and page projection.
4. **presenter**: one of `banner`, `status`, `chip`, or `progress`, with retained
   localized text, a bounded semantic tone, optional host icon, and optional
   command/route activation. Progress is a finite current/total pair. No
   presenter accepts markup, CSS, or a renderer callback.
5. **outlet**: a host declaration joined to a route and page. The trusted-local
   plugin mounts only the page body; CordisX renders chrome and owns abort,
   context migration, routing, and disposal.

Contribution-level `group`, `order`, `when`, and disabled state stay common.
The host decides how many direct actions fit and moves the remainder into its
own accessible overflow or an existing native menu. A plugin cannot demand a
new popover.

## Host-neutral catalog

The existing eleven surface ids and three outlets remain compatible. The
environment family is not duplicated under generic panel names.

| Family | Stable id | Payload | Codex adapter target | Safe-placement contract |
| --- | --- | --- | --- | --- |
| Session | `session.header.actions` | action | implemented | One host-owned action/utility group in the active session header; no whole-header replacement. |
| Session | `session.tabs` | tab | reserved | Future controlled view entry joined to route/page; never a native tab renderer callback. |
| Session | `session.banner.items` | presenter | reserved | Future bounded banner region associated with the active session. |
| Session | `session.message.actions` | contextual action | reserved | Requires a unique host message identity and an invocation-time context seat. |
| Session | `session.turn.footer` | presenter | reserved | Requires an observed turn identity and a unique turn-tail seat. |
| Session | `session.tool.actions` | contextual action | reserved | Requires an observed tool-call/item identity; no keyed tool renderer. |
| Composer | `composer.toolbar.items` | action | implemented | Semantic anchors `leading`, `model`, and `submit`; placements `before`, `after`, and only an existing native `menu`. The release proof covers `submit`/`before`. |
| Composer | `composer.command-menu.items` | menu item | experimental | Project only into the unique open native command menu; never create a CordisX command-menu trigger. |
| Composer | `composer.dock.above` | presenter | experimental | Pending unless one active composer and its session identity resolve uniquely. |
| Composer | `composer.dock.below` | presenter | experimental | Same as above; no fixed overlay below the window. |
| Sidebar | `sidebar.footer.before-control` | action | implemented | Existing compact action seat before the designated footer control. |
| Sidebar | `sidebar.footer.after-control` | action | implemented | Existing compact action seat after the designated footer control. |
| Sidebar | `sidebar.footer.menu` | menu item | implemented | Existing native footer/help menu only. |
| Sidebar | `sidebar.account.menu` | menu item | implemented | Existing native account/profile menu only. |
| Sidebar | `sidebar.navigation.items` | navigation item | implemented | Existing host-rendered row with independent trailing actions. |
| Sidebar | `sidebar.workspace.menu` | menu item | experimental | Unique native workspace switcher and its open menu are required. |
| Sidebar | `sidebar.session.actions` | contextual action | reserved | Requires a unique row/session identity and bounded direct-action capacity. |
| Sidebar | `sidebar.session.menu` | contextual menu item | reserved | Requires the native session-row menu; no standalone menu. |
| Workspace | `workspace.toolbar.items` | action | implemented | Existing workspace semantic anchor and before/after/native-menu placement. |
| Panels | `panel.right.header-actions` | action | experimental | Unique visible right-panel header required; environment aliases are forbidden. |
| Panels | `panel.right.tabs` | tab | reserved | Host-owned tabs joined to routes/pages, only after a stable header/content split is proven. |
| Panels | `panel.bottom.header-actions` | action | experimental | Unique visible bottom-panel header required. |
| Panels | `panel.bottom.tabs` | tab | reserved | Same controlled-tab contract as the right panel. |
| Environment | `environment.panel.header-actions` | action | implemented | Existing environment-panel header contract. |
| Environment | `environment.panel.sections` | environment section | implemented | Existing environment-panel section contract. |
| Environment | `environment.section.actions` | action | implemented | Existing declared-section target. |
| Environment | `environment.section.rows` | environment row | implemented | Existing declared-section row target. |
| Environment | `environment.row.trailing-actions` | action | implemented | Existing declared-row target. |
| CordisX manager | `manager.settings.tabs` | manager settings tab | planned v3 | Host-rendered configuration tabs joined to same-owner manager-local routes/pages; no Codex selector or header callback. |
| Page | `app` | outlet | implemented | Existing generation-scoped renderer page. |
| Page | `main` | outlet | implemented | Existing semantic main-region page following sidebar geometry. |
| Page | `session.content` | outlet | implemented | Existing active-session body page below the session header. |
| Panel page | `panel.right.content` | outlet | reserved | No declaration until the adapter proves a stable right-panel content region and context key. |
| Panel page | `panel.bottom.content` | outlet | reserved | No declaration until the adapter proves a stable bottom-panel content region and context key. |
| CordisX manager page | `manager.settings.content` | outlet | planned v3 | CordisX-owned settings panel body; isolated from primary page presentation and independent of the Codex adapter. |

An adapter may report an experimental point as pending with a machine code,
but it must not add it to the live declared catalog as available merely because
a protocol id exists. Reserved outlets are valid future route targets only in
the version that declares them; current navigation fails closed.

`planned v3` is an architecture-only marker, not a protocol availability
value. Until the v3 protocol and host slices merge and pass the required live
evidence, the current runtime does not declare either manager-settings point.

## Contextual invocation

The surface descriptor contains no live native identity. On activation the
adapter resolves a fresh read-only context and the runtime freezes it before
dispatch:

```ts
interface HostInvocationContext {
  readonly generation: string
  readonly contextRef: string
  readonly pointId: string
  readonly contributionId: string
  readonly commandId: string
  readonly provenance: 'observed' | 'cordisx' | 'inferred'
  readonly source: Readonly<{
    kind: 'adapter' | 'cordisx'
    adapterId?: string
    adapterVersion?: string
    hostId?: string
    component?: string
  }>
  readonly identity: Readonly<{
    workspaceRef?: string
    agent?: Readonly<{
      sessionKey: string
      turnId?: string
      stepId?: string
      itemId?: string
      messageId?: string
      toolCallId?: string
    }>
    platformSession?: Readonly<{
      providerId: string
      remoteSessionId: string
    }>
    contextId?: string
  }>
}
```

The provider-neutral Agent `sessionKey` is distinct from a Platform session's
`(providerId, remoteSessionId)` composite identity. A naked session id is never
interpreted as globally unique across providers. These opaque identities align
with `cordisx.agent-events/v1`; they do not add a Timeline or infer missing
hierarchy. Codex `additionalContext` and private adapter fields are excluded.
The command dispatcher accepts context only from its private host-origin
channel. Plugin command arguments remain ordinary immutable JSON and a key that
resembles an identity never becomes host context.

## DeepSeek Harness intent mapping and refusal

| DeepSeek Harness intent | CordisX contract | Boundary |
| --- | --- | --- |
| `input.left` / `input.right` | `composer.toolbar.items` | Semantic anchor and placement; host-rendered action only. |
| input/composer dock | `composer.dock.above` / `composer.dock.below` | Finite presenters; no plugin DOM in Codex shell. |
| session header actions/utilities | `session.header.actions` | `group=action` or `group=utility`; host decides direct/overflow layout. |
| `conversation.view` | route/page plus `session.tabs` and `session.content` | Page body mounts only in the controlled outlet. |
| assistant actions | `session.message.actions` | Host-generated message context; no message node. |
| `turnTail` | `session.turn.footer` | Structured presenter with turn context; no tail component. |
| `details.tool` | right-panel route/outlet plus `session.tool.actions` | Reserved until stable right-panel and tool identity seats exist. |
| settings sections | `manager.settings.tabs` plus `manager.settings.content` | Host-neutral CordisX manager points; structured header plus controlled page body, never a Codex shell selector. |
| keyed chat/message/tool renderers | refused | No keyed renderer or native-node replacement registry. |
| whole composer/session/header/chat replacement | refused | CordisX does not grant native React ownership. |

The adapter also refuses selector strings, Codex DOM/container references,
arbitrary HTML/SVG/CSS, plugin-owned tooltips, plugin-owned overflow/popovers,
and replacements for composer, session header, chat nodes, messages, or tool
renderers. Future replacement work requires a CordisX-owned complete wrapper
and a separate presentation registry; it cannot be smuggled through a surface.

## Delivery and PR boundaries

1. **Architecture (`cordisx`)**: this catalog, compatibility/refusal table,
   adapter state model, dependency order, and validation matrix.
2. **Protocol (`cordisx-protocol`)**: versioned catalog vocabulary, structured
   payload families, contextual invocation origin, schemas, fixtures, and
   conformance. The branch starts from the merged Agent event contract so its
   identity vocabulary is preserved.
3. **Host fixed head (`cordisx`)**: matching public types, registry validation,
   permission/origin enforcement, host projection, adapter fixtures, and the
   two required implemented points. This head is the dependency for consumers
   such as Agent Trace Showcase.
4. **Codex adapter completion (`cordisx`)**: experimental probes remain
   fail-pending, diagnostics are exposed, and real-renderer smoke produces
   screenshots and a machine-readable report.
5. **Owning PRs and mono**: merge protocol and host through normal CI, then pin
   exact merged commits in one separate CordisXMono PR. `roadmap` remains
   `update = none`.

## Validation matrix

| Layer | Required evidence |
| --- | --- |
| Protocol | Accept every catalog id and payload family; reject free DOM, selector/HTML/SVG/CSS, arbitrary icons, invalid anchor/placement, spoofed context, unknown schema versions, and invalid status transitions; preserve Agent identity vocabulary. |
| Registry/runtime | Ownership and source binding, deterministic group/order, direct/overflow partition, native-menu-only projection, command/route resolution, point policy at render and invoke, frozen dynamic context, plugin-argument non-spoofing, `when`/disabled, update-after-dispose, locale reprojection, owner unload, block/restore, and renderer-generation cleanup. |
| Adapter fixtures | Unique/pending/ambiguous anchors; native anchor replacement; sidebar collapse/resize; composer idle, busy, disabled, and send state; session switch; right/bottom panel absence and presence; no fallback overlay. |
| Real renderer | Isolated `app://` report and screenshots prove `session.header.actions` and `composer.toolbar.items` at `submit`/`before` are real sibling layout insertion, not overlay; native nodes retain identity, parent, visibility, and subscription; tooltip, `no-drag`, titlebar safe inset, policy hide/restore, plugin block/restore, and generation disposal pass. |
| Release | Focused tests, typecheck/build/full check, clean diff, pushed commits, normal PR checks and merges, compatible mono gitlinks only, and unchanged roadmap update policy. |

The smoke report records the Codex application version, adapter revision,
resolved seat identities, contribution ids, DOM relationship (`before` or
`after`), computed geometry, overlay/reparent/hide mutation counts, native-node
identity checks, policy/block/generation cleanup results, screenshots, and an
explicit result for every experimental/reserved point. A screenshot without
the report is insufficient evidence.
