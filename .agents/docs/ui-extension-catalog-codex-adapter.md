# UI extension catalog and Codex adapter

Status: approved architecture and delivery contract. The catalog is
host-neutral. Catalog v6 records maturity and release-level adapter support;
runtime context v1 separately records whether a seat is active, inactive, or
not mounted on the current page. Automated fixtures and an isolated
real-renderer report remain required before a release claims support.

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

## Catalog and runtime state axes

- **stable / experimental / reserved** is contract maturity. It does not say
  whether a DOM seat happens to be mounted now.
- **supported**: the adapter has a unique semantic seat, deterministic
  projection and cleanup, automated replacement fixtures, and isolated live
  evidence for the supported host version.
- **unverified / unsupported** states release-level adapter support. Unverified
  includes an experimental seat without release proof or a correct-context
  resolver that observes zero or multiple candidates. Unsupported includes a
  reserved point that this adapter intentionally does not project.
- **active / inactive / not-mounted** is current context only. Manager or a
  non-session page legitimately makes session/composer points not mounted; an
  unopened environment panel is also not mounted. None of those observations
  downgrades a supported descriptor or creates a warning in the primary list.

Adapter support is adapter- and host-version-specific. A registered
contribution to an unsupported, unverified, inactive, or ambiguous point is
retained for diagnostics and is never visually simulated.

The verified Codex/ChatGPT host `26.818.41509` (build `6962`) can emit the
earlier thread-reference marker around the exact current main-thread timeline
seat for an active local session. A route-backed action may use the version-3
host toggle projection; the button's pressed state comes from the exact active
route and current session parameters, never plugin state. The `session.content` resolver accepts both
shapes, but resolves them by semantic priority rather than counting the nested
ancestor and descendant as two independent seats: exactly one current timeline
seat containing both the response annotation and composer identity for the
same selected local session wins; the exact legacy seat is considered only
when no matching current timeline seat exists. It does not fall back to the
application body, the generic main layout, localized labels, or geometry-only
matching. Zero or multiple candidates at the selected priority remain
unavailable with the existing semantic-anchor diagnostic.

### Composer action visual variant

The verified composer action cluster separates neutral utility controls from
the high-emphasis native submit/queue/stop control. A CordisX action anchored
at `submit` with `placement: before` therefore uses a host-owned composer
utility variant; it must not copy the native submit control's solid background,
opacity, or send-state classes.

For host `26.818.41509` (build `6962`), the variant follows the adjacent native
model/language and dictation controls: a 28 by 28 pixel circular hit target, a
16 pixel centered host-token icon, transparent idle background, tertiary
foreground, primary-ghost hover/open background, two-pixel focus-visible ring,
and 40 percent disabled opacity. The native action-cluster gap remains the
source of spacing between the CordisX seat and the native control. Multiple
CordisX actions use the same gap inside the seat, with the host-owned direct
limit and overflow trigger preserving the 28-pixel variant at narrow widths.

The insertion seat remains an immediate sibling before the complete native
submit/queue/stop control. It does not enter a native tooltip wrapper, proxy a
native click, or inspect and reproduce the current send-state icon. The Host
owns the button DOM, style tokens, body-portal tooltip, accessibility name,
disabled/loading projection, no-drag behavior, overflow, and reattachment when
Codex React replaces either the terminal native control or its action cluster.

### Toolbar action state and spacing

The titlebar variants use Host-owned state rules rather than cloning an
adjacent native button's classes. A native `aria-pressed` toggle may acquire
unconditional active background and foreground utilities; those classes are
never copied into CordisX actions. Every generated button carries its bound
owner, surface, and qualified contribution identity, while only an exact
Host-projected route toggle may carry `aria-pressed="true"` and
`data-cordisx-route-state="presented"`. Idle siblings remain transparent;
hover, focus-visible, open, and disabled presentation is evaluated on the
individual generated button.

The Host has separate icon-control variants per semantic seat. The current
workspace and session toolbar variant is a 28 by 28 pixel target with a
centered 16-pixel glyph and the resolved adjacent native control's corner
radius; the Composer submit-adjacent variant remains circular. Toolbar idle,
hover/open, pressed, focus-visible, and disabled tokens are scoped to the
generated toolbar root, including its Host overflow summary. The semantic
pressed token mixes the native theme text color
at five percent over transparency, matching the adjacent pinned-summary control
without copying its private class. A hovered or open pressed control uses the
same text color at ten percent. Pressed foreground uses the primary text token;
focus-visible keeps the shared two-pixel ring and disabled keeps 40
percent opacity. These tokens apply only to the generated button whose exact
route is presented; neither its CordisX siblings nor the adjacent native
control inherit them.

