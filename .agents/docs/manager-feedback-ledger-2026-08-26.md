# Manager feedback ledger — 2026-08-26

Type: historical delivery record for the 2026-08-26 feedback batch. Retained
statuses and gates describe that batch, not the state of a later checkout or a
new task's owner assignments. Use [Manager design](manager-content-design.md),
[Host forms](host-form-system.md), and the
[current delivery rule](https://github.com/cordisx/cordisx/blob/main/.agents/rules/functional-delivery.md) for new work. No item
is promoted to verified, formally merged, or accepted by archiving this record.

This document is the bounded implementation and acceptance ledger for the
Manager feedback collected on 2026-08-26. It is the follow-up source of truth
for this batch. It records reusable engineering requirements rather than
screenshots, private task history, or browser markers.

## Scope and status rules

- Do not reopen or repeat visual verification for older items the user has
  already accepted unless the current formal baseline visibly regresses them.
- This ledger contains the one previously identified remaining diagnostic
  issue and all 19 new browser comments. Duplicate comments are consolidated,
  but every comment remains traceable below.
- Every item starts as **planned**. Change an item to **implemented** only when
  the owning code and focused tests exist, to **verified** only after the
  current production renderer demonstrates the required behavior, and to
  **formally merged** only after the owner PR, CI, merge, and remote-main
  readback complete.
- A JSDOM assertion, an older preview, or a screenshot from a feature branch is
  not current renderer verification.

## Architecture and ownership checkpoint

This batch changes presentation and interaction only. It does not introduce a
new plugin contract or capability, so `cordisx-protocol` is unchanged.

| Surface                                                                                | Owning files                                                                                                                | Focused evidence                                                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin Console layout, filters, actions, follow behavior, Luna projection, diagnostics | `packages/cli/src/renderer/manager.ts`, `packages/cli/src/renderer/ui-copy.ts`                                              | `tests/plugin-console-runtime.integration.test.ts`, `tests/plugin-console-luna-projection.test.ts`, `tests/ui-copy-principles.test.ts` |
| Host Form layout, action icon semantics, and official-control containment              | `packages/cli/src/renderer/host-form.ts`, `packages/cli/src/renderer/tdesign-form.ts`, `packages/cli/src/renderer/icons.ts` | `tests/host-form.test.ts`, `tests/schemastery-ui.test.ts`, `tests/plugin-config-runtime.integration.test.ts`                           |
| Array editor interactions and ordering                                                 | `packages/cli/src/renderer/host-form.ts`                                                                                    | `tests/host-form.test.ts` plus production-renderer pointer and keyboard smoke                                                          |
| Manager shell hierarchy and breadcrumb chrome                                          | `packages/cli/src/renderer/manager/ManagerApp.tsx`, `packages/cli/src/renderer/manager/styles.ts`                           | Focused React renderer tests plus current isolated production renderer                                                                 |
| Final integrated visual evidence                                                       | `packages/cli/scripts/live-smoke.mjs` only if a durable assertion is needed                                                 | Current isolated production renderer, not a copied UI                                                                                  |

Shared Manager DOM and Host Form CSS have one Host owner. Plugins continue to
provide schema, data, state, and commands; they do not receive DOM or styling
ownership to fix these issues locally.

## Confirmed requirement ledger

### Plugin Console

| ID         | Source                           | Status      | Required outcome                                                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CONSOLE-01 | Previous remaining issue         | planned     | Remove the entire normal-UI `诊断` disclosure beneath the log workspace, including raw codes such as `current-connection-client-unavailable`. Retain diagnostic data internally for developer export or debugging; show only localized, task-relevant unavailable state beside the capability that owns it.                      |
| CONSOLE-02 | Comment 1                        | planned     | Remove block-start and block-end margin from the top Console toolbar. The panel/container owns surrounding spacing; the toolbar must not add another vertical gap.                                                                                                                                                               |
| CONSOLE-03 | Comments 2–3                     | planned     | The level, kind, and source selects must never overlap. Give each select a distinct Host-owned leading semantic icon so `全部` is not visually ambiguous, and make the selects compact rather than consuming equal wide columns. They must shrink or reflow cleanly at Manager breakpoints without clipping neighboring actions. |
| CONSOLE-04 | Comments 4–5                     | planned     | Move **Copy selected** and **Export plugin logs** out of the primary toolbar into one Host-owned More menu. Preserve disabled state, accessible names, keyboard operation, outside-click/Escape dismissal, and focus return.                                                                                                     |
| CONSOLE-05 | Comment 6                        | planned     | Remove the user-selectable follow toggle. Following is automatic: when the viewport is at the bottom, or the user has not scrolled away, new entries remain pinned to the bottom; scrolling upward suspends following; returning to the bottom resumes it automatically. Preserve the user's scroll position while suspended.    |
| CONSOLE-06 | Comment 7                        | planned     | Remove the floating **Back to latest** button. The automatic bottom-proximity policy in CONSOLE-05 is the only follow interaction.                                                                                                                                                                                               |
| CONSOLE-07 | Comment 8                        | planned     | Make the whole Console panel compact: one tight control row where space permits, no redundant vertical gaps between controls and log frame, and no unused footer area after CONSOLE-01/06 are removed.                                                                                                                           |
| CONSOLE-08 | Comment 9                        | planned     | Remove the visible per-entry Luna header row that repeats timestamp and source, such as `20:25:45 plugin.activate`. The primary log row shows the message/argument projection. Timestamp, source, kind, correlation, and other metadata remain available through filtering and the selected-entry detail inspector.              |
| CONSOLE-09 | Follow-up logs scrolling comment | implemented | The Console owns a complete shrinking height chain from plugin detail through workspace/body/frame. The frame, not the Manager dialog or whole page, scrolls with stable gutters and contained overscroll; opening the detail inspector must not disable log scrolling.                                                          |

The Pause and Clear actions remain primary toolbar actions unless later user
feedback changes that decision. Pause freezes the projected page; it is not a
replacement for scroll following.

### Host Form and TDesign controls

| ID      | Source                                                                | Status      | Required outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | --------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FORM-01 | Comment 10                                                            | planned     | A textarea must look and behave as an actual multi-line textarea, not merely render a `textarea` DOM node inside a single-line-sized shell. Preserve multiple visible rows, wrapping, controlled value retention, and vertical sizing in the official TDesign projection.                                                                                                                                                                                                                    |
| FORM-02 | Comments 11–12                                                        | planned     | Fix numeric-control overflow at the shared primitive boundary. Every `t-input-number`, its internal wrapper, buttons, and value input must respect the Host control seat's available inline size. Do not add field-specific width patches; verify multiple number fields and narrow layouts.                                                                                                                                                                                                 |
| FORM-03 | Comment 13                                                            | planned     | All compact controls share one trailing alignment line with the form grid's content edge. The control's right inset must equal the section/grid right inset; remove double padding and one-off exceptions across switches, checkboxes, numbers, radios, selects, and other compact controls.                                                                                                                                                                                                 |
| FORM-04 | Comment 14                                                            | planned     | Repair the segmented radio-button presentation (`guided` example): official TDesign buttons must form one coherent group with correct selected, hover, focus, border, radius, height, and dark/light theme states.                                                                                                                                                                                                                                                                           |
| FORM-05 | Comment 15                                                            | implemented | Remove non-interactive decorative leading icons from individual field labels such as `受众标签`. Field identity comes from label text. A Host-owned interactive field-action trigger is the sole allowed leading icon and must expose its menu semantics rather than masquerading as decoration.                                                                                                                                                                                             |
| FORM-06 | Comment 16                                                            | planned     | Where a section/group heading legitimately retains a semantic icon, vertically center the icon and heading text using one shared layout rule. Do not compensate with per-icon transforms.                                                                                                                                                                                                                                                                                                    |
| FORM-07 | Comment 17                                                            | planned     | Array-row actions are hidden at rest and appear on row hover or `:focus-within`. The row summary and drag handle remain visible. Keyboard and touch users must still be able to reveal and operate edit, duplicate, and delete actions.                                                                                                                                                                                                                                                      |
| FORM-08 | Comments 18–19                                                        | planned     | Remove visible move-up and move-down buttons when drag reordering is enabled. The drag handle is the sole visible ordering affordance. Preserve accessible keyboard reordering on the handle and do not remove edit, duplicate, or delete.                                                                                                                                                                                                                                                   |
| FORM-09 | Follow-up comments 1–3                                                | planned     | Replace the incorrect array-row action glyphs and button presentation. **Edit** uses a standard edit/pencil icon, **Duplicate** uses the standard content-copy icon, and **Delete** uses a standard trash/delete icon with restrained destructive styling. Do not substitute settings, folder, restart, power, or other unrelated symbols. All three use the same centered icon-button geometry, accessible label, tooltip, focus treatment, and hover/focus visibility policy from FORM-07. |
| FORM-10 | Follow-up field-menu, Schemastery style, and required-marker comments | implemented | React Host Form consumes `@cordisx/schemastery-ui` presenter resolution, layout, validation, and `FormDraft`. Each writable field has one centered leading semantic icon that opens the Host-owned Use default, Revert field change, and Copy configuration path menu with preserved disabled states. Groups use the established settings-list geometry. Required marks follow the field title on its right; no required mark precedes the action icon.                                      |

### Manager shell

| ID       | Source                                                                                 | Status      | Required outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHELL-01 | Follow-up breadcrumb and Header typography comments                                    | implemented | Detail pages use one real, single-line breadcrumb that expresses navigation hierarchy. A plugin facet reads `插件 / <plugin name> / <current facet>`; the plugin name is not repeated as a separate title above it. The back action remains a separate control, ancestor crumbs are navigable, and the current crumb is exposed with `aria-current="page"`. Primary titles and detail breadcrumbs use the same Header font size; weight and color distinguish the current segment.                                                                                                                                                                                                                                                              |
| SHELL-02 | Follow-up comments 1–2                                                                 | planned     | Plugin-detail extension-point and route facets retain list search. Search covers the visible title, description, machine id, path, and related identifiers; an empty query restores the complete list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SHELL-03 | Follow-up comments 3–4                                                                 | planned     | Plugin-detail tabs retain their closed semantic icons. A primary Manager page shows its semantic icon in the leading Header seat; a detail route uses that seat for Back. Icons are Host-owned TDesign React projections with accessible text remaining authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SHELL-04 | Follow-up comment 5                                                                    | planned     | Primary list search occupies the content width available to it instead of using an arbitrary narrow fixed width. It shrinks at narrow breakpoints without horizontal overflow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SHELL-05 | Follow-up comments 6–7                                                                 | planned     | Do not repeat a generic page title or description inside the content region when the Manager Header already names that page. Primary list pages start with their toolbar/search/results; detail pages start with their tabs or content. Content-specific headings remain only where they name an actual section.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SHELL-06 | Follow-up comments 8 and 11 plus action-layout correction                              | planned     | Plugin collection rows expose the applicable lifecycle and overflow actions only on row hover or `:focus-within`. Actions are a top-right overlay and never reserve inline space, truncate row copy at rest, or cause layout shift. The lifecycle status is a small semantic status marker on the lower-right of the plugin avatar, with an accessible description; it is not a detached text column.                                                                                                                                                                                                                                                                                                                                           |
| SHELL-07 | Follow-up comments 9–10                                                                | planned     | Marketplace plugin detail and extension-point detail retain local semantic tabs. Marketplace separates overview from author/source information; extension points separate usage, information, and diagnostics. Tabs use the same icon, focus, selected-state, and panel semantics as plugin detail.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SHELL-08 | Follow-up Marketplace comments 1–2 and toolbar-icon correction                         | implemented | Marketplace catalog revalidation is owned by React SWR (initial load, focus, reconnect, and bounded background refresh), with no manual Refresh control. Search, official-only, certified-only, and Manage Sources form one joined control: search remains flexible; the three trailing actions are Seal, Verified, and Edit icon buttons. Filter buttons expose `aria-pressed` and a visible selected state. Every result retains a plugin icon or Host fallback and reveals actions on hover/`:focus-within`: available common actions are direct, low-frequency actions use More. Install/block/share/favorite must reflect real Host capability; unsupported Host-only mutations remain visibly unavailable rather than simulating success. |
| SHELL-09 | Follow-up About and navigation comments                                                | implemented | About uses the repository's adaptive CordisX brand mark—not a generic Info icon or `CX` placeholder—in the Header, sidebar navigation, and product identity block. The identity block is vertically centered with the mark above product name and version. About actions are a full-width vertical navigation list with their own semantic icons and a real external-link arrow; raw URLs are not printed as content. All sidebar icons share one 18px seat with horizontal and vertical centering; dark/light brand artwork follows Host theme.                                                                                                                                                                                                |
| SHELL-10 | Follow-up contributed top-level navigation comment                                     | implemented | A plugin-contributed Manager navigation item is a special top-level product page, not a plugin-detail child. Its Header is the single page name with its own leading icon and no Back control; only that contributed sidebar item is current. Plugin-detail breadcrumbs remain limited to routes entered through the plugin collection.                                                                                                                                                                                                                                                                                                                                                                                                         |
| SHELL-11 | Follow-up plugin identity/runtime comments                                             | implemented | Every plugin detail has one identity/action region above local tabs: avatar with status marker, name, available version/author/canonical-link metadata, and lifecycle actions on the right. Missing metadata is omitted. Runtime uses compact statistics for status, permissions, extension points, routes, injected capabilities, and dependencies; lifecycle actions are not repeated at the bottom of Runtime.                                                                                                                                                                                                                                                                                                                               |
| SHELL-12 | Follow-up README rendering, Playground Manager-entry, and dialog-preservation comments | implemented | Plugin README content is rendered through a Host-owned React Markdown projection with GFM, raw HTML disabled, safe external links, and an 820px readable measure. The Vite Playground exposes only the real icon-based Manager trigger; the obsolete text-button placeholder is removed, and a cold restart must restore all fixture plugins before review continues. During Playground HMR, Manager open state and route history are retained; only an explicit close interaction dismisses it.                                                                                                                                                                                                                                                |
| SHELL-13 | Follow-up Header height and icon-seat comments                                         | implemented | The Manager Header has no fixed or minimum height; content and vertical padding determine its block size. Leading and trailing seats are both 32 by 32 pixels, and their Host-owned icons are exactly 16 by 16 pixels with one shared centering rule. Primary-page icons, Back, Brand, and Close cannot inherit mismatched TDesign `1em` sizing.                                                                                                                                                                                                                                                                                                                                                                                                |

## Interaction details that must not be lost

### Automatic Console following

The log viewport owns a small bottom-proximity threshold. Appending or
reprojecting entries scrolls to the bottom only while the viewport is within
that threshold. A user scroll above it records a suspended state without
adding a toolbar control. A user scroll back into the threshold resumes
following. Search/filter changes may project a new result set, but must not
force a user who is inspecting older entries back to the bottom.

### Compact filters

The three Console filter controls keep explicit accessible labels for level,
kind, and source even though their visible selected value may be `全部`. Their
leading icons are decorative, closed Host tokens and do not replace the label.
Source may use the most width, but no select receives an unbounded equal share
of the toolbar. Responsive layout may wrap controls as groups; controls and
actions must never visually overlap.

### Host Form containment

The fix for number overflow and trailing alignment must be expressed at the
shared Host/TDesign control boundary: custom element, exposed part or internal
wrapper where supported, control seat, and grid track must all allow shrinking
with `min-inline-size: 0` and `max-inline-size: 100%`. Clipping the form grid is
not considered a fix because it hides an invalid layout rather than containing
the control.

### Array rows

Pointer drag and keyboard reorder operate on the same stable item identities.
Removing the up/down buttons must not remove reorder semantics, focus recovery,
disabled/min/max behavior, or durable draft emission. Row actions appearing on
hover must also appear when focus enters the row, and must not cause summary
text or row width to jump.

Edit, duplicate, and delete are distinct semantic actions, not convenient
reuse points for whatever closed icon happens to exist. The current settings,
folder, and restart substitutions are explicitly rejected. If the Host's
internal icon catalog lacks edit/content-copy/delete tokens, add Host-owned
renderer tokens and their bundled Material symbols; do not expand the public
plugin presentation contract merely to repair Host chrome.

## Traceability to all comments

| Browser comment                                                       | Ledger item |
| --------------------------------------------------------------------- | ----------- |
| Previous `诊断` disclosure feedback                                   | CONSOLE-01  |
| 1                                                                     | CONSOLE-02  |
| 2, 3                                                                  | CONSOLE-03  |
| 4, 5                                                                  | CONSOLE-04  |
| 6                                                                     | CONSOLE-05  |
| 7                                                                     | CONSOLE-06  |
| 8                                                                     | CONSOLE-07  |
| 9                                                                     | CONSOLE-08  |
| 10                                                                    | FORM-01     |
| 11, 12                                                                | FORM-02     |
| 13                                                                    | FORM-03     |
| 14                                                                    | FORM-04     |
| 15                                                                    | FORM-05     |
| 16                                                                    | FORM-06     |
| 17                                                                    | FORM-07     |
| 18, 19                                                                | FORM-08     |
| Follow-up 1 (Delete appearance)                                       | FORM-09     |
| Follow-up 2 (Edit appearance)                                         | FORM-09     |
| Follow-up 3 (Duplicate appearance)                                    | FORM-09     |
| Follow-up breadcrumb comment                                          | SHELL-01    |
| Follow-up comments 1–2 (missing detail-list search)                   | SHELL-02    |
| Follow-up comments 3–4 (missing tab/Header icons)                     | SHELL-03    |
| Follow-up comment 5 (search width)                                    | SHELL-04    |
| Follow-up comments 6–7 (duplicate page headings)                      | SHELL-05    |
| Follow-up comments 8 and 11 (row actions and status marker)           | SHELL-06    |
| Follow-up comments 9–10 (missing detail tabs)                         | SHELL-07    |
| Follow-up Marketplace comments 1–2 (toolbar and result actions)       | SHELL-08    |
| Follow-up About and navigation icon comments                          | SHELL-09    |
| Follow-up contributed top-level navigation comment                    | SHELL-10    |
| Follow-up logs scrolling comment                                      | CONSOLE-09  |
| Follow-up plugin identity/runtime comments                            | SHELL-11    |
| Follow-up field-menu, Schemastery style, and required-marker comments | FORM-10     |
| Follow-up README rendering and Playground Manager-entry comments      | SHELL-12    |
| Follow-up Header height and icon-seat comments                        | SHELL-13    |

## Implementation batches

1. **Console closure:** CONSOLE-01 through CONSOLE-09 in the shared Manager
   renderer and Console tests.
2. **Form containment and presentation:** FORM-01 through FORM-06 and FORM-10 in the
   shared Host Form/TDesign adapter and focused tests.
3. **Array interaction simplification:** FORM-07 through FORM-09, including
   pointer, keyboard, focus, semantic-icon, and draft-state tests.
4. **Integrated renderer acceptance:** consume the combined implementation in
   the production renderer and verify only this ledger. Do not reopen already
   accepted historical UI items without a visible regression.
5. **Manager shell and migrated collection parity:** SHELL-01 through SHELL-13
   in shared React shell, tabs, list, and action primitives; verify plugin,
   extension-point, route, and Marketplace paths at wide and narrow breakpoints.

The batches may use separate implementation branches only when their file
ownership does not overlap. `manager.ts` has one Console owner and
`host-form.ts` has one Form owner; the final integrated smoke consumes their
formal merges rather than feature heads.

## Acceptance and delivery gates

Focused validation must cover:

- Console toolbar geometry and responsive reflow;
- More-menu keyboard and focus lifecycle;
- automatic follow suspend/resume behavior without follow/latest controls;
- Luna message projection without the redundant header row;
- absence of the normal diagnostic disclosure and raw diagnostic code;
- visible multi-line textarea presentation and controlled-value retention;
- number containment and common trailing alignment at wide and narrow widths;
- segmented-radio light/dark/selected/focus states;
- field-label icon removal and section-heading alignment; and
- array action visibility and semantic edit/copy/delete icons plus pointer and
  keyboard reorder without up/down buttons; and
- one non-repeating, navigable breadcrumb with an explicit current page.

Run the focused tests, then `npm run check`. Current renderer verification must
cover wide and narrow Manager layouts plus light and dark themes for the
affected Console/Form pages. Record concise observable evidence against each
ledger ID; do not store browser screenshots or private task content in this
repository.

Delivery is complete only after the Host commit is pushed, its PR and required
CI pass, the exact head is merged, and `origin/main` is read back. CordisXMono
may then pin that formal Host merge in a separate pointer-only change. Do not
update mono from a feature head.
