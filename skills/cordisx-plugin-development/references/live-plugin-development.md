# Live CordisX plugin development

Use this workflow when debugging or verifying a CordisX plugin on a Codex Host,
including when the current session is already attached to a development project.

## Choose debugging tools before accessing the Host

This boundary applies to the CordisX-launched Codex test instance, including
startup failures, UI inspection, screenshots, interactions, HMR and permission
failures. Never select Computer Use/CUA for this work: do not attach it to the
Codex app, enumerate its windows, capture its screen or automate its native UI.
Do not replace it with generic desktop automation or a generic browser launch.

1. Identify the authorized test instance from the CordisX launch/config and
   loaded plugin entry. Check the effective Host/CLI build, profile/data mode
   and launcher-owned debug target before attaching; a matching window title
   or an open debug port alone is insufficient.
2. Use the existing `cordisx dev` session, or its documented development launch
   when a new instance is needed and within scope. Let CordisX own Host injection,
   Vite bootstrap and reload. Read launcher/Host logs and plugin generation
   diagnostics to identify the first failing stage.
3. For runtime inspection or interaction, use CordisX's documented CDP/debug
   mechanisms on that verified target within the authorized action scope. Use
   its Host permission diagnostics to check declarations, capability availability,
   launcher provenance, grants/denials and generation state. Follow the
   [native debugging runbook](https://github.com/cordisx/cordisx/blob/main/.agents/docs/native-debugging-runbook.md)
   and the installed version's references; do not invent a private Host API or
   move debug access into a plugin as a missing-capability fallback.
4. Verify the expected plugin/build is loaded, inspect the relevant visible
   contribution and actual state transition, and check cleanup after HMR,
   replacement or stop as applicable. Logs saying ready or an HMR notification
   alone do not prove the repaired interaction. Record the mechanism and evidence
   scope; if native observation is unavailable, report that gap explicitly.

This tool choice does not bypass a permission boundary. Respect explicit user,
Host and tool restrictions on the target or action, including a denial that
applies regardless of the access route; do not retry that denied action via CDP.
Do not forge grants, bypass Host capability or authorization decisions, patch
the installed Codex app, or access unrelated profiles, windows or data. The
[documented launcher-owned native policy setup](verification.md#real-native-app-and-playground)
is part of the authorized development launch; it cannot override an applicable
user, Host or tool denial.

If CUA was selected accidentally, acknowledge the tool-selection error and read
the actual restriction before continuing. A tool-specific unsupported surface
or capability limitation does not by itself establish that the user lacks
authority to debug their own test instance. Continue through CordisX only when
the action is independently authorized and no applicable denial prohibits it;
when a restriction's scope is unclear, stop that action and report the exact
restriction while continuing permitted source/log checks. Do not turn a mistaken
tool choice into a blanket refusal of CordisX debugging.

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

Run checks appropriate to the edit and the next decision. Saving a refresh-compatible React component
module uses Vite React Fast Refresh. Changes to the plugin entry, manifest,
`apply`, or another non-refresh boundary may stage and replace that plugin's
generation. Check the in-product result and cleanup; do not claim success from a
file write alone.

A helper or model module is not necessarily a React refresh boundary. If an edit
appears stale, confirm the resolved entry and imported module in the active
runtime, then inspect Vite invalidation and the plugin generation diagnostic.
A saved source file or successful build does not prove the new helper was
loaded. Verify the selected plugin's replacement before escalating to a
renderer reload; use the boundary classification in [verification](verification.md#development-transport).

The Manager's **Reload plugin** action is a second development trigger for an
active local plugin. Use it when the task needs an explicit reload check. It
invalidates and reloads that selected development module; it does not make
install, enable, disable, or uninstall available for unmanaged local entries.

Restart `cordisx dev` only for changes outside the renderer HMR contract, such
as project config, package installation, or Node-side launcher/bridge code.
When the running session shows a failed candidate, preserve and inspect the
last-good plugin instead of repeatedly restarting over the diagnostic. A failed
candidate must not publish delayed work into its successor. If launch itself
fails, retain the first failure log and identify the failing startup phase
before retrying; a disconnected debugger alone does not establish the cause.
Keep a protected user preview available while testing a replacement in isolation.
For an independent debug instance with restart/HMR/switch authorization, proceed
without repeatedly asking about temporary drafts; preserve persistent data and
non-target instances. Build candidate Host/CLI output outside the active watched
tree, then keep the reusable launch entry on the working repair combination.
See the Host [native debugging runbook](https://github.com/cordisx/cordisx/blob/main/.agents/docs/native-debugging-runbook.md)
for launch stages and data-scope diagnosis.

The development graph is not the production package graph. Use the generated
`cordisx/vite` build config for delivery; it creates one formal, indexed,
immutable Vite graph per plugin and keeps source-level dynamic imports, CSS,
and static assets independently loadable. Production replacement uses CordisX
package generations, not the development HMR socket.

For native behavior, verify the actual isolated `app://` App launched by
CordisX. A Playground or browser harness is useful supporting evidence only
when it exposes the same public capability.

For a native Host interaction, use only a cataloged extension point. If the
contract is unavailable in the installed CordisX version, say so plainly
instead of installing a selector or DOM fallback.

## Check local development identity and permissions

A development source path alone does not establish development authority.
Confirm the launcher selected that exact config entry, its plugin id matches,
and the artifact is ready in the current session. When a capability unexpectedly
asks for permission, inspect its declaration, availability, generation and
Host authorization path before changing plugin code. Do not manufacture a
user grant or infer a wildcard exception from a file URL.

Verified local-development generations automatically authorize all declared
Host permissions before mount, including scopes introduced by HMR. The Manager
shows “Allowed for development”. If a fresh development plugin still asks,
check the running Host version and exact Launcher provenance rather than adding
plugin-specific permission workarounds. This is an ephemeral Host default, not
a persistent user grant. Explicit denial, declared scope, capability availability,
and generation retirement still apply. Installed artifacts retain ordinary
permission review. See the Host [development permission policy](https://github.com/cordisx/cordisx/blob/main/.agents/docs/development-permissions.md).

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
