# CordisX Channel Runtime

Launcher-side, host-neutral Channel core and local simulator. This package is
private while lifecycle-coordinator service orchestration, production
policy/gateway/store adapters, credentials, and real platform adapters are
still being delivered.

## Status

| Area                                                                                                                     | Status                                 | Evidence or boundary                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel identity, sourced input, health snapshot, Host config/descriptor, and package-v3/manifest-v4 service declaration | implemented                            | `cordisx-protocol#46` / `7f5e9a8`; task bindings are consumer-owned                                                                                                                                              |
| Launcher-only connection config parser and redacted Host descriptor generator                                            | verified                               | focused configuration compliance tests; `secretRef` never enters the result                                                                                                                                      |
| Shared Host service-config contract                                                                                      | verified                               | maps the closed manifest `restart` declaration to `service-restart`, uses a Host-owned Schemastery projection, preserves opaque handles across non-secret CAS updates, and redacts values through the narrow API |
| Explicit no-config service declaration                                                                                   | verified                               | `kind=none` returns no descriptor or placeholder form                                                                                                                                                            |
| JSON connection store, inbox/outbox, event deduplication, audit, generation fencing, and last-good activation            | implemented                            | this package; no task bindings or routing are persisted                                                                                                                                                          |
| Local simulator connection activation, sourced event receipt, and outbound delivery                                      | verified                               | `tests/channel-runtime.integration.test.ts`                                                                                                                                                                      |
| Duplicate event, restart recovery, retry/backoff, permission denial, descriptor redaction, and generation disposal       | verified                               | `tests/channel-runtime.integration.test.ts`                                                                                                                                                                      |
| Completion/failure/approval/reply outbox delivery handles                                                                | implemented; completion/reply verified | automated Agent notification subscription and approval resolution remain planned                                                                                                                                 |
| Node Cordis `channel` service connection list, sourced-message subscription, and queued send                             | verified                               | source-bound service integration test                                                                                                                                                                            |
| Immutable launcher service artifact and authority-bound loader                                                           | verified                               | `tests/channel-service-loader.test.ts`; source entry validation, bundle/digest/store readback, exact service authority, activation, and generation disposal                                                      |
| Cross-plugin subscription across launcher restart                                                                        | experimental                           | current subscription is explicitly `live-experimental`; durable consumer checkpoints are not implemented                                                                                                         |
| Launcher lifecycle-coordinator orchestration, config writer/restart, and production policy/secret/store adapters         | planned                                | the loader exists, but normal launcher startup does not yet activate service entries and the credential broker is unavailable                                                                                    |
| Channel Manager public provider                                                                                          | verified                               | Host publishes only `channel-manager/v2`; the standalone `cordisx/plugin-channel` package owns the Manager consumer and simulator service artifact                                                               |
| Session header projection                                                                                                | planned                                | no structured Channel status/open/share contribution is registered yet                                                                                                                                           |
| Feishu/Lark, WeCom, and WeChat Service Account adapters                                                                  | planned                                | no credential, developer app, public webhook, or deployment is claimed                                                                                                                                           |
| Personal WeChat client automation                                                                                        | unavailable                            | reverse-engineered clients and unauthorized hooks are excluded                                                                                                                                                   |

`implemented` does not imply `verified`. Real platform behavior remains
unavailable until a named official adapter and credentialed smoke land.

## Configuration boundary

`parseChannelServiceConfig()` validates the version-1 launcher document and
fails closed on unknown fields, incompatible official transport modes, duplicate
connection identities, inline secret schemes, and plaintext secret-like fields.
It covers connections only. Routing, model/workspace selection, task dispatch,
notifications, and consumer retry policy are outside this service.

`projectChannelServiceConfig()` accepts an exact Host service configuration declaration. A
Host-configured service produces
`cordisx.channel-service-config-descriptor/v1`; every connection loses
`secretRef` and gains only `secretState`. A `kind=none` service produces no
descriptor and rejects a supplied placeholder config. Its Host-owned
Schemastery projection renders the connection list as a complex child page;
plugins do not provide DOM or styles. Renderer-only preferences in a separate
module should use Schemastery `Config`/`configApplies`.

