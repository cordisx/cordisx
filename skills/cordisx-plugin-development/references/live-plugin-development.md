# Live CordisX plugin development

Use this workflow when the current session is already attached to a CordisX
development project.

## Locate the active project

If `CORDISX_DEV_ENTRY` is set, read it with `printenv CORDISX_DEV_ENTRY` and use
that exact legacy single-plugin entry. Do not guess another entry or start a
second launcher or watcher.

For config-driven development, prefer an explicit `--config` from the running
command. Otherwise walk upward from the current directory; the nearest project
wins, and within each directory prefer `.cordisx/config.json` over the
compatible `cordisx.config.json`. Resolve every plugin entry relative to that config file.
Treat `plugins[]` as the authoritative enabled-entry set; there is no separate
multi-entry environment variable.

Inspect the selected plugin entry, its nearest package and tsconfig boundary,
the project config, available README files, tests, and the request. In an
embedded project, plugin code belongs under `.cordisx/plugins/<id>` and CordisX
dependencies belong to the `.cordisx` package boundary, even when a workspace
manager links them through the business project's root lockfile.

## Implement and observe

Use public CordisX services and structured Host surfaces. Keep plugin ids equal
to their config ids, and keep product effects under the owning Cordis lifecycle.

Run the project's normal check. Saving a refresh-compatible React component
module uses Vite React Fast Refresh. Changes to the plugin entry, manifest,
`apply`, or another non-refresh boundary may stage and replace that plugin's
generation. Check the in-product result and cleanup; do not claim success from a
file write alone.

The Manager's **Reload plugin** action is a second development trigger for an
active local plugin. Use it when the task needs an explicit reload check. It
invalidates and reloads that selected development module; it does not make
install, enable, disable, or uninstall available for unmanaged local entries.

Restart `cordisx dev` only for changes outside the renderer HMR contract, such
as project config, package installation, or Node-side launcher/bridge code.
When the running session shows a failed candidate, preserve and inspect the
last-good plugin instead of repeatedly restarting over the diagnostic.

The development graph is not the production package graph. Use the generated
build command for delivery; it creates one immutable Vite graph per plugin and
keeps source-level dynamic imports, CSS, and static assets independently
loadable. Production replacement uses CordisX package generations, not the
development HMR socket.

For native behavior, verify the actual isolated `app://` App launched by
CordisX. A Playground or browser harness is useful supporting evidence only
when it exposes the same public capability.

For a native Host interaction, use only a cataloged extension point. If the
contract is unavailable in the installed CordisX version, say so plainly
instead of installing a selector or DOM fallback.

## Isolated transient canvas

For submit-triggered visual effects, use `composer.submit.effects` with
manifest v7 execution in `isolated-worker` and the single interface
`ui.transient-canvas/v1`. The Host owns the semantic submit binding, the real
transparent canvas element, stacking, pointer inertness, reduced-motion
policy, timeout, resize/unload cleanup, authorization, and generation
lifecycle. It transfers only an `OffscreenCanvas` drawing surface to the
plugin Worker.

The Worker receives no `document`, `window`, selectors, Element, stylesheet,
event object, or arbitrary Host callback. Never add a main-renderer fallback
when isolated Worker or OffscreenCanvas support is unavailable. Manifest v7
also rejects `ui.host-dom.read` and `ui.host-dom.modify`; the canvas interface
cannot be combined with either DOM capability.

The visual vocabulary is plugin-owned. Confetti, sparkles, ink, particles, or
any other drawing algorithm must not become Host protocol enums or presets.
Register a duration from 100 to 5000 ms and choose `skip` or `static` for
reduced motion. The Host deterministically presents one eligible contribution
per semantic submit and removes it at the declared deadline.

Minimal registration:

```ts
import type { TransientCanvasPluginContextV1 } from 'cordisx/contracts'

export async function apply(
  ctx: TransientCanvasPluginContextV1,
): Promise<void> {
  const handle = await ctx.transientCanvas.register({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
    schemaVersion: 1,
    id: 'my-effect',
    pointId: 'composer.submit.effects',
    durationMs: 1200,
    reducedMotion: 'static',
  }, ({ canvas, width, height, signal }) => {
    const drawing = canvas.getContext('2d')
    if (drawing === null || signal.aborted) return
    drawing.clearRect(0, 0, width, height)
    // Draw the plugin's own effect. Stop animation when signal.aborted.
  })
  ctx.onDispose(() => handle.dispose())
}
```

Every event subscription or timer not already owned by a returned CordisX
handle must be registered as a Cordis effect so plugin reload, generation
replacement, and runtime disposal remove it.
