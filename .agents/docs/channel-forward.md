# Channel original-message and whole-thread forwarding

Single and merge operations are governed by
[Protocol forward v1](https://github.com/cordisx/cordisx-protocol/blob/6046773b7b1cfadfe8b6dce571003d4b852725fe/.agents/docs/channel-runtime/forward-v1.md).
It does not grant authority or establish live credential/platform verification.

## Native whole-thread forwarding

`thread-forward` independently implements
[whole-thread forwarding v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/thread-forward-v1.md)
through configured Host CLI/RPC, not a new plugin runtime facade.
Input is `{account,source:{id,kind},target:{id,kind},threadId,anchorMessageId,operationId}`.
Source/target are same-account/tenant direct or group conversations. The Host
verifies the anchor's actual chat/topic association and checks authoritative
destination kind with `im.v1.chat.get`, then invokes native `im.v1.thread.forward`.
It never replays child messages, substitutes ordinary
forwarding, switches identity or targets another topic.

Source requires `forward-read`; target requires explicit `thread-forward`.
Platform message-read, chat-metadata-read and native forwarding permissions
also apply. Missing chat mode fails closed; neither caller-supplied kind nor a
display directory can bypass kind-specific policy. Unrelated metadata is not disclosed.
Send/single/merge grants do not grant this mutation. Policy, readiness and
generation checks fence calls and disclosure. Calls have a ten-second deadline,
with eight unsettled operations per client. A late anchor cannot initiate an
effect after timeout. A timeout after effect starts records `unknown`, never replay.

`thread-forward-receipt` takes the exact original input. A separate durable
ledger binds caller session, verified actor, account and source conversation,
not changing incoming event/turn. It fingerprints topic and anchor too. Exact
duplicates remain recoverable across later inputs/restarts; changed parameters
conflict. Another caller's receipts remain inaccessible. Reauthorize even
receipt reads. Stale file locks fail closed and are never automatically removed.

`sent` requires an acknowledged native envelope with real destination ID. It
does not prove every child was inspected or platform policy preserved hidden
content. This atomic-envelope profile has no per-child partial state; ambiguous
acknowledgements are `unknown`. Discovery establishes neither permission nor
live-platform verification. Frozen single/merge receipts retain their v1 meaning.

## Choose an operation

| Intent                                    | Operation         | Boundary                                                                |
| ----------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| Write new prose or explicitly copied text | `send`            | Existing outbound content and send authorization                        |
| Forward one original platform message     | `forward`         | One source ID; independent source-read and single-forward authorization |
| Forward originals as one merged bundle    | `merge-forward`   | Ordered unique 2..100 source IDs; independent merge authorization       |
| Inspect a prior operation                 | `forward-receipt` | Exact original request and operation; no platform mutation              |
| Forward an entire native topic            | `thread-forward`  | Verified topic/anchor, independent mutation grant and durable receipt   |
| Forward into a topic                      | Unsupported       | Does not follow from ordinary reply/thread sending                      |

Only configured official Feishu/Lark adapters with a live authenticated raw
client are supported. Source and target must share adapter, account and tenant.
Targets must be `oc_` conversation IDs with direct/group kind, not user IDs,
broadcasts, reply chains or topic IDs. No Agent-owned SDK, temporary account,
new credential input, content-copy emulation or text fallback is permitted.

## Authorization

Local CLI is an authenticated local-user operation in the selected profile.
Channel-origin callers retain authenticated dispatch context and cannot choose
another source conversation. Bound callers without a current source context
fail closed. Requests cannot supply actor/admin/permission fields.

Single/merge policy uses three **explicit** command permission keys:
`forward-read` at the source, `forward` at a single destination, and
`merge-forward` at a merge destination. They are not chat slash commands.
General command or send allow rules do not grant these operations. An explicit
allow rule must include the relevant key in `commands`; its user/group,
account/tenant/conversation and kind scopes still apply, and matching deny rules
take precedence. Configure these via the existing local-user policy workflow;
agents may not modify the policy to authorize themselves.

`forward-read` intentionally authorizes the selected source IDs in the caller's
source conversation, separate from the older message-get parent-chain boundary.
It does not expand history/message-get access. Every ID is read through the
live adapter and checked against the declared source before forwarding, with
permission and connection generation rechecked before the effect.

## CLI and receipts

Use the existing configured Host, with `--profile` and, for Channel-origin work,
the issued `--context`. Example input for `cordisx channel forward --input`:

```json
{
  "account": {
    "adapterId": "feishu",
    "accountId": "bot",
    "tenantId": "tenant"
  },
  "source": { "id": "oc_source", "kind": "group" },
  "target": { "id": "oc_target", "kind": "group" },
  "messageIds": ["om_original"],
  "operationId": "forward-one"
}
```

For merge, use `merge-forward` and 2..100 unique IDs in the requested order.
For `forward-receipt`, supply **all original fields unchanged**, adding
`"operation":"forward"` or `"operation":"merge-forward"`. Only the same
authenticated caller scope can read the operation. Source and destination
permissions are rechecked even for receipt reads. A missing receipt proves
nothing; changed fields under an existing operation ID conflict.

Only `state=sent` with an actual `externalMessageId` proves full delivery.
`partial` retains the actual merged-message ID and `invalidMessageIds`, not full
success. `failed` records a definite rejection; platform failures preserve the
numeric error in `PLATFORM_FORWARD_<code>`. Unsupported message types, protected
or deleted content, and non-forwardable merged-message children are platform
restrictions, not opportunities to silently copy content. Read the actual
platform error; this Host does not claim every readable type is forwardable.

`unknown` means the effect cannot be proved. Inspect the persisted receipt and,
if necessary, investigate externally. Do not use a new operation ID to blindly
resend. There is no retry/reset operation; single/merge forwarding never replays
an uncertain effect, even after restart or expiry of platform UUID deduplication.

## Durable ledger and recovery

The profile-owned `forward.json` ledger survives service/launcher replacement.
It stores caller-scoped request fingerprints and validated receipts. Writes use
fsync plus atomic rename; an exclusive `forward.json.lock` directory protects
the entire read/check/effect/write cycle across objects and processes.
Corrupt entries fail closed instead of manufacturing success.

A crash can leave the lock behind. `FORWARD_LEDGER_LOCKED` must not be retried
with another ledger, profile or tool. There is no automatic TTL lock stealing.
Receipt queries acquire the same lock and are unavailable until an abandoned
lock is safely recovered; this version does not implement lock-free prior
receipt reads. A lock error does not imply that a forwarding effect failed.
An operator must prove all owners of that profile are stopped before manually
recovering an abandoned lock. A persisted sending operation becomes unknown,
not replayable. The bounded ledger rejects new operations when full rather than
evicting idempotency records. Keep receipts when investigating uncertain effects.

No live Channel forwarding is performed by unit tests or CI. Merge and CI
evidence do not establish a deployed runtime or live Feishu permission grant.
