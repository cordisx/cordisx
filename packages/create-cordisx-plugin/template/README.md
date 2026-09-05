# {{packageName}}

A minimal trusted-local CordisX React plugin. Its manifest is exported from
`src/{{pluginId}}.tsx`, which is also CordisX's local-development entry.
The page component lives in `src/overview-page.tsx` as a named component-only
module so local development can preserve its state with React Fast Refresh.

```bash
{{packageManager}} install
{{packageManager}} run check
{{packageManager}} run dev:dry-run
{{packageManager}} run dev
```

`{{packageManager}} run dev:dry-run` validates the plugin module graph without
launching Codex Desktop. `{{packageManager}} run dev` launches the separate
CordisX development host. Component-only modules use React Fast Refresh;
manifest, entry, and `apply()` changes replace the plugin generation.

`{{packageManager}} run build` creates a production Vite ESM graph in `dist/runtime/`.
Its stable `module.js` entry may load content-addressed JavaScript chunks, CSS,
and static assets only when an `import()` reaches them. The generated formal
`artifact.json` records that graph for packaging; declarations are kept outside
the closed graph in `dist/types/`, and `package.json#files` includes the complete
`dist/` tree. Production generations remain immutable package
artifacts and do not use the development HMR connection.

The generated config calls the public `cordisx/vite`
`cordisXPluginViteConfig()` helper. That shared author/Host pipeline owns the
output rules, virtualizes only the closed Host singleton imports, and emits the
formal `dist/runtime/artifact.json`. A portable CordisX package manifest points its
browser entry at the adjacent prebuilt `dist/runtime/module.js`; the Host validates and
retains the complete indexed graph.

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
