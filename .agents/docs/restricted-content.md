# Restricted scene renderer

This Host module renders an uploaded game's **declarative scene**, using trusted
DOM construction. It never imports or evaluates uploaded JavaScript and never
inserts uploaded HTML. The game server owns execution of the author's
`ui.render` source in a separate bounded QuickJS invocation with one seat's
observation. The Host independently validates the returned scene.

The public API belongs to
[Protocol restricted content v1](https://github.com/cordisx/cordisx-protocol/blob/main/types/restricted-content.v1.d.ts).
The local implementation entry is
[`restricted-content/index.ts`](../../packages/cli/src/renderer/restricted-content/index.ts).
This reference describes the implementation; integration through the Host's
public context requires the platform adapter and its own production smoke.

## Scene boundary

A scene is `{version:1,root:node}`. The five generic nodes are `text`, `stack`,
`grid`, `button`, and `number-action`. Scenes cannot contain images, URLs,
HTML, scripts, CSS, event handlers, or extra fields. A string resembling HTML
or a URL is displayed literally using `textContent`; it never creates an
element, resource request, navigation, or executable handler. The renderer
creates only divs, spans, labels, number inputs and buttons, with one fixed
Host stylesheet inside a closed shadow root. Text inherits the owning Host
surface's font and color; layout and control styles are fixed by Host.

The input limits are 64 KiB UTF-8 per scene, 1,024 scene nodes, depth 16
(root depth 1), 400 direct children, 19 grid columns, and 2,048 UTF-16 code
units per text or label. Each action is JSON limited to 4 KiB UTF-8 and depth
16. Numbers must be finite; accessors, cycles, sparse arrays, unexpected
prototypes and the keys `__proto__`, `prototype`, and `constructor` are rejected.
Validation returns a detached copy, so mutating the submitted object cannot
replace an active button's action.

`number-action` supplies a label, safe integer `min`, `max`, `step` and initial
`value`, an action object and a single `valueKey`. Step is positive, the value
lies within bounds, and its difference from min is a whole number of steps.
The range difference must remain a safe integer. The key is an ASCII identifier
of at most 64 characters, excluding the dangerous keys above. The trusted
renderer inserts the validated integer at that single key; paths and executable
expressions are unavailable. Both range endpoints must fit the final action
budget. Buttons may provide `ariaLabel` for compact visual labels such as
board cells.

The shareable
[JSON schema](../../packages/cli/src/renderer/restricted-content/scene.schema.json)
documents structural checks; its comment lists semantic limits requiring code.
[Conformance fixtures](../../packages/cli/src/renderer/restricted-content/conformance.json)
can be loaded by the game server without importing the Host package. JSON
Schema string length counts code points; the Host additionally enforces the
stricter UTF-16 code-unit limit. The schema alone is not the complete validator.

## Host integration and lifecycle

The internal `mountRestrictedScene({element,onAction,isCurrent,signal})`
creates one seat. Host supplies `isCurrent` and an abort signal from its owning
plugin generation. The trusted game client additionally closes over server,
room, match and seat identity, retiring the old mount whenever any changes.
Neither scene nor action fields select authority or receive Host credentials.

Internal `seat.publish({sequence,scene})` maps from public
`publish({sequence,payload})`. A null scene clears the surface. Sequences are
strictly increasing nonnegative safe integers. A newer malformed or rate-limited
publication consumes its sequence and clears old controls so stale actions
cannot remain active. The next publication must use a fresh sequence. Each
seat accepts at most 30 new publications per one-second fixed window. This is
a trusted projection rate bound, not a network message bridge.

`onAction({sequence,payload})` returns a promise resolving to
`{status:'accepted'|'rejected'|'uncertain'}`. Controls lock synchronously before
the callback, preventing concurrent and re-entrant duplicate submissions.
Explicit rejection restores the original enabled states only while the exact
scene revision and owner are still current. Acceptance stays locked until a
new sequence: the client should reconcile and publish that projection before
resolving. Uncertain outcomes, exceptions and malformed results remain locked;
the client must recover the same idempotency key or dispose the mount. The
renderer never automatically retries or manufactures an idempotency key.

The client adds authoritative identity and version to the action and must not
spread author fields over those values. The server remains the rule, turn,
economy and idempotency authority. A declarative action does not authorize a
Host API, filesystem operation or network request by itself.

Disposal synchronously removes the surface and abort listener. A retained old
button, detached surface, aborted owner, stale sequence or late promise result
cannot affect the current seat. The renderer creates no workers, ports,
iframes, subscriptions or timers requiring separate shutdown. The Host must
abort retired generations and the client must dispose navigation/reload seats.

## Verification and scope

`tests/restricted-content.test.ts` exercises the schema, 19×19 grid, bounds,
numeric input validation, repeated clicks, explicit rejection recovery,
uncertain outcomes, stale controls, null clearing and abort cleanup. The
opt-in `tests/restricted-content.browser.test.ts` launches a fresh disposable
Chrome profile, drives real pointer events through CDP and records requests at
a temporary loopback sink. Set `RESTRICTED_CHROME_EXECUTABLE` to the local
Chromium executable, then run both test files with Vitest. It verifies literal
HTML strings, rejected resource primitives, numeric submissions, rejection
retry and teardown. `RESTRICTED_SCENE_SCREENSHOT` optionally selects the PNG
evidence path. The fixture never attaches to an existing browser or Codex App.

This is a scene renderer, not a claim that iframe sandbox plus CSP blocks all
network egress. An earlier arbitrary HTML proposal was superseded because
self-navigation, protocol handlers and other network mechanisms require a
stronger native boundary than the current external CDP integration provides.
There is no HTML execution fallback. Server QuickJS isolation, per-seat
projection correctness, Host context wiring and real `app://` composition
remain separately verified responsibilities; fixture browser evidence does
not establish those production claims.
