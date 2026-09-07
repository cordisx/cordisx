# Public presentation capabilities

This Host reference describes the independent presentation capabilities used
when a plugin owns its page. The normative contracts are
[entity settings navigation v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/entity-settings-navigation/v1.md),
[route link resolution v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/route-link-resolution/v1.md),
and [controlled Markdown editor v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/controlled-markdown-editor/v1.md).
They do not move Room presentation back into Host.

## Entity settings and return navigation

A plugin declares the `entitySettingsNavigation` service dependency and calls
`get({identity})` for availability, then `open({identity})` on its own button.
The Host implementation resolves the existing exact subject through the Manager
content registry and its visible navigation root. It opens the existing Manager
controller; the caller never constructs private route/contribution identifiers.
Availability is advisory and no reference cache is created. A missing or ambiguous
subject cannot silently select the latest entity revision. The caller context
and exact target are checked again for every operation, and retired callers fail.

`props.navigation.navigate` remains ordinary route navigation. In particular,
it is not a substitute for the private Manager modal mount/history controller.
Existing Manager presentation and its root/target return behavior are retained.
No Agent/Session acquisition or entity write occurs through this service.

## Route links from a page

A contributed page can feature-detect `props.navigation.resolveLink`; the route
service also exposes the same optional public capability. Pass a normal local
route reference and its parameters, then copy or display the accepted `url`.
The Host uses the same canonical link generator as structured navigation rows.
It checks route ownership and authorization, and page-bound calls expire with
the original mount. Invalid references and unavailable routes return typed codes.
Resolution does not open a route or access the clipboard.

The existing route-history wire entry contains owner, route id, outlet, path and
parameters and uses the current Host URL as its base. This capability does not
invent a new raw-source field or a cross-profile locator format. Callers must
preserve the exact returned string and cannot claim a different profile/source
migration has been validated merely because a current-instance link resolves.

## Controlled Markdown editing

`cordisx/ui` exports `MarkdownEditor`, `MarkdownEditorProps`,
`MarkdownEditorSelection`, and `MarkdownEditorHandle`. Supply controlled `value`
and `onValueChange`, optional composition/key/selection callbacks and accessibility
names/relations. A ref exposes only focus/getSelection/setSelection, never a Host
DOM query handle. Selection positions are native UTF-16 offsets; message payload
bounds count Unicode code points, so the two units are intentionally distinct.

The Host owns Shikitor initialization, Markdown rendering, theme/font projection,
native text fallback, shared stylesheet lifetime and automatic sizing up to six
lines. The component and its styles use only their own public editor root.
The plugin owns its form, compact/expanded composer layout, mention list,
toolbar, attachment availability, send shortcuts, busy/failed drafts and command
admission. Those product behaviors require separate acceptance; this primitive
alone does not establish complete Composer equivalence.

Focused implementation tests cover public service lifetime and exact re-resolution,
page-bound link resolution without navigation, code-point admission limits and
controlled editor interactions. Real Manager/Back, native app clipboard, IME,
Markdown/theme/resize and full product replacement remain the integration gate.
