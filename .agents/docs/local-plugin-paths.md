# Local plugin directories page proposal

Status: future product work; no Manager route or control is implemented.

CordisX already has two Host-owned local path inputs:

- Composition files declare local plugins through `CordisXConfig.plugins[].entry`
  in `packages/cli/src/launcher/config.ts`.
- Durable Host configuration stores the equivalent path in
  `HomeConfig.plugins[].entry` in `packages/cli/src/config/home-config.ts`.

The launcher resolves these paths relative to `configRoot` when loading a
composition. The plugin lifecycle also supports the Host-private
`inspect-local` operation for reviewing a candidate before installation. These
are existing capabilities; the Manager must not introduce another directory
registry.

A future secondary **Local plugin directories** page should project the
configured `plugins[].entry` values from the active Host profile, show their
resolved path and runtime state, and link each entry to its installed plugin.
An optional action beside plugin search may open that page or start the existing
`inspect-local` review. The action must remain unavailable until the Manager has
a Host-owned read/write projection for the active configuration and a complete
permission review path. Search, configuration editing, lifecycle status, and
installation must continue to use their existing authorities.
