# Composer controlled visual implementation

Status: experimental. Both seats are registered in the production Cordis
composition, with exact render declarations, explicit generation-scoped pointer
review, Manager permission projection, and lazy shared-React SVG loaders. Formal
release and the full native state matrix remain pending.

The normative contract is the [Protocol visual-seat successor](https://github.com/cordisx/cordisx-protocol/blob/5f4130fc112020ba0711db5c42ca6852df085da2/.agents/docs/extension-point-visuals/README.md).
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
withdrawal. Artwork in both visual containers remains pointer inert.
The overlay is a bounded, pointer-inert 128 CSS px band immediately above the
Composer frame, aligned to its width. It remains clipped to this Host-issued
band, so plugin artwork can peek from the upper edge without covering native
input controls. Primary visuals retain their native button bounds. Overlay
snapshots and pointer normalization use the upper band's bounds, not the
native frame rectangle. Artwork size and expression remain plugin choices.
Pointer observation is normalized within the selected point bounds and separately gated.
Overlay drag and activation are available through a separately authorized Host-owned hit region; the primary point still supports observation only. Deferred completions are
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
component receives semantic `CordisXReactVisualProps.state` and optional bounded interaction handles. Import the SVG module
inside the loader; do not import editors or complete resource catalogs eagerly.
The owning fiber withdraws its registrations, and the last withdrawal disposes
the Host observers and listeners. No global observers are created for plugins
that never register a visual.

Manifest v10 declares `ui.extension-points.render` with exact points, plus an
optional `ui.extension-points.interact` declaration with exact points/events.
The Host supports `pointer.observe` at both points and `drag` / `activate` at the overlay; a required unsupported point/event pair
prevents visual activation. Optional unimplemented events remain unavailable.
Installed-plugin interaction review offers allow-once/deny-once only. Manager Allow opens a new
explicit review; it never silently grants interaction. Deny revokes the active
lease immediately. No certified implicit interaction approval is offered.

This is trusted renderer code, not an isolation sandbox. Components use the declared SVG or React DOM visual renderer without native DOM access or raw native handlers.
Both Host containers are inert and hidden from accessibility; the native button
retains focus, event handling, label and disabled/busy semantics. Busy and
enabled are independently projected from native evidence.

The Host supports the v10 browser manifest with its existing service kinds;
newer platform-provider services remain unsupported. The experimental package
parser requires a matching v10 runtime manifest in a v10 package. It never
silently treats a v10 runtime as an older manifest.

## Recommended visual defaults

Visual design belongs to the consuming plugin. The Host defines seat bounds,
input ownership and capability availability; it does not prescribe a shape,
palette, gaze transition or animation budget. The [pet plugin documentation](https://github.com/cordisx/plugin-pet/blob/main/README.md)
owns that plugin's design and implementation choices. This heading remains for
existing links.

Pointer observation covers the application window, not the desktop. Coordinates
are normalized and clamped against the selected point bounds; observation must
be declared and authorized for each participating point. An absent sample does
not prescribe a visual response.

## Verification checkpoint

The focused permission, catalog, Vite and lifecycle group passed 61 tests;
additional tests cover Cordis service projection, v10 package staging/readback,
and theme/reduced-motion state updates. The plugin production graph, typecheck
and lazy activation tests pass.

On the isolated native installation, keyboard sending preserved the real
button through send, disabled submission, stop during generation and voice.
Pointer authorization enabled observation; denial removed pointer data without
withdrawing rendering. Render denial restored the native visual;
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

## Optional dictation state

A visual registration can opt into `snapshotVersion: 2`; omitted or explicit
version 1 retains the original snapshot without dictation. Version 2 adds
`dictation` independently of primary action, enabled and busy. Current native
GLs labels and aria-busy distinguish idle, starting, recording, transcribing,
and retry. English and verified Simplified Chinese labels are recognized;
missing, ambiguous or unsupported controls project unavailable. Native dictation
controls remain intact. No audio, transcript or microphone authority is granted.

Probe fixtures verify transitions; a UI fixture is not evidence
that the assistant recorded microphone audio or exercised a real transcription.

## Local development authorization

Visual permissions use the shared [development permission policy](development-permissions.md).
The Host binds Launcher-verified local development provenance to each plugin
generation before extension-point admission. Declared rendering and supported
interaction events automatically authorize without persistent user grants.
Exact points and events, availability, explicit denial, and generation retirement
still apply. This policy does not supply a missing device or native capability.

### Waveform dictation layout

The native WLs/ULs waveform layout replaces the normal footer. Its primary
control is labelled `Transcribe and send` (Simplified Chinese `转录并发送`),
which projects primary action `send`; the exact accessible label remains
available. The separate stop/insert control still drives recording or
transcribing status, including transcription requested by either button.

The adapter selects the unique primary control within native responsive
footers rather than assuming that only one footer exists. A text editor can be
hidden or noneditable during an evidenced dictation layout; its unique bound
node still supplies draft emptiness. This exception does not apply to unknown
layouts or ambiguous editors. Regression tests replace the whole footer and
keep both roots mounted through recording and transcription. Simulated label
changes alone do not verify that native layout transition or microphone capture.

### DOM-based visual renderers

`defineReactVisual(Component, { kind: 'react-dom-v1' })` opts into a lazy,
shared-React DOM component. The omitted
option still returns `react-svg-v1`; unknown renderer kinds remain unsupported.
This is a Host-specific integration of the existing framework-neutral Protocol,
not a new semantic snapshot or permission.

The Host keeps the same inert, aria-hidden, clipped seat, native event handling,
error fallback, lazy authority checks, and generation disposal. DOM renderers
must render only their owned subtree: no portals, document/window listeners,
external mounts, native selectors, focusable interactions, or global stylesheet
overrides. Styles must be scoped to the plugin's visual subtree. This is the
existing trusted-renderer boundary, not a DOM sandbox.

Renderer dependencies, artwork and response to semantic state remain
plugin-owned. The Host supplies no renderer-specific business state machine.
Component-local tasks must be disposed on unmount.

## Overlay drag and activation

The optional React `drag` prop implements the Protocol [drag handle v1](https://github.com/cordisx/cordisx-protocol/blob/codex/composer-animal-visual/.agents/docs/extension-point-drag-v1.md).
Declare `drag` and/or `activate` in the visual registration and manifest
interaction scope. Pointer observation does not grant either capability.
The handle is absent when unsupported or unauthorized.

Report a local artwork rectangle with `setRegion`; Host creates a clipped,
accessible interaction sibling while the artwork stays inert. Only that rectangle
accepts presses. Drag-authorized overlays can use the viewport area above the
Composer, with dimensions supplied in `state.bounds`; ordinary overlays retain
the 128 px band. Plugins must place artwork relative to the supplied bounds.

Pointer capture, cancellation, arrow-key movement and keyboard activation belong
to Host. The plugin subscribes to gesture snapshots and owns placement, release
physics and expressions. A drag cannot trigger activation when released, even
if the pointer returned to its origin. Revocation, replacement and disposal
remove hit regions and retire handles. No persistent placement is implied.

Optional mixed scopes may list both points, but Host only exposes drag/activation
at the overlay. Required unsupported pairs fail activation. Native submission
and input are not intercepted by these interaction regions.

## Multiple overlay entities and context menus

The optional React `interactions` prop implements Protocol
`cordisx.extension-point-interactions/v2`. It is available on the overlay under
its existing exact `drag` and/or `activate` grants. Older Hosts omit it; visuals
must degrade explicitly. The legacy `drag` prop remains available, but do not
register both handles for the same artwork.

Call `interactions.create(entityId)` to allocate a stable independent handle.
Each handle supports the existing `setRegion`, `getSnapshot`, and `subscribe`
methods plus `setMenu(items)` and `dispose()`. Dispose when an entity leaves the
scene; at most 32 handles can be live for one registration. The Host owns bounded
hit targets, capture, keyboard handling and menu chrome outside the inert art.

Menu items support `{ id, label, disabled?, icon?, children? }` trees, bounded by
Protocol v2. Existing flat arrays remain compatible.
Labels are plain text. Menus require the `activate` grant, never just drag or
pointer observation. Right click, Context Menu key or Shift+F10 opens a menu;
Escape closes it, arrows/Home/End navigate, and selection emits `actionId`.
Opening a menu grants no extra authority to execute a platform command.

Snapshots additionally include `hovered` and `menuOpen`. Pause autonomous scene
movement while a menu is open; process action transitions once by `sequence`.
Update menu descriptors only when their contents change, because replacing them
closes any open menu to invalidate stale actions. The Host removes every target,
menu and listener on permission withdrawal or generation disposal.

Focused tests exercise the production visual mount and controller boundaries.
Native menu positioning, themes and keyboard behavior still require isolated
app verification before claiming native acceptance.

### Icon and submenu implementation

Interaction menus implement [Protocol v2](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/extension-point-interactions-v2.md).
Flat v1-shaped arrays remain accepted; callers detect the factory version before
supplying v2 fields to older Hosts. The renderer recursively copies and validates
all items before replacing the existing menu. Host icon resolution supplies themed
SVGs without passing markup or browser objects across the capability boundary.

Each submenu has an independently viewport-clamped Host panel, sharing permission,
focus and disposal ownership with its root. Keyboard arrows navigate/open/close
levels; pointer entry opens a branch and changing siblings retires deeper panels.
The root lifetime owns document listeners and removes every panel on dismissal,
revocation or generation retirement. Only enabled leaf IDs reach the plugin.