For the current host, independent actions inside a CordisX titlebar seat use
the six-pixel `--cordisx-toolbar-action-gap`. The seat uses a separate
six-pixel `--cordisx-toolbar-outer-group-gap` before the adjacent native
pinned-summary toggle. These values do not change the workspace toolbar's
outer group contract: its native six-pixel group gap and `ms-auto` layout stay
intact, and the two 28-pixel CordisX roots still extend the 70-pixel native
slot to exactly 126 pixels. Slot reconciliation adds measured root widths only
and never reintroduces a per-root gap surcharge.

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
6. **Manager settings content tab**: the existing A item retains localized
   title, Host icon, and same-owner route while CordisX renders the Settings
   tablist and body-only panel.
7. **Manager settings navigation item**: the B item contains only a same-owner
   route. Required before/after Settings group and envelope order place it;
   route v2 supplies navigation title/description and page v3 supplies the
   required Host icon plus standard header metadata.

Contribution-level `group`, `order`, `when`, and disabled state stay common
unless a point closes them more narrowly: A rejects group, while B requires
exactly `before-settings` or `after-settings`.
The host decides how many direct actions fit and moves the remainder into its
own accessible overflow or an existing native menu. A plugin cannot demand a
new popover.

## Host-neutral catalog

The existing eleven surface ids and three outlets remain compatible. The
environment family is not duplicated under generic panel names.

