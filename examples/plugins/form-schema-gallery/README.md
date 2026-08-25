# Form Schema Gallery

This development-only plugin is loaded solely by
`cordisx.config.ui-demos.json`. It contributes no navigation item, route,
slot, command, or plugin-owned DOM. Open CordisX Manager, choose **Form Schema
Gallery**, then **Config** to inspect the Host-owned TDesign form.

Launch it with:

```bash
npm run dev -- dev --config cordisx.config.ui-demos.json
```

The schema exercises the closed Host-owned Presenter Catalog: input,
multiline text, URL and directory input, required and untouched optional
values, number stepper and slider, checkbox and switch, Select, classic Radio
and segmented Radio, bounded multi-select, scalar TagInput, date, time, and
color. It also includes compact object-array rows with shared-draft dialog and
page-mode requests, localized labels/help, validation bounds, semantic icons,
and a disabled descriptor.

The gallery never contributes a global Demo destination or plugin-owned form
DOM. It uses only privacy-safe test data and declares `plugin-restart`; it
does not claim a secret, credential, external connection, or custom renderer.
Unsupported schema shapes remain Host diagnostics rather than simulated
editors. See the Host renderer contract for the current honest boundary.
