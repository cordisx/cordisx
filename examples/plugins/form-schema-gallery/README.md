# Form Schema Gallery

This development-only plugin is loaded solely by
`cordisx.config.ui-demos.json`. It contributes no navigation item, route,
slot, command, or plugin-owned DOM. Open CordisX Manager, choose **Form Schema
Gallery**, then **Config** to inspect the Host-owned TDesign form.

Launch it with:

```bash
npm run dev -- dev --config cordisx.config.ui-demos.json
```

The schema intentionally covers Host-supported text, multiline text, URL and
directory roles, required and empty optional values, number input, slider,
checkbox, switch, scalar Select, Radio, JSON array fallback, nested fields,
localized labels/help, validation bounds, and a disabled descriptor. The
current public descriptor does **not** define bounded array choices, so the
`Audience tags` multi-select request is deliberately an unsupported-role
diagnostic rather than a JSON field misrepresented as a multi-select. Date,
time, and color use the same no-native-fallback policy. The plugin uses only
privacy-safe example values and declares `plugin-restart`; it does not claim a
secret, credential, external connection, or custom renderer.