| Family               | Stable id                           | Payload                          | Codex adapter target          | Safe-placement contract                                                                                                                                                                                                              |
| -------------------- | ----------------------------------- | -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session              | `session.header.actions`            | action                           | implemented                   | One host-owned action/utility group in the active session header; no whole-header replacement.                                                                                                                                       |
| Session              | `session.tabs`                      | tab                              | reserved                      | Future controlled view entry joined to route/page; never a native tab renderer callback.                                                                                                                                             |
| Session              | `session.banner.items`              | presenter                        | reserved                      | Future bounded banner region associated with the active session.                                                                                                                                                                     |
| Session              | `session.message.actions`           | contextual action                | reserved                      | Requires a unique host message identity and an invocation-time context seat.                                                                                                                                                         |
| Session              | `session.turn.footer`               | presenter                        | reserved                      | Requires an observed turn identity and a unique turn-tail seat.                                                                                                                                                                      |
| Session              | `session.tool.actions`              | contextual action                | reserved                      | Requires an observed tool-call/item identity; no keyed tool renderer.                                                                                                                                                                |
| Session              | `session.backdrop`                  | session-backdrop presentation    | implemented                   | Host projects one pointer-inert ambience layer and one embedded transparent portrait behind the active session. The native reasoning value is the only driver; plugins cannot provide selectors, CSS, URLs, or executable renderers. |
| Composer             | `composer.toolbar.items`            | action                           | implemented                   | Semantic anchors `leading`, `model`, and `submit`; placements `before`, `after`, and only an existing native `menu`. The release proof covers `submit`/`before`.                                                                     |
| Composer             | `composer.reasoning-intensity`      | reasoning-intensity presentation | implemented                   | Host projects one uniquely visible native range without replacing its values, events, focus, keyboard behavior, or accessible name. The plugin supplies only ordered semantic material stages.                                       |
| Composer             | `composer.command-menu.items`       | menu item                        | experimental                  | Project only into the unique open native command menu; never create a CordisX command-menu trigger.                                                                                                                                  |
| Composer             | `composer.dock.above`               | presenter                        | experimental                  | Pending unless one active composer and its session identity resolve uniquely.                                                                                                                                                        |
| Composer             | `composer.dock.below`               | presenter                        | experimental                  | Same as above; no fixed overlay below the window.                                                                                                                                                                                    |
| Sidebar              | `sidebar.footer.before-control`     | action                           | implemented                   | Existing compact action seat before the designated footer control.                                                                                                                                                                   |
| Sidebar              | `sidebar.footer.after-control`      | action                           | implemented                   | Existing compact action seat after the designated footer control.                                                                                                                                                                    |
| Sidebar              | `sidebar.footer.menu`               | menu item                        | implemented                   | Existing native footer/help menu only.                                                                                                                                                                                               |
| Sidebar              | `sidebar.account.menu`              | menu item                        | implemented                   | Existing native account/profile menu only.                                                                                                                                                                                           |
| Sidebar              | `sidebar.navigation.items`          | navigation item                  | implemented                   | Existing host-rendered row with independent trailing actions.                                                                                                                                                                        |
| Sidebar              | `sidebar.workspace.menu`            | menu item                        | experimental                  | Unique native workspace switcher and its open menu are required.                                                                                                                                                                     |
| Sidebar              | `sidebar.session.actions`           | contextual action                | reserved                      | Requires a unique row/session identity and bounded direct-action capacity.                                                                                                                                                           |
| Sidebar              | `sidebar.session.menu`              | contextual menu item             | reserved                      | Requires the native session-row menu; no standalone menu.                                                                                                                                                                            |
| Workspace            | `workspace.toolbar.items`           | action                           | implemented                   | Existing workspace semantic anchor and before/after/native-menu placement.                                                                                                                                                           |
| Panels               | `panel.right.header-actions`        | action                           | experimental                  | Unique visible right-panel header required; environment aliases are forbidden.                                                                                                                                                       |
| Panels               | `panel.right.tabs`                  | tab                              | reserved                      | Host-owned tabs joined to routes/pages, only after a stable header/content split is proven.                                                                                                                                          |
| Panels               | `panel.bottom.header-actions`       | action                           | experimental                  | Unique visible bottom-panel header required.                                                                                                                                                                                         |
| Panels               | `panel.bottom.tabs`                 | tab                              | reserved                      | Same controlled-tab contract as the right panel.                                                                                                                                                                                     |
| Environment          | `environment.panel.header-actions`  | action                           | implemented                   | Existing environment-panel header contract.                                                                                                                                                                                          |
| Environment          | `environment.panel.sections`        | environment section              | implemented                   | Existing environment-panel section contract.                                                                                                                                                                                         |
| Environment          | `environment.section.actions`       | action                           | implemented                   | Existing declared-section target.                                                                                                                                                                                                    |
| Environment          | `environment.section.rows`          | environment row                  | implemented                   | Existing declared-section row target.                                                                                                                                                                                                |
| Environment          | `environment.row.trailing-actions`  | action                           | implemented                   | Existing declared-row target.                                                                                                                                                                                                        |
| CordisX manager      | `manager.settings.tabs`             | manager settings content tab     | implemented v4; compatible v5 | Host-rendered content tabs inside Settings joined to same-owner manager-local routes/pages; stable point id, no Codex selector or header callback.                                                                                   |
| CordisX manager      | `manager.settings.navigation-items` | manager settings navigation item | planned v5 Host               | Route-only first-level plugin destinations grouped immediately before/after Host Settings; no Codex selector or plugin row renderer.                                                                                                 |
| Page                 | `app`                               | outlet                           | implemented                   | Existing generation-scoped renderer page.                                                                                                                                                                                            |
| Page                 | `main`                              | outlet                           | implemented                   | Existing semantic main-region page following sidebar geometry.                                                                                                                                                                       |
| Page                 | `session.content`                   | outlet                           | implemented                   | Active-session body page below the retained native header; supports host-gated page-v2 `body-only` chrome.                                                                                                                           |
| Panel page           | `panel.right.content`               | outlet                           | reserved                      | No declaration until the adapter proves a stable right-panel content region and context key.                                                                                                                                         |
| Panel page           | `panel.bottom.content`              | outlet                           | reserved                      | No declaration until the adapter proves a stable bottom-panel content region and context key.                                                                                                                                        |
| CordisX manager page | `manager.settings.content`          | outlet                           | implemented v4                | CordisX-owned body-only Settings tab panel; isolated from primary page presentation and independent of the Codex adapter.                                                                                                            |
| CordisX manager page | `manager.content`                   | outlet                           | planned v5 Host               | Standard CordisX Manager page shell/body for B routes; presentation group `manager`, route family `manager`, no Codex adapter seat.                                                                                                  |

An adapter may report an experimental point as pending with a machine code,
but it must not add it to the live declared catalog as available merely because
a protocol id exists. Reserved outlets are valid future route targets only in
the version that declares them; current navigation fails closed.

`planned v5 Host` is an architecture/Host-delivery marker, not a protocol
availability value. The A pair is already declared. The B pair becomes
available only after the Host consumes formal Protocol `f350899` and passes its
automated plus real-renderer evidence; protocol existence alone does not make
it a Codex adapter surface or permit an overlay fallback.

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

