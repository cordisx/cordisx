# Conversation UI ownership and retirement boundary

This reference describes the Host implementation boundary for
[Chatroom #74](https://github.com/cordisx/plugin-chatroom/issues/74).
This retirement candidate removes the old Host renderer and service injection.
It is not a switched product or released Host: merging and switching still
require the native replacement evidence and product acceptance below.

## Supported plugin page

Use a normal `ctx.pages.register` mount with page metadata `chrome: 'body-only'`
and a route in `main`. The plugin owns its header, timeline scroll, members,
settings, identity presentation, and composer within that body. The existing
[page and routing contract](data-contribution-routing.md) supplies an accessible
page label, a full-height body with `overflow: hidden`, route history and mount
abort/disposal. It supplies no second header or scroll container. `manager.content`
retains Host chrome; it is not this full product page seat.

`navigation-registry-base.ts` captures route owner, source, module generation,
outlet, route definition and `roomId` before invoking the page mount. The
existing source identity and Room route parameters must remain stable through
migration. Changing the renderer does not authorize combining same-name Rooms
from different sources or replacing persistent records.

Sidebar Navigation Collections remain Host-rendered and select the exact
owner-qualified route and parameters. Their group position, item actions and
native anchors do not derive from the conversation renderer. Product-owned
headers can use the existing selected collection actions through public
commands/contributions; plugins cannot query or restyle native sidebar DOM.
Entity reads continue through `entities/v1`; identity and opaque linked-session
navigation for current live Sessions use `agent-detail-navigation/v1` get/open.
Historical unloaded Sessions are outside that frozen current-only contract and
require a separately versioned successor; entity reads need no new API.

## Shared primitives and plugin presentation

`host-ui/avatar/AgentAvatar.tsx` and `OfficialOneWorksAvatarAssets.ts` own the
existing shared avatar renderer and asset resolver. The renderer accepts the
public `AgentAvatarProps['participant']` shape without a Room role or Shell
model. Its public `cordisx/ui` export, Manager content summary and collection
composite consumers remain. Styles, asset definitions, fallback and public
signatures are preserved by this extraction.

The former private `RightInspector` was tied to the Room container and had no
independent consumer. It is removed with the Room renderer; it is not exported
under a generic name. Existing public controls, including `HorizontalSplitPane`
and the controlled Markdown editor, remain available.

## Removed implementation and retained consumers

The candidate deletes all eight `agent-conversation-shell*` implementation
modules, the private page-mount brand, nine conversation renderer/interaction/
style modules, and the unused outer Room composite renderer. It removes service
creation, lifetime state, disposal, Context injection, the private conversation
command executor, and the branded navigation/chrome branch. The unused UI
fixture and thirteen dedicated Shell/renderer/editor-adapter test files retire
with their implementations. No replacement business renderer is added to Host.

The following remain for specific consumers:

- `host-ui/conversation/model.ts` remains at its original path because
  `scenario-lab-model.ts`, `scenario-lab-controller-base.ts` and
  `scenario-lab-controller.ts` call its in-memory model. It contains no renderer,
  DOM, stylesheet, service registration or persistent store. It is not a second
  Chatroom page. Removing ScenarioLab's actual model is outside this retirement.
- Shared avatar components, generic pages/routes/sidebar, entity storage,
  Agent/Session, public page composer admission, CLI execution and source
  authorization remain. Chatroom owns its own composite avatars.
- Exported Shell types are deprecated, type-only compatibility declarations;
  `Context.agentConversationShell` is no longer available. They do not install
  a service. Frozen Protocol Shell types remain referenced by the public
  `CordisXCommandContext.hostContext` union and the scenario model. After retiring
  the private Shell executor, no production renderer emits those contexts; the
  public page composer context and its execution authorization remain in use.
  Protocol versions are not deleted or silently changed by this retirement.

## Bounded consumer audit (2026-09-09)

Chatroom `e24911008b5646c2e3a79b2410673a97e0d3d4a1` mounts
`createLazyChatroomPage` directly through `ctx.pages.register`; its production
source has no Shell service reference. Channel `4cee12e3a92eeed557bc9de8cc4792710918327a`
and CLI Proxy `1428ee205aab31df2779398cc8491879b303d1d0` were inspected from
Host's installed exact dependencies. Agent Trace
`539da1928bc2dfd113ae90c93f0a115086c96c63`, Pet
`9689fdb34a4e46e2102249df18012338a5a6a7cf`, and Ascension
`bd36754a4305c1096a84674b252377aff3049f52` were inspected from fetched main
checkouts. None references the retired Shell injection or private renderer.
This is a bounded source audit, not a claim about unknown third-party plugins.
An older Chatroom requiring Shell must migrate before using this candidate.

## Session Back behavior

Returning from a Session restores Manager history only when Manager was open at
the time of navigation. Capturing a hidden Manager would reopen its stale detail
over a plugin page on Back. The return port now captures no route while closed;
existing open-Manager detail restoration remains covered by its integration test.

## Evidence and switch gate

The requirement ledger for this preparation is:

| Requirement                        | Implementation/evidence                                                                                                                                             | Remaining gate                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Plugin header and one scroll owner | Existing `navigation.history` body-only test; sidebar bundle fixture now mounts a body-only Room with its own header/timeline                                       | Real Chatroom layout/keyboard preview                           |
| Preserve route/source and sidebar  | Existing exact-source/generation routing tests; production bundle sidebar test covers Room selection, actions, other native rows, history and body-only composition | Real native sidebar geometry and navigation                     |
| Retain shared avatar               | Extracted public shape; public UI and Manager summary tests                                                                                                         | Real themes/avatar preview                                      |
| Delete business renderer           | Renderer/service removed in the candidate; frozen type exports retained                                                                                             | Equivalent replacement evidence and explicit preview acceptance |

These tests use JSDOM and the actual renderer bundle; they do not establish a
real `app://` launch or user acceptance. Before removing the live Shell, record
exact Host/Protocol/Chatroom candidate SHAs and show cold-start historical
messages/CLI replies without duplicates, persisted-avatar details, one readable
session list and opening, input/send/actions, back navigation, sidebar states
and stable Room/source identity. The coordinating task owns that product
baseline and acceptance record. The native preview and its persistent source identity remain separate from
this candidate until the replacement gate is met. No npm publication is made.

Host PRs #270 and #335 record earlier removal/restoration decisions. They are
historical evidence, not instructions to restore the entire Host business UI
when a plugin layout regresses. Fix product presentation in its owning plugin.
