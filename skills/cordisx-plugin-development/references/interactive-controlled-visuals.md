# Interactive controlled visuals

Read this reference when a plugin renders inside a Host-controlled visual seat
and follows pointer state, animates, or requests drag or activation. Start with
the Host's current [Composer visual reference](https://github.com/cordisx/cordisx/blob/main/.agents/docs/composer-visuals.md)
and the linked Protocol contracts. This guide explains plugin authoring and
development practice; it does not add capabilities to an older Host.

## Keep ownership explicit

- Treat rendering, pointer observation, drag, and activation as separate
  capabilities. Declare only the exact point and events the feature needs, and
  behave usefully when an optional interaction is denied or unavailable.
- Let the Host own native DOM discovery, seat bounds, normalized semantic state,
  permission review, pointer capture, keyboard activation, hit targets, clipping,
  accessibility, replacement, and cleanup.
- Let the plugin own artwork, color, gaze, expressions, animation, placement,
  deformation, and release physics. Do not move product-specific animals,
  Avatar models, or animation states into the Host.
- Render only inside the supplied subtree. Do not inspect native selectors,
  create portals or external mounts, install document/window listeners, or add
  focusable controls. Keep DOM-rendered artwork inert; the Host's native control
  and authorized interaction sibling retain input semantics.

## Model public state without guessing

- Treat action, enabled, busy, and optional dictation state as independent
  inputs. An empty draft does not imply voice mode. Do not infer recording or
  transcription from button position, color, or private DOM.
- Request the smallest snapshot version that contains the required semantics.
  Dictation state does not grant draft text, transcript, audio, or microphone
  access.
- Give unavailable and unknown states a deliberate fallback. A visual should
  remain mounted through supported native layout changes such as dictation
  waveform replacement; do not key or remount it on every action transition.
- Pointer observation covers the application window rather than the desktop.
  Before the first sample, use a neutral pose. After a sample has existed, hold
  the last target while pointer data is absent and ease toward the next target
  on re-entry. Do not snap merely because the pointer left and returned.

## Keep rendering cheap and refreshable

- Put the React component in a component-only module and lazy-load heavy visual
  code from the registration loader. Do not make the plugin entry eagerly import
  Avatar editors, complete catalogs, or preview assets.
- Keep expensive model definitions, geometry, materials, and renderer options
  immutable or memoized. Project high-rate state into the smallest pose or view
  update instead of recreating the visual model.
- Coalesce pointer-driven updates through one animation frame. For a compact
  gaze effect, about 30 updates per second is usually enough; choose the actual
  limit from measured motion rather than mirroring every raw event.
- Use the renderer's noninteractive mode when the Host owns interaction. Cancel
  requestAnimationFrame callbacks, timers, springs, and subscriptions on
  unmount or generation replacement.
- Size artwork from the supplied bounds. Test protruding parts such as ears,
  shadows, and deformation at motion extremes. A transparent square viewport is
  often safer than a circular clip when the artwork extends beyond a round face.
- Treat visual defaults as recommendations. Do not turn one plugin's animal
  anatomy, palette, or expression style into a Host or Protocol requirement.

## Arbitrate gestures and animation

- Register the visible owned region with the public interaction handle. Keep it
  tight enough that an invisible overlay does not intercept the Composer.
- Treat pointer down as a possible click until movement crosses the Host drag
  threshold. Once drag is accepted, cancel click feedback; releasing a drag must
  not also activate the visual.
- Give direct manipulation priority over decorative reactions. A useful order
  is drag/release motion, click response, hover response, then idle pointer
  tracking. Express the order in one state owner instead of competing effects.
- Continue from the current animation state when a new impulse arrives. Do not
  restart a fixed keyframe from frame zero on every click, re-grab, or reversal.
  Use a monotonic timeline, spring state, or a sampled transition that can change
  target without discontinuity.
- Apply attachment transforms with the parent shape. If a head deforms, attached
  ears or decorations must follow the same transform so seams do not open.
- Base essential feedback on anatomy shared by all supported models. Optional
  parts can add character, but click, hover, and drag feedback should remain
  legible when a model has no ears or mouth.
- Respect reduced motion by shortening, simplifying, or removing decorative
  interpolation while preserving state and input feedback.

## Use the right development boundary

- Reuse the active `cordisx dev` session. A component-only edit should use Vite
  React Fast Refresh. Entry, manifest, `apply`, or registration changes replace
  that plugin generation. Project configuration, package installation, and
  Node-side launcher or bridge changes require restarting the command.
- Do not restart the native App for routine pose, styling, or component changes.
  If a candidate fails, inspect the first diagnostic and preserve the last-good
  generation instead of repeatedly relaunching.
- Exact launcher-verified local artifacts can use the Host's local-development
  authorization path. Installed plugins still require ordinary permission
  review; never broaden the local exception to file URLs or wildcard identities.

## Verify the real interaction

Alongside the general [verification checklist](verification.md), check:

- voice, send, disabled, busy, and supported dictation/waveform transitions in
  the isolated native App, including layout replacement without visual unmount;
- pointer movement beyond the Composer, application-window exit and re-entry,
  first-sample absence, denial, revocation, theme changes, and reduced motion;
- click without drag, drag beyond threshold, release, fast re-grab, repeated
  clicks during an active response, keyboard activation, and cleanup on reload;
- crop and attachment continuity at every motion extreme, with the native input
  control still operable and accessible; and
- a component Fast Refresh with retained state where claimed, one active root and
  hit region, unchanged listener counts, and no retired generation publishing
  after replacement.

Use fixtures for deterministic geometry and state transitions. Use the real
isolated `app://` path for claims about native layout, accessibility, pointer
coverage, and interaction behavior.
