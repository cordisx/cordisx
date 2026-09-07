# Plugin Agent tools

The experimental [Protocol v1 contract](https://github.com/cordisx/cordisx-protocol/blob/a535a5b15f78e474e4a5b8248716753c82108370/.agents/docs/agent-tools/README.md)
adds plugin-owned Skill and Node CLI resources and the bound `ctx.agentTools`
service. This Host implementation supports one Skill and command per plugin.
It is an implementation checkpoint, not native integration or user acceptance.

## Resource and call path

Installed packages put `cordisx-agent-tools.json` beside `cordisx-package.json`.
The selected entry must match that exact package's entry. Direct source entries
without a matching package use the adjacent descriptor. CLI/Skill resources
stay outside the browser generation artifact root; package integrity covers
both independently. Never label a Node CLI or Markdown Skill as a browser asset.

The launcher validates descriptor-relative paths and real files, then stages
resources in its own mode-0700 temporary directory on binding. It reuses the
built-in Skill file collection and digest implementation without writing into
user Skill directories. The CLI is bundled with the current installed
`cordisx/agent-tools` client so the command's location does not depend on PATH or
an ancestor development checkout's node_modules.

A plugin registers its declared command, validates current business membership,
and binds a live owned Session before sending its first task. Host renderer
ownership uses the existing Agent/Session Runtime `ownerForSession`; launcher
principals use the existing source/generation lease authority. A private 0600
binding descriptor points to this launcher's private local socket. Only its path
is projected into Agent setup; the bearer credential never enters instructions.

A CLI subprocess calls `invokeAgentTool({bindingPath,input})`. The authority
validates its binding and dispatches through the original CDP target and
execution context to the currently registered renderer handler. The handler
gets frozen business scope independently of untrusted CLI input. This reuses
CDP transport and principal authentication, not document load/replace behavior.
There is no polling process and no second persistent message ledger. The result
is the actual handler JSON receipt. The Host does not write plugin business data.

Timeout or disconnection never retries in another renderer. An already-started
handler may have committed; callers must use plugin operation ids to determine
replay/conflict outcomes. The handler receives cancellation through AbortSignal.
Disposal, expiry, a replaced binding or an unavailable owner fails closed.
Launcher exit closes the socket and removes only its private resource tree.

## Execution and limits

The Host-private `getAgentToolSetup(sessionId)` returns verified Skill path and
content plus the exact executable argv, descriptor path and expiry. The native
transport consumes this before each actual execution. A never-bound ordinary
Session has empty setup; an expired or revoked binding throws and requires
rebind. A 30-minute lease currently bounds each new binding.

The initial supported workflow is create Session, persist the plugin's real
run/Session association, bind, then send. Resuming a revoked CLI-bound Session
remains fail-closed: a controlled recovery stage is still required. Ordinary
never-bound Session resume is unchanged. Dynamic plugin install/update and the
Playground reverse transport are not established by this initial launcher path.

The focused test invokes a real Node CLI subprocess over the real private
socket into the real renderer service; only the CDP call is substituted. It
covers owner mismatch, trusted-scope separation, resource layout, traversal and
revocation, and reruns existing built-in Skill protection checks. This is scoped
evidence. Production CDP/native composition and actual Room/Shell readback must
be validated separately with the integration owners.

## Existing Shell projection

Plugins with actual persisted command messages use `registerSourceV10` and the
Protocol v10 `plugin-command` source. The source carries Room/message/Session/
participant/member/run/operation ids and original Room sequence. The Host
checks the selected Room, message id and Agent author association, then reuses
its existing message projection and renderer. The command does not become a
SessionEvent or an acknowledgement. Older registrations retain strict source
validation; a plugin must report the missing v10 service rather than relabel a
command message. Body, timestamp and menu behavior stay in the existing Shell.

The source is a projection of the plugin's persisted fact, not proof of authority
on its own. The true write remains the authenticated command handler's Room CAS.

## Real CDP validation and fixture pitfalls

The 2026-09-07 integration checkpoint used Host
`cb6e1b420102c5323a798656f664eb4e2d0fc178`, Protocol
`7b8c81104c2ab6b301ebe6a7414d45dc2cc8f724`, and Chatroom
`2bca745adedead5a91ee9d0ba6b3d07988c9ede8`. A separate headless Chrome
profile ran the production installer and complete Host renderer runtime. A
minimal plugin fixture declared exact Session capabilities and consumed the
real Chatroom handler, Room store and v10 source. Only the Agent driver used
the existing deterministic implementation. The actual permission dialog
granted each exact Session request; no `ownsSession: () => true` or replacement
CDP bridge was used.

The real CLI subprocess received `created`, then `replayed` with the same
message id. The actual Room document and Host Shell model each contained one
message; revocation rejected the next CLI invocation. This verifies real
transport, authority, storage and model composition. It does not prove that a
native Codex model read a Skill and chose to call the CLI, visible native UI,
recovery, or user acceptance. The same Host candidate passed the full check:
274 test files, 1432 tests, release, package and installed-package validation.

When recreating this check:

- A fixture must declare the Cordis services it reads in `inject`; obtaining a
  context does not authorize reading an undeclared service.
- Do not import Host-private singleton modules into a plugin bundle for
  observation. A second copy of `plugin-agent-tools` has its own maps and can
  overwrite the receiver while observing a different registry. The native
  transport and Host runtime use one module instance. An external observer may
  observe the real launcher's binding result and call its existing setup
  operation without replacing authentication or dispatch.
- Wait for real per-Session permission requests and operate the actual test
  dialog. A denied or pending permission is not a reason to substitute the
  permission broker or an ownership predicate.
- Keep installed CLI/Skill files in the package resource closure outside the
  browser graph, and inspect the actual package. Never invent graph MIME types
  or exclude undeclared resources to make a verifier pass.
- Record the original request's target and execution context. Do not retry a
  failed reverse call in another window. Clean up only the browser profile,
  socket and resource directories created by this check.

The retained [CDP evidence](history/plugin-agent-tools-cdp-2026-09-07.json)
contains no credentials. Reproduce the single integration checkpoint with the
[owner script](../../packages/cli/scripts/plugin-agent-tools-cdp-smoke.mjs):

```sh
node packages/cli/scripts/plugin-agent-tools-cdp-smoke.mjs \
  /absolute/frozen-host-checkout /absolute/frozen-chatroom-checkout \
  /absolute/output/report.json
```

Use already-built matching checkouts. The script does not build or modify their
watched output. It creates and cleans only a separate headless Chrome profile,
Host document home and temporary fixture. `CHROME_PATH` can select the actual
Chrome executable. It operates the real observed exact-Session permission
dialog in that test browser; it never opens, inspects, or automates Codex UI.

## Shell v10 composer compatibility

Shell v10 adds the plugin command message source and inherits v9 composer
behavior. Its opt-in `page-composer-v2` mode must use the mount-bound page
adapter, including the v2 Host command context and exact route/target fences.
Keep the v9/v10 family explicit at this boundary; snapshot compatibility alone
does not establish that the send path supplies a usable context.

The regression test registers the public v9/v10 service, clicks its actual send
control, and runs the production page adapter and command handler through
`issue -> reserve -> submit`. It checks the v2 context and clears the draft
only after Host-derived completion. A stubbed adapter or a message projection
test cannot catch an omitted composer-version branch.

Changing the mounted Host conversation class is not a safe isolated component
refresh: Vite may restart the Host runtime and revoke active Agent/tool bindings.
Do not patch a user's watched tree to apply this fix. Stage a separate candidate
and preserve the running Room/profile until an explicit switch is coordinated.