| DeepSeek Harness intent                        | CordisX contract                                           | Boundary                                                                                                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.left` / `input.right`                   | `composer.toolbar.items`                                   | Semantic anchor and placement; host-rendered action only.                                                                                                                                             |
| native reasoning intensity                     | `composer.reasoning-intensity`                             | Host-owned visual projection over the native range; no plugin selector, DOM, CSS, or setting semantics.                                                                                               |
| reasoning-driven session ambience              | `session.backdrop`                                         | Host-owned code-native backdrop plus one bounded embedded PNG portrait per stage; it retains the last observed stage while the native menu is closed and clears on session change or plugin disposal. |
| input/composer dock                            | `composer.dock.above` / `composer.dock.below`              | Finite presenters; no plugin DOM in Codex shell.                                                                                                                                                      |
| session header actions/utilities               | `session.header.actions`                                   | `group=action` or `group=utility`; host decides direct/overflow layout.                                                                                                                               |
| `conversation.view`                            | route/page plus `session.tabs` and `session.content`       | Page body mounts only in the controlled outlet.                                                                                                                                                       |
| assistant actions                              | `session.message.actions`                                  | Host-generated message context; no message node.                                                                                                                                                      |
| `turnTail`                                     | `session.turn.footer`                                      | Structured presenter with turn context; no tail component.                                                                                                                                            |
| `details.tool`                                 | right-panel route/outlet plus `session.tool.actions`       | Reserved until stable right-panel and tool identity seats exist.                                                                                                                                      |
| Settings content switcher                      | `manager.settings.tabs` plus `manager.settings.content`    | A: Host-rendered tabs inside Settings plus controlled body-only content; never a Codex shell selector.                                                                                                |
| top-level Manager plugin destination           | `manager.settings.navigation-items` plus `manager.content` | B: Host-rendered left-navigation row, route-v2 text, page-v3 standard header/body; no plugin DOM or Codex selector.                                                                                   |
| keyed chat/message/tool renderers              | refused                                                    | No keyed renderer or native-node replacement registry.                                                                                                                                                |
| whole composer/session/header/chat replacement | refused                                                    | CordisX does not grant native React ownership; the bounded reasoning-range projection is not whole-composer authority.                                                                                |

The adapter also refuses selector strings, Codex DOM/container references,
arbitrary HTML/SVG/CSS, plugin-owned tooltips, plugin-owned overflow/popovers,
and replacements for composer, session header, chat nodes, messages, or tool
renderers. Future replacement work requires a CordisX-owned complete wrapper
and a separate presentation registry; it cannot be smuggled through a surface.

## Delivery and PR boundaries

1. **Architecture (`cordisx`)**: this catalog, compatibility/refusal table,
   adapter state model, dependency order, and validation matrix.
2. **Protocol (`cordisx-protocol`)**: formal merge `f350899` owns surface v5,
   catalog v4, the two Manager payload families, route-v2/page-v3 reuse,
   generation-fenced origins, fixtures, and conformance.
3. **Host (`cordisx`)**: from latest formal main, append matching types,
   registry validation, point descriptors, B navigation/standard page
   projection, permission/origin enforcement, diagnostics, lifecycle and the
   bilingual A+B demo while preserving current catalog and Manager work.
4. **Real renderer (`cordisx`)**: isolated `app://` smoke covers B wide/narrow,
   light/dark, selection/history/fallback and A regression with screenshots
   plus a machine-readable report.
5. **Mono**: no gitlink update in this delivery.

## Validation matrix

| Layer            | Required evidence                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol         | Accept every catalog id and payload family; keep A stable across v4/v5; B item accepts route only; reject duplicated display metadata, free DOM, selector/HTML/SVG/CSS, missing/non-Host page icon, invalid group, spoofed context, unknown schema versions, and invalid lifecycle/origin transitions.                                                                    |
| Registry/runtime | Ownership and source binding, deterministic group/order, direct/overflow partition, native-menu-only projection, command/route resolution, point policy at render and invoke, frozen dynamic context, plugin-argument non-spoofing, `when`/disabled, update-after-dispose, locale reprojection, owner unload, block/restore, and renderer-generation cleanup.             |
| Adapter fixtures | Unique/pending/ambiguous anchors; native anchor replacement; sidebar collapse/resize; composer idle, busy, disabled, and send state; session switch; right/bottom panel absence and presence; no fallback overlay.                                                                                                                                                        |
| Real renderer    | Existing shell-surface evidence remains valid. B evidence additionally proves exact Host/plugin order, pointer/keyboard and Manager-local deep link/Back, selected state, standard page-v3 header/body, constrained width, light/dark, policy/block/disable/uninstall/generation fallback, A usability, no raw bridge/selector, and unchanged outer URL/native data flow. |
| Release          | Focused tests, typecheck/build/full check, clean diff, normal Protocol/Host PR checks and head-fenced merges, exact merged revision evidence, and no mono update.                                                                                                                                                                                                         |

The smoke report records the Codex application version, adapter revision,
resolved seat identities, contribution ids, DOM relationship (`before` or
`after`), computed geometry, overlay/reparent/hide mutation counts, native-node
identity checks, policy/block/generation cleanup results, screenshots, and an
explicit result for every experimental/reserved point. A screenshot without
the report is insufficient evidence.
