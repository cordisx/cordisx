# Standard page header actions

Status: experimental implementation; page v4 requires the matching Protocol
successor before formal consumer delivery. The normative
[page v4 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/ui-contributions/page-v4.md)
owns shape, bounds and downgrade semantics.

The Host renders standard page chrome from `ctx.pages.register` metadata.
`CordisXPageMetadataV4` supports ordinary command buttons and avatar/image menu
triggers. Register commands through the owner's public command service; their
handlers own product behavior. The page body does not receive a header DOM seat.

```ts
const metadata = {
  $schema: CORDISX_PAGE_SCHEMA_V4,
  schemaVersion: 4,
  id: 'lobby',
  title: { key: 'lobby', fallback: 'Lobby' },
  description: { key: 'description', fallback: 'Browse and join games' },
  headerActions: [
    {
      id: 'invite',
      label: { key: 'invite', fallback: 'Invite' },
      icon: 'host:link',
      command: { id: 'invite' },
    },
    {
      id: 'create',
      presentation: 'primary',
      label: { key: 'create', fallback: 'New game' },
      icon: 'host:new',
      command: { id: 'create' },
    },
    {
      id: 'account',
      label: { key: 'guest', fallback: 'Anonymous guest' },
      visual: { kind: 'avatar' },
      menu: [{
        id: 'profile',
        label: { key: 'profile', fallback: 'Profile' },
        command: { id: 'profile' },
      }],
    },
  ],
} satisfies CordisXPageMetadataV4
```

Metadata remains immutable within its page registration. Existing context expressions
control visibility; command registration controls availability. On matching
experimental Hosts, `mount.controls.setHeaderActionVisual(actionId, visual)`
updates the visual of an already declared action in this mounted standard page
and returns whether it was accepted. The visual kind must match the declaration;
all existing v4 inline-raster bounds apply. No label, menu, command, visibility or
authorization changes. Unknown actions, body-only surfaces, invalid visuals and
retired mounts return false. Older Hosts may omit the method: feature-check it
and retain the anonymous fallback. This is a public SDK method on
`CordisXPageControls`, exported from `cordisx`; no header DOM seat is exposed.
Use the current-user result's optional avatar with `{ kind: 'avatar', src }`, or
`{ kind: 'avatar' }` when unavailable. The same trigger retains its focus and menu.

The navigation registry retains command authorization and error reporting.
`renderer/page-header-actions.ts` owns controls, the single open menu, inline
visuals, tooltips and disposal. Its style element is mounted with the owning
header; the menu portal is removed when that page unmounts. Portal colors derive
from the actual header's computed theme while open. The navigation page section
attaches the existing Host theme projection around both chrome and body. Native
background tokens remain preferred; when absent, page/header/menu surfaces use
the projected App palette instead of fixed dark fallbacks. No plugin CSS overrides
Host selectors. Native-history-backed app/main pages omit the old page Close
button while retaining the existing Back and programmatic close behavior.

Use the navigation suite for owner/command-policy composition and the header
suite for menus, pending dispatch, image fallback and disposal. A browser fixture
can check this renderer's theme, geometry and focus; native routing and a game's
consumer integration still require the actual App and plugin owner's evidence.

During the unreleased v4 experiment, `presentation: 'primary'` opts one command
into an icon-and-label button. Ordinary `text` commands show labels with an optional icon and a transparent
idle surface; other actions remain square icon controls. Menu
triggers and avatar visuals cannot use primary presentation. Older experimental
v4 Hosts require consumers to omit this field. Header tooltips reuse the Host
controller's header appearance; pointer delay and accessible linkage remain
Host-owned and no shortcut is inferred from the command id.

The standard header now uses adapter-projected native main-header geometry and
typography. `adapter/page-header-layout.ts` centralizes the observed native title
surface, persistent title group and toolbar probes. `page-header-chrome.ts`
consumes the resulting Host-owned variables. The bottom rule is an inset shadow,
so it does not shift the 46px native header's vertical center by half a pixel.
Native toolbar targets (currently 28px) and title fonts are measured in CSS
pixels. These are relationships to native anchors, not screenshot-scaled offsets.

Standard page bodies expose two read-only CSS lengths:
`--cordisx-page-content-title-inset` and
`--cordisx-page-content-leading-center`. Both use the mounted body's content-box
left edge as origin, including its actual fractional border and Host React root
padding. The first locates the title text start; the second locates the leading
cell's horizontal center, whether it contains an icon, Back, or no glyph.
Subtract the consumer's additional padding and its icon half-width/gap to align
search controls. The values may be signed and refresh after layout changes;
retain normal body layout when absent. Do not query native headers or override
the tokens. Body-only and Agent conversation pages provide no standard-header
guarantee. `--cordisx-page-title-inset` remains the legacy outer chrome-container
length; it does not compensate for the mounted body's padding or border.

For a page whose body should reach the Host content edges, page v4 supports
`contentInset: 'none'` alongside `chrome: 'standard'`. The standard header stays
in place. Host React roots remove only their own default 16px body padding;
plugin-owned component spacing and scroll ownership remain unchanged. Omission
or `standard` keeps the current layout, and existing body-only and Agent
conversation padding policies still apply. The ordinary outlet and embedded
Manager mounts both project this metadata on the body seat before mounting.
Plugins consume the public metadata field and must not style Host selectors or
write its internal projection attributes. Earlier experimental v4 Hosts reject
this field, and versions 1–3 cannot declare it.