The parser/projection, shared Host service-config contract, CAS/restart
conformance, and immutable package service loader are implemented and verified.

## Superseded task-dispatch material

Any older discussion below of a `ChannelTaskGateway`, routes, bindings, task
operations, model selectors, workspaces, or task notifications is historical
design material and is not part of the Channel core. The normative v1 boundary
is the Protocol #46 connection schema and the runtime behavior above. A future
consumer may own those concerns under the separate task-routing contract, but
Channel does not configure, invoke, or persist them.
Normal lifecycle-coordinator handler registration, Manager action wiring,
credential resolution, full retry policy application, and rate-limit
enforcement remain planned; this package does not claim that validated values
are already operational.

## Runtime boundary

The core receives four narrow authorities:

- `ChannelTaskGateway`: the only path to CordisX Platform/Agent task methods;
- `ChannelPermissionBroker`: source-, plugin-, generation-, capability-, and
  target-aware `ask`/`allow`/`deny` decisions;
- `JsonChannelStore`: a single-process, atomic-replacement simulator/core store;
  and
- `ChannelAdapterDefinition`: transport-specific start/send/stop lifecycle.

It receives no renderer, DOM, CDP session, raw bridge, generic app-server RPC,
provider process, or secret value. Adapter descriptors are copied through a
closed allowlist before persistence. Remote ingress is manually validated as a
closed `cordisx.channel-user-input/v1` contract and can only use `role=user`.
Attachments contain opaque quarantine handles, never URLs or local paths.

The JSON store fsyncs an atomic replacement and its parent directory for each
transaction. It is intentionally a phase-one, single-launcher implementation,
not a claim of multi-process database coordination. A production store adapter
must preserve the same transaction, replay, lease, and generation contracts.

## Cordis plugin composition

The Host registers `CordisXChannelService` as `ctx.channel` in the Node Cordis
root. Launcher-created plugin child contexts carry canonical package source,
plugin id, and generation metadata. The service derives that identity from the
requesting Context; a caller cannot pass it as an API argument.

```ts
export const inject = ['channel']

export async function apply(ctx: Context) {
  const accounts = await ctx.channel.connections.list()
  const dispose = await ctx.channel.messages.subscribe(
    { account: accounts[0].ref },
    event => console.log(event.input.source.event.eventId),
  )
  ctx.effect(() => dispose)

  await ctx.channel.messages.send({
    target,
    kind: 'reply',
    text: 'Queued through the durable outbox',
  })
}
```

The API exposes redacted connection snapshots, sourced normalized input, and
delivery handles. It never exposes the adapter connection. Adapter plugins use
`ctx.channel.adapters.register(definition)`; the registration and consumer
subscriptions are Cordis effects tied to their owning fiber.

Permissions remain separate:

- `channel.accounts.connect`: contribute/start an adapter connection;
- `channel.events.receive`: adapter-side durable platform ingress;
- `channel.accounts.read`: consumer-side redacted discovery;
- `channel.events.subscribe`: consumer-side sourced message events; and
- `channel.messages.send`: enqueue an external message.

The core rechecks send permission before claim. A delivery is cancellable while
queued/retrying. Once claimed, the result is honestly `irreversible` unless the
adapter returns a supported recall handle.

## Reliability

The runtime promises at-least-once processing plus idempotency, never
exactly-once:

- inbound uniqueness is `(adapterId, accountId, eventId)`;
- a duplicate with different normalized content fails integrity validation;
- a gateway operation receives a stable `operationId` and must be idempotent;
- expired inbox/outbox claims are recovered after restart;
- retry uses bounded exponential backoff and a terminal dead letter;
- replacement prevents the old generation from claiming work;
- a failed candidate retains the current last-good generation; and
- audit projections include caller source/plugin/generation, capability,
  complete Platform target, binding revision, event key, and outcome, without
  message content.

