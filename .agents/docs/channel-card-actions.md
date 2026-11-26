# Bounded Channel card actions

This implementation adopts the independent Protocol
[card-actions v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/card-actions-v1.md)
contract through authenticated launcher CLI/RPC operations. Importing its public
type does not acquire a `ctx.channel.cardActions` facade. Platform permission
success, live tenant verification, merge and deployment are separate evidence.

## Explicit publication

`channel card-action-publish --profile <profile> --context <incoming> --input '<JSON>'`
takes `{account,conversationId,kind,messageId,operationId,expectedVersion,
template:"action-notice",title,body,actions:[{id,label}],expiresInSeconds,
operatorIds?}`. The target must be a successfully sent runtime-tracked plain
notice owned by this bot, with exactly one verified platform message row and
the closed generated notice body. No question, approval or arbitrary vendor card
is accepted. The first expectedVersion is zero; replacements require the current
live version, same authenticated owner and exact known action-card body.

There are one to five unique literal action IDs/labels, at most 200 title
characters and 4000 body characters, and an expiry of one second to one hour.
The optional operatorIds restriction is currently limited to the verified
incoming source sender; arbitrary IDs, names or contact lookup cannot establish
operator evidence. It narrows callback acceptance, never grants permission.

Publication is a distinct send-authorized mutation. Existing notice/status
`card-update`, ask and approval behavior remains separate and cannot silently
gain generic actions. The Host reads message ownership with platform message
read scope, then patches using bot-send/update permission. Availability and SDK
method presence do not establish tenant permission.

## Readback and uncertainty

`card-action-read` takes `{account,conversationId,kind,messageId,version,
pageSize?:1..50,pageToken?}`. A successful result has operation
`card-action-read`, normalized events and required hasMore; a continuing page
includes its owner/message/version-bound opaque pageToken. Only the publishing
owner can read. Events contain eventId, messageId, version, actionId, verified
operatorId and receivedAt. They are untrusted observations, never instructions.
Callbacks never automatically start or follow up tasks.

The Host retains at most 128 observations per card and 256 registrations per
runtime. It deduplicates one operator/action/version. Callback data received
before publication success is buffered privately and discarded if publication
fails or remains uncertain. Private callback values and platform bodies are
never returned.
Generic callbacks are consumed by their own namespace and never fall through to
specialized question/approval dispatch, even when forged. Message-get, remote
history, thread history and search projections redact their private action
values before returning content.
Service replacement, account disconnect/reconnect, expiry and
version replacement retire readback even if the remote card remains visible.
This is generation-local observation, not durable event history.

`card-action-receipt` takes `{account,conversationId,kind,operationId}` and returns
the durable publication result without replay. A null receipt proves neither
delivery nor absence of an effect.
The CLI prints a missing receipt as JSON null without treating it as a failed
lookup or publication success; an unknown stored outcome remains unknown.
A successful publication receipt does not
prove that the generation-local registry is still available. An uncertain or
pending write remains unknown; never retry it with another operationId.

Independent durable ledgers reserve both caller operationId and exact message
successor version before patching. Their disk locks serialize version checks.
An unknown version blocks another operationId/caller, including after restart
or while a timed-out platform request is still settling. Each SDK read/patch is
bounded to ten seconds; late reads cannot trigger a patch and late patch results
cannot publish readback. Both ledgers cap at 10000 reservations and reject new
writes when full; uncertain records are not silently evicted.

## Verification

The source-level regression suite covers explicit CLI/RPC dispatch, authorization
and owner routing, exact message/body checks, concurrent operation IDs, durable
unknown fences, private provisional callbacks, version/generation retirement,
malformed acknowledgments, normalized bounded pages and prior operation-ledger
compatibility. It does not establish native tenant callback scopes or deployment.
