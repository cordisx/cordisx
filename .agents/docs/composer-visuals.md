# Composer controlled visual implementation

Status: experimental. Both seats are registered in the production Cordis
composition, with exact render declarations, explicit generation-scoped pointer
review, Manager permission projection, and lazy shared-React SVG loaders. Formal
release and the full native state matrix remain pending.

The normative contract is the [Protocol visual-seat successor](https://github.com/cordisx/cordisx-protocol/blob/4d815609059301d3bc8edfde8c7d3d4fd47fd438/.agents/docs/extension-point-visuals/README.md).
Root and CLI use that exact experimental feature head. Channel runtime retains
its previous formal exact dependency; this change does not adopt unrelated
Channel configuration contracts. Formal dependency-pin gates remain required
before release or Mono integration.

## Responsibility map

- `adapter/composer-visual-probe.ts` exclusively owns native selectors and
  operation evidence. `composer-visual-runtime.ts` owns roots, source snapshots,
  coalescing, theme/motion, lazy module fencing, restoration and cleanup.
- `defineReactVisual` declares a component on the shared React singleton. Its
  props contain semantic state only. No native button/container/document is
  passed to a plugin component.
- The injected authority interface requires current render authorization and
  separately authorized pointer observation. `composer-visual-service.ts` binds
  these to the exact manifest, user policy and active generation. Unit-test
  authority callbacks are not production permission evidence.
- Plugin-owned SVG components contain animal resources, colors and gaze logic.
  Host code contains no animal artwork, Avatar editor or product animation.

## Native evidence and fail-closed states

Read-only inspection of installation `26.901.51231` identified the native X3
primary action control and its operation labels. Queue, steer, resume and
end-voice are separate operations; empty draft is not a reliable action signal.
The same source maps voice startup cancellation to `cancel`. English and
Simplified Chinese labels are explicitly supported; unknown locales/labels
remain unavailable.

The current non-morphing control omits `aria-busy`; its loading branch renders
the native WN spinner wrapper. The morphing branch exposes `aria-busy` directly.
The probe recognizes only these evidenced visual shapes. It requires one
visible Composer frame, footer, native primary button, editor and inner visual.
Hidden, absent or ambiguous seats never use coordinates from an unrelated node.

An isolated native `app://` launch confirmed empty-draft `voice`, enabled and
not busy, using the actual probe module. This establishes probe behavior only;
it does not prove plugin permissions, keyboard submission, production package
loading or HMR cleanup for visual registrations. No native submission receipt
has yet been established, so transient success/failure events are not emitted.

## Lifecycle and remaining delivery gates

The runtime retains the native button and restores inner visual visibility on
withdrawal. Both visual containers are pointer inert in this first runtime.
Pointer observation is normalized within the selected point bounds and separately gated.
Activate and drag remain unavailable even if declared. Deferred completions are
fenced by registration retirement and authority epoch. Native replacement
remounts the selected contribution; a renderer error restores native content.

Remaining verification: production package staging and runtime graph, native
action/keyboard/deny/theme/motion, Vite replacement and unload. The installed
app has shown both authorized visual roots with active/rendered Manager status.
This is separate from complete native matrix verification. Full owner checks and review precede
formal mainline adoption and Mono gitlinks.

## Authoring and compatibility

Plugins inject `extensionPointVisuals` and register `{ id, pointId, events? }`
with an asynchronous loader returning `defineReactVisual(Component)`. The
component receives only `CordisXReactVisualProps.state`. Import the SVG module
inside the loader; do not import editors or complete resource catalogs eagerly.
The owning fiber withdraws its registrations, and the last withdrawal disposes
the Host observers and listeners. No global observers are created for plugins
that never register a visual.

Manifest v10 declares `ui.extension-points.render` with exact points, plus an
optional `ui.extension-points.interact` declaration with exact points/events.
The Host currently supports `pointer.observe`; a required unsupported event
prevents visual activation. Optional unimplemented events remain unavailable.
Interaction review offers allow-once/deny-once only. Manager Allow opens a new
explicit review; it never silently grants interaction. Deny revokes the active
lease immediately. No certified implicit interaction approval is offered.

This is trusted renderer code, not an isolation sandbox. Components must use
SVG without native DOM access, refs, raw handlers, HTML, or external resources.
Both Host containers are inert and hidden from accessibility; the native button
retains focus, event handling, label and disabled/busy semantics. Busy and
enabled are independently projected from native evidence.

The Host supports the v10 browser manifest with its existing service kinds;
newer platform-provider services remain unsupported. The experimental package
parser requires a matching v10 runtime manifest in a v10 package. It never
silently treats a v10 runtime as an older manifest.

## Recommended visual defaults

For compact face-like Composer visuals, prefer these defaults as a starting
point. They are design suggestions, not Protocol requirements, permission
rules, schema validation, or acceptance gates. Other shapes, faces and motion
styles remain appropriate when the plugin's purpose calls for them.

- Fit the primary artwork to the actual button seat: a centered circle should
  cover the native button face without a visible underlying ring or overflow.
  Size against the provided bounds, not an assumed screen position. Keep a
  circle circular when the seat is not square.
- A simple round face with two vertical rounded-rectangle eyes, without corners,
  ears or a mouth, is the recommended minimal expression. Keep it legible at
  native button size; color can still distinguish semantic action states.
- When a face follows the pointer, declare and request `pointer.observe` for
  each participating point, including the primary point. Use only authorized
  public state. The current observation covers the application window, not the
  desktop; normalized coordinates are clamped to the point's bounds.
- Consider retaining the last gaze direction when pointer data becomes absent,
  and gently interpolating toward the next observed position (about 160 ms is
  a useful starting value). Avoid snapping on exit or reentry. Respect reduced
  motion and clear component-local state on disposal. Missing initial pointer
  data can use a neutral gaze; holding a prior direction is not new observation.
- Check fit, contrast and gaze in the real native seat, including button state
  changes, moving beyond Composer, window exit/reentry, denied observation and
  reduced motion. Preserve the existing Host accessibility and input ownership.

Artwork and easing belong to each plugin's SVG component. These recommendations
do not introduce Host-owned animal assets or force other plugins to copy one
reference implementation.

## Verification checkpoint

The focused permission, catalog, Vite and lifecycle group passed 61 tests;
additional tests cover Cordis service projection, v10 package staging/readback,
and theme/reduced-motion state updates. The plugin production graph, typecheck
and lazy activation tests pass.

On the isolated native installation, keyboard sending preserved the real
button: send (green), disabled during submission (gray), stop during generation
(red), then voice again. Pointer authorization changed gaze; denial centered
it without withdrawing rendering. Render denial restored the native visual;
plugin block removed both roots and the additional document pointer listener.
A component-only SVG edit used React Fast Refresh with the same boot/module
generation, two roots and unchanged listener count.

Cancel/queue/steer/resume/voice-ending mappings are source-evidenced, not all
exercised natively. Native busy=true and native theme/reduced-motion settings
remain outside this live checkpoint; their semantic projection is covered by
fixtures. Transient native submission receipts remain unavailable.

Full checks retain the formal Protocol pin gate. Three Manager failures were
also reproduced at the starting Host commit (plugin bundle entry, local-dev
projection and navigation menu expectations); they are separate from the
new visual tests. No release or Mono compatibility is claimed from this
experimental dependency.