The cross-plugin message subscription currently runs only in process after
durable ingress acceptance. It is intentionally labeled `live-experimental`:
handler failures are isolated, but consumer cursor/ack/replay across restart is
planned.

## Simulator

`./simulator` exports a complete Host configuration/declaration, an explicit
no-config declaration, a config-derived adapter, manual clock, permission
broker, idempotent task gateway, and sourced input fixtures. It requires no
external account, secret, public callback, or network.

Run the isolated suite:

```sh
npm test -- --run tests/channel-runtime.integration.test.ts tests/channel-service-loader.test.ts tests/channel-plugin.integration.test.ts
```

Run the owning repository gate before delivery:

```sh
npm run check
```

The full architectural contract, official platform feasibility, UI plan, PR
boundaries, and validation matrix are in
`.agents/docs/channel-runtime.md`.

# Outbound media candidate

Launcher-private outbound deliveries may carry one `media` descriptor and empty
`text`. Descriptors contain an opaque `media:` handle, format, byte size, SHA-256,
and optional audio duration in milliseconds. Image support is deliberately limited
to PNG/JPEG (10,000,000 bytes); audio to existing Ogg Opus (30,000,000 bytes).
No synthesis, conversion, local paths, URLs, or arbitrary fetching is provided.
Question cards and text cannot be combined with media. Existing text-only store
rows remain compatible; media rows are validated on reopen. Dedup comparisons
include the complete descriptor, and receipts retain the existing delivery ID.

## Integration gates

This is an isolated implementation candidate, not an operational media feature.
Adapters must explicitly set `supportsOutboundMedia: true` after implementing the
media send path; otherwise the runtime refuses media before calling `send`.
The public Cordis messages facade refuses media with
`CHANNEL_MEDIA_PROTOCOL_UNAVAILABLE`. Configured CLI `send`/`send-many` remains
text-only. Diagnostic binding CLI accepts `--media <descriptor-json>` instead of
`--text`, but returns `media-authority-unavailable` without reading or uploading
anything. Neither CLI mode grants filesystem access.

The pinned Protocol revision
`a474700a998ca4fe2a61eba2776dbcdfebdb7fa6` must gain a versioned outbound media
contract before exposing media through plugins or configured Channel tools.
Required definitions include descriptor validation, source/caller-scoped handle
authorization, expiry and revocation, permission semantics, and explicit
unsupported-media responses. No public schema or capability is changed here.

## Minimal parent adapter patch

In `packages/cli/src/launcher/feishu-adapter.ts`:

1. Add a launcher-private optional `FeishuMediaAuthority` dependency; never derive
   it from a remote event, renderer path, or URL. Its `resolve(handle, target,
   maximumBytes)` must check the full account/tenant/conversation/thread and
   owning caller grant, expiry/revocation, and enforce the byte bound **before**
   allocation/read. Resolve only previously authorized quarantined handles.
2. Set connection `supportsOutboundMedia` only when that authority and the
   authenticated raw SDK client are available.
3. Inside the existing same-tenant/stopped guards and raw-client branch, call
   `prepareFeishuOutboundMedia(delivery.media, delivery.target, authority, {
   image: data => channel.rawClient.im.v1.image.create({ data }),
   file: data => channel.rawClient.im.v1.file.create({ data }) })` when media exists.
   Use its `msg_type` and `content`; otherwise keep the Markdown worker's text/card
   preparation unchanged. Reject media explicitly in the non-raw-client fallback.
4. Keep the existing SHA-256-derived delivery UUID, create/reply selection,
   `reply_in_thread`, message-ID checks, and receipt/recall mapping unchanged.
   Retry may reupload resources, but message sends must reuse that UUID. Do not
   retry with a new identity after an unknown send outcome.
5. Verify SDK argument typing, source-authority rejection, image/audio create and
   reply, unsupported fallback, retry UUID stability, and receipts in adapter
   composition tests before enabling the flag. No adapter edit is included here.

