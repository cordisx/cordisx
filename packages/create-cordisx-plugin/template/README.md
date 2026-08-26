# {{packageName}}

A minimal trusted-local CordisX React plugin. Its manifest is exported from
`src/{{pluginId}}.tsx`, which is also the runtime entry used by CordisX.

```bash
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`npm run dev:dry-run` bundles the plugin without launching Codex Desktop.
`npm run dev` launches the separate CordisX development host.

The template intentionally requests no platform capabilities. It contributes a
structured toolbar route and a React page body. Import React from
`cordisx/react` and components from `cordisx/ui`; do not install `react`,
`react-dom`, React type packages, or a component library. CordisX supplies one
Host React singleton and rejects a plugin artifact that bundles another copy.

The route and page use closed route-v2/page-v3 documents with separate retained
localized `title` and `description` messages. Path, outlet, page id, route id,
params, and chrome remain untranslated. CordisX owns the route, page header,
theme, error boundary, and React root cleanup; the plugin owns only the page
body component. Plugins remain trusted local code, not sandboxed code.

This generated project is Marked Template Material under the
[CordisX Independent Plugin Exception](https://github.com/cordisx/cordisx/blob/main/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md).
If it remains an independent plugin using only documented, versioned public
CordisX plugin interfaces, it may be commercial and use a license you choose.
Replace `UNLICENSED` in `package.json` with that license before distribution.
The Exception does not cover copying or modifying CordisX host/runtime/CLI code
or using private interfaces.
