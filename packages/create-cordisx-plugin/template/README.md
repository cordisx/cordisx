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
