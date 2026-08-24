# {{packageName}}

A minimal trusted-local CordisX plugin. Its manifest is exported from
`src/{{pluginId}}.ts`, which is also the runtime entry used by CordisX.

```bash
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`npm run dev:dry-run` bundles the plugin without launching Codex Desktop.
`npm run dev` launches the separate CordisX development host.

The template intentionally requests no platform capabilities. It contributes
structured data to a host-owned toolbar surface and does not depend on a
marketplace, signing, a permission sandbox, or hot module replacement.

This initial template does not register a route or page. If you add one, use
closed route-v2/page-v3 documents with the matching `$schema` URI and
`schemaVersion`: declare separate retained localized `title` and `description`
messages for both registrations, provide real dictionaries for every
advertised locale, omit the legacy `localeNamespace` hint from page v3, and
keep path, outlet, page id, route id, params, and chrome untranslated. The
route description explains the entry context; the page description explains
what the mounted destination lets the user do.

This generated project is Marked Template Material under the
[CordisX Independent Plugin Exception](https://github.com/cordisx/cordisx/blob/main/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md).
If it remains an independent plugin using only documented, versioned public
CordisX plugin interfaces, it may be commercial and use a license you choose.
Replace `UNLICENSED` in `package.json` with that license before distribution.
The Exception does not cover copying or modifying CordisX host/runtime/CLI code
or using private interfaces.
