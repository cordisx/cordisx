# create-cordisx-plugin

Create trusted-local CordisX plugins in the project shape that fits their use.

```bash
npm create cordisx-plugin@beta my-plugin
# or
npx create-cordisx-plugin@beta my-plugin
```

The `@beta` qualifier is required while npm `latest` remains the non-functional
`0.0.0` package-name reservation.

The positional command remains the short path for one standalone plugin. Two
explicit modes cover larger project shapes:

```bash
# A dedicated repository containing several independent plugin packages.
npx create-cordisx-plugin@beta --mode workspace my-suite \
  --plugin chatroom --plugin calendar

# Add a CordisX development package to an existing business project.
npx create-cordisx-plugin@beta --mode embedded ./my-business-project \
  --plugin incident-room
```

`workspace` creates one `cordisx.config.json`, one development server command,
and independently addressable packages under `plugins/<id>`. Use
`--package-manager pnpm` to also create `pnpm-workspace.yaml`; npm, Yarn, and Bun
can use the generated `package.json#workspaces` declaration.

`embedded` creates `.cordisx/config.json`, `.cordisx/package.json`, an
independent `.cordisx/tsconfig.json`, and `.cordisx/plugins/<id>`. Existing
business files are not replaced. Repeating the command with a new plugin id
appends that plugin while preserving the existing CordisX package and config
fields. The config entries are relative to `.cordisx/config.json`.

Embedded mode defaults to `--integration auto`: it joins a detected pnpm,
npm, Yarn, or Bun workspace, while retaining `.cordisx` as its own package and
TypeScript boundary. pnpm workspace integration updates the existing
`pnpm-workspace.yaml`; the other supported workspace shapes update the root
`package.json#workspaces`. Use `--integration isolated` to keep installation
inside `.cordisx`, or `--integration workspace` to require an existing
supported workspace. `--package-manager` makes non-interactive automation
deterministic. Existing pnpm comments, quoted keys, and block or flow sequence
styles are preserved. If the workspace YAML cannot be parsed or its `packages`
value cannot be updated without changing its meaning, creation stops and rolls
back without changing the business project.

Every generated plugin includes a version-1 manifest, a structured toolbar
route, and a component-only React page module. Its standalone, workspace, or
embedded environment supplies typecheck, production Vite build, manifest test,
and `cordisx dev --dry-run` commands. Production output uses a stable
`dist/module.js` entry plus content-addressed `chunks/`, `assets/`, and a Vite
`manifest.json`. CSS and static assets remain external files, and dynamic
imports load their graph only when reached. Workspaces and embedded projects
build each plugin separately so independently replaceable generations never
share output chunks.

The generated `dist/manifest.json` is Vite metadata for the author build only.
It is not the formal CordisX `artifact.json` and is never copied to the
immutable store root. A portable CordisX package manifest points its browser
entry at the prebuilt `dist/module.js`; the Host validates the complete adjacent
graph and synthesizes its own store-level `artifact.json`. Do not substitute
the Vite manifest for a CordisX package or runtime manifest.

Development remains one CordisX-owned Vite server and HMR graph using the
original source entries. The environment installs no private React runtime:
React, React DOM, their types, JSX runtimes, and the initial CordisX component
set are provided by the Host through `cordisx/react` and `cordisx/ui`. Plugin
artifacts that bundle a private React copy are rejected.

The generated route and page use closed route-v2/page-v3 documents with real
localized title and description dictionaries. Canonical ids, path, outlet,
params, and chrome remain untranslated machine fields. CordisX owns route and
page chrome, the React root, theme, error boundary, and lifecycle cleanup; the
plugin owns only the controlled body component. Local component modules are
laid out as Vite React Fast Refresh boundaries; plugin entry, manifest, and
`apply()` changes use Cordis lifecycle replacement. Installed production
packages update through normal package lifecycle rather than development HMR.
The generator does not install to a marketplace, sign the plugin, or provide a
permission sandbox.

The `create-cordisx-plugin` tool itself is licensed under
`AGPL-3.0-or-later`. Files under its marked `template` directory and projects
generated from them receive the included CordisX Independent Plugin Exception.
An independent plugin using only public, versioned CordisX plugin interfaces
may be commercial, sold, distributed through a marketplace, and licensed under
terms chosen by its author. The custom Exception is not a standard SPDX
exception and should receive legal review before stable.