Use `host:log-out` for a leave/sign-out action requiring a door frame and
outward arrow. The Host compiles the existing Reicon `Logout4` Outline/ Filled
variants through its normalized descriptor backend; ordinary header actions
use the same regular weight and adapter-projected size as other icons. This
is a glyph token only. Keep the product command, localized label/ariaLabel,
tooltip and confirmation semantics with the consumer. `host:close` retains its
X glyph, including a details-pane close action. Older Hosts without this token
reject registration, so consumers must use a supported token until upgrading.

Page-v4 menu command items already accept the same optional `icon` Host token
as other commands. Put the token on each menu item, not on the avatar trigger.
The Host renders a fixed 16px leading column on every row, leaving an empty
decorative seat when the item omits its icon, so mixed rows keep their text
aligned. Glyphs use the existing Host resolver, regular weight and current
theme color; accessible names still come from the localized item label or
ariaLabel. Keyboard, command authorization and owner cleanup are unchanged.

During the unreleased page-v4 experiment, a command action with
`presentation: 'primary'` may additionally declare `variant: 'outlined'`.
Its idle surface is transparent with a Host border; hover adds the standard
Host surface background. Focus, disabled and pending states retain the shared
action behavior. Omission preserves the existing primary appearance. Icon-only
actions, menu triggers and menu items cannot declare this variant. Earlier
experimental Hosts reject the new field; omit it when targeting those Hosts.

Matching experimental Hosts also expose
`mount.controls.setHeaderBreadcrumbs(items, back): boolean`. It replaces the
standard title with one line of 1–8 localized labels separated by `/` and
replaces the leading cell with the standard Back control. The last label has
`aria-current="page"`; labels truncate with ellipsis and retain their full
text as tooltips. Supply actual room data on each update, for example
`[{ key: 'lobby', fallback: '游戏大厅' }, { key: 'room-name', fallback: room.name }]`
and `{ id: 'lobby' }`. Back uses the existing owner-scoped public route registry,
including its authorization and errors. It does not use an assumed history
entry. The payload is at most 16KiB UTF-8, labels reuse LocalizedText validation,
and route params are finite JSON scalars. Inputs are cloned and localization
changes rerender the current labels. Invalid updates, unsupported headers or
retired mounts return false; older Hosts may omit the method. Feature-check it
and retain the declared title. The existing immutable `metadata.breadcrumbs`
row remains separate; omit it for this single-line title workflow. React page
consumers capture controls in the public mount wrapper, as for avatar updates.

Matching experimental Hosts expose
`mount.controls.setHeaderActionLabel(actionId, label): boolean`. Supply a
validated `CordisXLocalizedText` for an existing top-level command or menu
trigger in the current standard header. Text and primary commands display it; icon commands update
accessible names and tooltips. Menu triggers also update the accessible name of
an open menu without replacing it or its items. A declared `ariaLabel` or disabled reason retains
its override. Inputs are cloned, finite scalar params and 16KiB UTF-8 JSON bounds
apply, and locale refreshes rerender the latest label as text. The trigger,
focus, command identity, authorization and pending/disabled state remain intact.
Menu items, unknown ids, unsupported headers, invalid input and retired
mounts return false. Feature-check older Hosts and retain the declared label.
Use `presentation: 'text'` for a balance command beside the single primary
create command, and update its label from actual consumer data without
re-registering the page. Text commands keep metadata order and existing action
limits; they cannot declare avatar visuals, menus or the primary variant.
The public `CordisXPageControls` type is exported by `cordisx`.

Matching experimental Hosts allow a text action to declare a leading
`visual: { kind: 'image', src }` under the
[page-v4 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/ui-contributions/page-v4.md#leading-images-on-text-commands).
It reuses the existing 20px image class and bounded inline raster validation.
Rendering and visual updates preserve the visible label node, trigger and focus;
failed decoding replaces only the image with the neutral action icon. Avatar
visuals remain forbidden on text commands. Older experimental Hosts require
omitting this visual while retaining the text label.

Matching experimental Hosts also support text image
`visual: { kind: 'image', src, position: 'trailing' }` and independent
`tooltip: LocalizedText`. Omitted position remains leading; omitted tooltip
retains the existing accessible-label tooltip, while a disabled reason still
wins. Position is part of the declared text visual; image updates retain it and
reject a conflicting position. Other visuals and presentations do not gain
these metadata fields.

`mount.controls.setHeaderActionLabel(actionId, label, ariaLabel?)` can update the
visible and accessible messages together. Each is validated and cloned with the
existing finite scalar and 16KiB bounds before either changes. Omission preserves
the current accessible override. Use an ordinary localized numeric visible label,
a complete accessible amount with its unit, and a separate action tooltip; Host
does not interpret currencies. Locale refresh retains the latest messages,
trigger, focus and dispatch. Invalid accessible input leaves both messages intact.
