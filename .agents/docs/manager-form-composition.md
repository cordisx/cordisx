# Manager form composition

Audience: Host maintainers and plugin authors selecting an editing surface.
This reference owns surface selection and the reusable code map. Field and
validation semantics remain in [Host form system](host-form-system.md); page
hierarchy remains in [Manager content design](manager-content-design.md).
Public contracts remain in Protocol.

## Select the surface

| User task                                                                         | Composition                                                                | Boundary                                                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Create/edit persistent Manager settings, a model connection or Marketplace source | Manager child route plus Schemastery fields and shared Host page layout    | Page owns the transaction; schema supplies fields; shared Host owns chrome/scroll/footer              |
| Edit an object-array item in a Manager form                                       | Nested Host form page using the same field renderer                        | Keep the outer Manager route and inner array stack; confirm changes parent draft, root alone persists |
| Edit an inline scalar array or simple row setting                                 | Canonical array presenter or compact Host control                          | Do not create a route/modal merely for one inline value                                               |
| Confirm removal, permission or another bounded decision                           | Canonical Host confirmation/dialog or the owning native permission surface | Preserve authority, focus, disposal and explicit action descriptors                                   |
| Transient independent choice, preview or interactive business content             | Public Host dialog with JSX body, or its declared page seat                | Host owns modal chrome; a full JSX body does not authorize another modal shell                        |
| Search/filter, code editor, board/canvas or other domain visual                   | Existing Host primitive or plugin-owned public content seat                | Non-form semantics may have custom presentation; no private Host DOM or replacement form renderer     |

A long-lived configuration task does not become a dialog merely because a
Dialog can render JSX. Conversely, this table does not ban canonical Host
primitive implementation or native consent. Route availability and supported
public contracts determine how plugin consumers enter a page.

## Ownership and draft semantics

Host core supplies Manager history/header/back, nested-page navigation,
semantic theme tokens, field presenters, accessibility, layout, content scroll
and the active footer. Business code supplies a Schemastery object, controlled
values/identity, localized business copy and actions through its actual writer.
The renderer reports validity; authoritative save validates again. Errors and
unavailable writers preserve the draft and honest disabled state.

Nested pages keep parent drafts mounted. Back/cancel drops only the current
child draft, confirm merges into the parent, and save commits the full root
transaction. Returning to the outer browse page preserves its query and scroll
state. Do not flatten the two navigation levels. Reset/rollback uses the initial
value for the current record identity; new authoritative records need a new
identity or a mount after readiness. An edit route may arrive before the
authoritative source snapshot: initialize only once the requested record is
available, and preserve subsequent local edits across unrelated refreshes.
After initialization, a snapshot temporarily missing the old record must not
unmount its editor. Snapshot and command reply order can differ; the current
valid save must still complete and navigate normally.

Plugins consume structured configuration, public `SchemaForm`, route
contributions and [public Host dialogs](dialogs.md). The embedded public
`SchemaForm` owns fields/validation/nested editors; its caller still owns
persistence and the declared outer page seat. It does not grant Manager route
or footer mutation authority. Host core coordinates layout through its shared
internal surfaces. An unavailable public page shell is a capability gap: extend
Protocol, implement Host, then migrate consumers on formal compatible revisions.
Never substitute internal imports, private DOM or a custom schema renderer.

## Reuse map and minimal example

Paths below are relative to the Host repository.

| Responsibility                        | Production source / evidence                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager routes and outer header       | `packages/cli/src/renderer/manager/model/routes.ts`, `manager/ManagerApp.tsx` (under the same renderer root)                                                   |
| Maintained plugin configuration entry | `packages/cli/src/renderer/manager/pages/PluginDetailPage.tsx` → `host-ui/HostForm.tsx`; `tests/manager-plugin-config-production.test.tsx`                     |
| Embedded schema field projection      | `packages/cli/src/renderer/host-ui/SchemaForm.tsx`, `HostForm.tsx`, `ArrayEditor.tsx`; `tests/schema-form.test.tsx`, `tests/host-react-form-behavior.test.tsx` |
| Nested draft navigation               | `packages/cli/src/renderer/host-ui/HostFormPages.tsx`; reuse its stack/subpage implementation rather than a second router                                      |
| Public exports and normative contract | `packages/cli/src/ui.ts`; [Schema form v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/schema-form.md)                                  |
| Bounded modal implementation          | `packages/cli/src/renderer/dialogs/`; public use is described in [dialogs](dialogs.md)                                                                         |

The [embedded example](host-form-system.md#embedded-plugin-forms) is the shortest
public field example. It needs both `onChange` and `onValidationChange` to track
validity including initial/external values. Supply footer actions through the
owning public surface; disable save when invalid/busy and invoke the actual
business writer, then reload authoritative state.

### Host page integration availability

The shared `HostFormPage`/`HostSchemaFormPage` fill-layout integration and model
connection child route are proposed in [Host PR #481](https://github.com/cordisx/cordisx/pull/481).
Until that owner change is formally merged, this is a candidate code map, not a
formal dependency. Verify canonical main before reuse. The candidate contains:

- `packages/cli/src/renderer/host-ui/HostFormPages.tsx`: page scroll/footer shell;
- `packages/cli/src/renderer/host-ui/SchemaForm.tsx`: internal `HostSchemaFormPage`;
- `packages/cli/src/renderer/manager/pages/ModelConnectionCreatePage.tsx` and
  `model-catalog/ConnectionEditor.tsx`: real route, schema/draft/actions composition;
- `tests/host-form-pages.test.tsx`, `tests/manager-connection-navigation.test.tsx`
  and `tests/manager-connection.browser.test.ts`: nested drafts, hidden action
  isolation and real visible-control geometry.

Once available on canonical main, Host business pages use this internal shape:

```tsx
<HostSchemaFormPage
  form={{
    identity,
    schema,
    value: draft,
    onChange: receiveDraft,
    onValidationChange: receiveValidity,
  }}
  footer={actions}
/>
```

This is Host-only composition, not an import example for plugins. `actions`
uses shared Host controls; `receiveDraft` retains invalid local values, and the
writer belongs to the business operation. Avoid wrapping the surface in a
second Form, modal, card or scroll container. `HostSchemaFormPage` is not exported
from `cordisx/ui`; exposing a public equivalent would require contract work.

## Why bypasses recur and what prevents them

The previous entry rules established ownership and individual controls but did
not select a surface for durable editing. Existing business pages therefore
provided readily copied manual editor patterns. The plugin Skill also described
a sticky action bar above fields, which conflicted with the full Manager page's
bottom footer. This reference and the [maintenance rule](../rules/manager-forms.md)
route selection before implementation, distinguish embedded/public from
internal page capabilities, and attach focused checks to the actual entry.

There is no reliable static inference from arbitrary Input/Switch imports to
“handmade business form”: search, filters and row operations legitimately use
those controls. The bounded AST check catches unambiguous root bypasses; the
normal PR review supplies selection, writer/draft boundary and geometry evidence.
Existing manual connection/source editors require migration, not an ever-growing
lint allowlist. Production tests validate behavior and browser tests validate
layout; comments or matching source strings prove neither.
