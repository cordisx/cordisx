# create-cordisx-plugin

Create a minimal trusted-local CordisX plugin project.

```bash
npm create cordisx-plugin@beta my-plugin
# or
npx create-cordisx-plugin@beta my-plugin
```

The `@beta` qualifier is required while npm `latest` remains the non-functional
`0.0.0` package-name reservation.

The generated project includes a version-1 manifest, a structured toolbar
route, a React page body, TypeScript build, manifest test, and
`cordisx dev --dry-run` script. The plugin installs only `cordisx`: React,
React DOM, their types, JSX runtimes, and the initial CordisX component set are
provided by the Host through `cordisx/react` and `cordisx/ui`. Plugin artifacts
that bundle a private React copy are rejected.

The generated route and page use closed route-v2/page-v3 documents with real
localized title and description dictionaries. Canonical ids, path, outlet,
params, and chrome remain untranslated machine fields. CordisX owns route and
page chrome, the React root, theme, error boundary, and lifecycle cleanup; the
plugin owns only the controlled body component. The generator does not install
to a marketplace, sign the plugin, provide a permission sandbox, or promise
hot reload.

The `create-cordisx-plugin` tool itself is licensed under
`AGPL-3.0-or-later`. Files under its marked `template` directory and projects
generated from them receive the included CordisX Independent Plugin Exception.
An independent plugin using only public, versioned CordisX plugin interfaces
may be commercial, sold, distributed through a marketplace, and licensed under
terms chosen by its author. The custom Exception is not a standard SPDX
exception and should receive legal review before stable.
