# Conversation UI ownership and retirement boundary

This reference describes the Host implementation boundary for
[Chatroom #74](https://github.com/cordisx/plugin-chatroom/issues/74).
The migration is pending: the current Shell remains available until the
replacement passes the real product gate below. A preparation branch is not a
switched product or a released Host.

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

`host-ui/conversation/RightInspector.tsx` is private implementation, not a
public reusable inspector: both width observation and resize limits query
`.cxa-root`, and its drawer/split styles depend on the conversation container.
Its only current production callers are the conversation renderer and its
identity wrapper. Keep Chatroom's member/settings/detail UI in Chatroom; do not
export this complete business panel under a generic name. Existing public
controls, including `HorizontalSplitPane`, remain available where appropriate.
A later primitive requires a concrete gap and a small independent contract.

## Retirement candidates and retained authority

The following are deletion candidates after replacement acceptance, not an
instruction to remove a live consumer now:

- `agent-conversation-shell-mounted.tsx` and the Shell registration, base,
  projection, update and validation modules: the legacy renderer/source path.
- The remaining `host-ui/conversation` renderer, entries, interactions,
  identity panel, inspector, styles, model and command-controller modules:
  Room UI, business fields and copy. Do not retain them by renaming them.
- The corresponding Shell service composition, lifecycle registration and
  renderer-only fixtures/tests. Remove their edges together with the renderer.

Retain the extracted avatar modules, public `cordisx/ui` primitives, generic
pages/routes/sidebar, entities, detail navigation, Agent/Session, admission,
CLI execution and source authorization. In particular, `renderer/commands.ts`
and execution authority still consume frozen Shell command-context types.
Removing a renderer does not delete those types or authorize rewriting that
execution chain. The Protocol package's historical exports, schemas and
conformance are a separate compatibility boundary.

## Bounded consumer audit, 2026-09-08

Host baseline: `5836c52a78a544945c644fa5d06395ccc9f0306c`.
Protocol baseline: `06277f9d117893a9215c991db8c0881df0f0b0f3`.
All six plugin repositories registered in the Mono inventory were initialized
and their remote `main` fetched. A tracked-tree search for Shell service names,
versioned source registration, protocol specifiers and renderer/identity names
was followed by production call-site inspection.

| Plugin          | Exact fetched main                         | Result                                                                                                                                             |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chatroom        | `c92fe8bdb7633c56ad8ed02e8637f81495bfa42b` | `src/chatroom-page-surface.ts` calls `registerSourceV9(...).mount`; 24 tracked files reference the family, including shared item and command types |
| Channel         | `4cee12e3a92eeed557bc9de8cc4792710918327a` | No matching tracked references                                                                                                                     |
| CLI Proxy API   | `42e113f7d82547fd87c0578c82716dc898c29fd6` | No matching tracked references                                                                                                                     |
| Agent Trace     | `539da1928bc2dfd113ae90c93f0a115086c96c63` | No matching tracked references                                                                                                                     |
| Pet             | `1f5d671ce57796deb19127fe777d6078256d0953` | No matching tracked references                                                                                                                     |
| Codex Ascension | `bd36754a4305c1096a84674b252377aff3049f52` | No matching tracked references                                                                                                                     |

This establishes one known registered production plugin consumer at these
revisions. It does not audit third-party installations, published package
contents, unmerged branches or a future remote main. Host's `MountedConversation`
is the production renderer entry; projection/service type references are
internal dependencies, and Playground fixtures and tests are not additional
products. `HostAgentIdentityPanel` has no production call outside its own
module; its content component is called by the conversation renderer. Manager
uses the shared avatar, not that identity panel.

## Evidence and switch gate

The requirement ledger for this preparation is:

| Requirement                        | Implementation/evidence                                                                                                                                             | Remaining gate                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Plugin header and one scroll owner | Existing `navigation.history` body-only test; sidebar bundle fixture now mounts a body-only Room with its own header/timeline                                       | Real Chatroom layout/keyboard preview                           |
| Preserve route/source and sidebar  | Existing exact-source/generation routing tests; production bundle sidebar test covers Room selection, actions, other native rows, history and body-only composition | Real native sidebar geometry and navigation                     |
| Retain shared avatar               | Extracted public shape; public UI and Manager summary tests                                                                                                         | Real themes/avatar preview                                      |
| Delete business renderer           | Candidate list above; live implementation retained                                                                                                                  | Equivalent replacement evidence and explicit preview acceptance |

These tests use JSDOM and the actual renderer bundle; they do not establish a
real `app://` launch or user acceptance. Before removing the live Shell, record
exact Host/Protocol/Chatroom candidate SHAs and show cold-start historical
messages/CLI replies without duplicates, persisted-avatar details, one readable
session list and opening, input/send/actions, back navigation, sidebar states
and stable Room/source identity. The coordinating task owns that product
baseline and acceptance record. No installed App, profile, existing window or
npm publication is changed by this preparation.

Host PRs #270 and #335 record earlier removal/restoration decisions. They are
historical evidence, not instructions to restore the entire Host business UI
when a plugin layout regresses. Fix product presentation in its owning plugin.

## Unused-wrapper retirement candidate

The independent retirement candidate removes only the uncalled
`HostAgentIdentityPanel` wrapper and its props. The actual
`HostAgentIdentityContent`, Room renderer, source service and their styles stay
in place until the replacement gate. No component is renamed to retain its
business rendering under a generic public export.

A follow-up import-graph check also found `playground/scenario-lab-{model,controller,controller-base}`
consuming the Host conversation model for a debug snapshot, although the
Playground's visible seats do not render that snapshot with the old renderer.
That is an internal debug/data dependency, not another production plugin. Its
projection and associated tests must be retired or reduced together with the
model, without disturbing the mock AgentLoop command/forwarding path. Do not
mechanically delete the whole directory while that import remains. This
candidate deliberately stops at the zero-consumer wrapper and is not the final
Shell removal patch.