Primary API references: [upload image](https://open.larksuite.com/document/server-docs/im-v1/image/create.md),
[upload file](https://open.larksuite.com/document/server-docs/im-v1/file/create.md),
and [message content](https://open.larksuite.com/document/server-docs/im-v1/message-content-description/create_json.md).
Upload requires bot capability and resource upload permission; sending requires
the appropriate message permission. Header checks are preliminary format checks,
not complete image/audio decoding or malware scanning.

## Inbound media repair candidate

Outbound adapter wiring now uses the same quarantine authority. A launcher owner
may call `grantOutbound(attachmentHandle, sourceEvent, target)` only for a live,
owned attachment and the identical source thread. The resulting random `media:`
grant is checked again before bounded file reading/upload, expires with its
resource, and is revoked on stop. PNG/JPEG and existing Opus audio are supported;
no raw path registration or remote URL is accepted. The adapter retains its
existing UUID, reply routing and receipt handling. Public plugin/configured CLI
media remains gated pending the outbound Protocol contract; this is a working
launcher-private resend path, not a published universal media API.

SDK 1.73.0 already emits resource descriptors. The adapter discarded them,
persisting Markdown/XML-like text; the native consumer also dropped attachment
blocks. This is not an SDK image-normalization bug.

The candidate uses authenticated `im.v1.messageResource.get` with the source
message ID. Existing Protocol v1 blocks carry opaque handles, never raw paths.
Source-matched, one-use launcher tickets compose actual app-server `localImage`
inputs, or local attachment descriptions with explicit capability limitations.

| Type                         | Received             | Downloaded               | Native delivery                         | Model understands                                       |
| ---------------------------- | -------------------- | ------------------------ | --------------------------------------- | ------------------------------------------------------- |
| Text                         | SDK text             | N/A                      | Text/source/context                     | Text                                                    |
| Image                        | SDK resource         | PNG/JPEG/WebP, 10 MB cap | Actual `localImage` plus text           | Requires image-capable model; no live claim             |
| Rich post                    | Text/embedded images | Same image policy        | Text plus `localImage`                  | Same image caveat                                       |
| Audio/voice                  | SDK resource         | 30 MB cap                | Accessible local attachment description | Requires tools; no transcription or synthesis claimed   |
| File                         | SDK resource         | 30 MB cap                | Accessible local attachment description | Requires parser/tools and sandbox access                |
| Video/media                  | SDK resource         | 30 MB cap                | Accessible local attachment description | No visual video interpretation/frame extraction claimed |
| Card/location/system/unknown | SDK normalized text  | No embedded fetch        | Explicit text-only fallback             | Available text only; no actions claimed                 |
| Sticker                      | SDK descriptor       | Refused                  | Explicit unavailable fallback           | Not delivered as image                                  |

Bounds: 16 resources/message, four concurrent streams/account instance, 128
handles, 100 MB retained byte budget, 30-second stream timeout, one-hour expiry,
cleanup on adapter stop. No URLs, guessed credentials, conversion, or execution.
Format checks are preliminary, not complete decoding/security scanning. Keys are
replaced in text; stable source/resource handles preserve successful replay
fingerprints. Failed downloads remain explicit unavailable descriptions.

Parent overlaps: merge inbound imports, resource lifecycle, empty-content filter,
and `feishuInboundContent` call in `feishu-adapter.ts`; keep the Markdown worker's
outbound branch. Native integration touches `channel-native-sessions.ts` and
`agent-bridge.ts`, not memory consumer files. Existing inbound Protocol v1 covers
these blocks; no public schema/API is invented. Public handle-resolution API,
durable quarantine restart recovery, and provider capability negotiation remain
gaps. Restarted/revoked/expired handles fail explicitly rather than reconstructing
paths. Native sandbox accessibility and actual selected-model interpretation need
separate deployment evidence.

Synthetic tests cover official SDK normalization through Channel blocks into the
real Codex bridge `turn/start` request. No live upload, restart, or model vision
claim is made.
