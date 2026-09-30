# Manager forms and editor surfaces

Read this rule before adding or changing a Manager editor, configuration form,
array item editor, or form dialog. Apply the selection table and code map in
[Manager form composition](../docs/manager-form-composition.md) before choosing
markup. This rule applies to Host business pages; it does not prohibit the Host
from implementing its canonical primitives.

- Durable create/edit workflows use Manager navigation and the shared
  Schemastery field renderer. Business pages supply schema, controlled draft,
  validation state and actions; shared Host surfaces own navigation, theme,
  field presentation, scroll and footer layout.
- Short confirmations, transient choices and independent interactive content
  use the canonical Host dialog system. Full JSX support is not a reason to
  move a durable Manager editor into a modal. Do not add another modal shell.
- A search control, row toggle, code editor or domain visualization is not by
  itself a schema form. Preserve those product semantics and public seats.
- Plugins use public structured configuration, `SchemaForm` from `cordisx/ui`,
  and public dialogs/routes as applicable. They must not import Host internals,
  reach into Host DOM or provide a second field renderer. `HostSchemaFormPage`
  is internal integration, not a public plugin export. A missing public page
  capability requires Protocol then Host work before consumer adoption.

## Admission and review

For each added or materially changed editor, put these four facts in the normal
PR description: selection-table row, canonical production entry, draft/commit
boundary, and relevant evidence. This is a review checklist, not a second
approval process or a per-feedback blocking gate.

1. Reuse the schema renderer and page/dialog shell. Do not introduce manual
   field labels/widgets/validation for a business configuration workflow,
   duplicate title/back controls or nested modal chrome. A needed new presenter
   belongs in the shared Host implementation and, where observable, Protocol.
2. Preserve both Manager route history and nested array-page history. Child
   cancel/back discards only its local draft; child confirm updates the parent
   draft without persistence. Root save validates and commits once; failure
   retains the draft. If a route opens before authoritative data arrives, wait
   for that record before initializing its draft/identity; do not freeze an
   empty placeholder draft or overwrite later user edits on unrelated refresh.
   After initialization keep the editor and dirty draft mounted even if a
   refresh temporarily omits the record. Snapshots can precede command replies;
   completion/navigation guards must still allow the current valid save. Record identity controls rollback/reset. Save/reopen must
   read authoritative state, not merely display the previous local draft.
3. Verify the active page's footer only, bottom alignment across the entire
   Manager content seat, independent content scrolling, and no hidden-page
   actions. Align back button/SVG/title and real controls to shared content
   edges with consistent vertical spacing. Compact controls retain intrinsic
   width; empty arrays have no fake field/control placeholder.
4. Check keyboard/focus, descriptions/errors, light/dark themes, narrow width,
   resize and empty/nonempty arrays at the relevant layer. Browser geometry
   measures visible controls, not wrapper boxes; JSDOM cannot prove layout.

## Executable boundary and evidence

`tests/manager-form-admission.test.ts` parses Manager business page/component
ASTs to reject raw HTML `form`/`dialog` roots and direct TDesign `Form`, `Dialog`
or `DialogPlugin` imports. It excludes Host primitives by ownership, not by a
blanket Form/Input ban. Vite lazy module imports make the scanned production files real test dependencies,
including new business pages, so the existing affected renderer gate selects
the check. It catches an identifiable bypass, not every handmade
editor: hand-assembled divs, private wrapper imports and imperative overlays
still require the admission review above. Do not grow this into heuristic
label counts, wide grep rules or source-string snapshots.

`tests/manager-plugin-config-production.test.tsx` enters the real plugin detail
configuration page with real Host fields and verifies edit/save/reopen against a controlled writer projection. This is page
composition evidence, not persistent-store or native-App readback. Reuse
existing schema, nested-page and browser suites from the code map for their
respective behavior; add only missing production-path coverage when migrating
another editor. Existing legacy editors are migration work, not approved
examples or exemptions for new implementations.

Use [Host testing](../docs/testing.md) and risk-tiered affected checks. During a
user-led pure-style feedback window, follow [functional delivery](functional-delivery.md)
and defer the combined checks until the window closes. These standards add no
release, native-App or acceptance claim to documentation or DOM evidence.
