# Host icon-theme authority

Type: implementation reference for icon providers, profile preferences, and
renderer synchronization. The [architecture overview](architecture.md#host-icon-theme-authority)
links here; normative provider descriptors and semantic keys remain in
`cordisx-protocol`. The [Manager token map](icon-theme-manager-token-map.md)
records the Host's semantic seat decisions, separately from runtime proof.

The Host owns icon DOM, accessibility, sizing, color, pointer policy, and the
private Reicon fallback. Plugin themes register bounded normalized descriptors
only. Provider and principal handles, raw geometry, source paths, and callbacks
do not cross the public Manager snapshot. Manager concepts missing from the
formal Protocol catalog remain Host-private builtin glyph choices; the Host
does not route them through an unrelated semantic key to a selected provider.

Every registry creates fresh builtin and plugin provider handles. Exact handles,
Host generation, provider generation, revision, and request correlation fence
runtime selection, resolution, rollback, disposal, and late results. Durable
profile preference stores only the approved provider identity, version, and
Host-derived artifact generation. A launcher-private same-profile broadcast
caches only the highest monotonic durable revision, distributes it to active
renderers, and replays it for every boot-ready document rather than treating a
CDP target as permanently delivered. Each document creates a Host-private
epoch and completes a launcher handshake after installing its runtime
subscription. Delivery is bound to the app/profile, target, launcher session,
document epoch, and exact execution context; the renderer must acknowledge the
same epoch and a current revision at least as new as the winner. Missing,
throwing, destroyed-context, stale-revision, and malformed acknowledgements do
not count as convergence. The private document preference state machine is
`booting -> ready-pending(requiredRevision) -> synchronized(ackedRevision >=
requiredRevision) | disposed/replaced`. A pending response carries the
launcher's required durable revision and the document's acknowledged revision;
the browser never completes runtime boot from its older embedded revision alone.
It reissues the same-epoch ready signal over two bounded backoff intervals, with
two immediate delivery attempts in each round. Exhausted rounds fail boot with
an explicit pending diagnostic; a later explicit ready signal can open a fresh
bounded round without losing the cached winner.

New ready ingress revokes and aborts the previous document before serialized
receiver installation. Delivery races exact-context CDP evaluation against that
cancellation, so replacement or target close unblocks the new epoch and a late
old-context result cannot acknowledge, mutate pending state, or affect current
document accounting. Before entering that serialized installation, the
profile-scoped hub atomically reserves the target/session/document epoch. The
reservation remains profile-wide pending through receiver registration, winner
replay, and the exact ready-response acknowledgement; another renderer cannot
report complete while that document is still booting. Replacement or target
close cancels the reservation, while a successful exact-epoch acknowledgement
converts it to synchronized active state. The reservation identity also pins the
exact CDP execution context; an epoch or context replacement invalidates every
old probe, retry, and acknowledgement. Ready completion first obtains an
exact-context probe, then revalidates and, when necessary, delivers the latest
winner. Its final response uses a three-stage Host-private lease: a short
serialized prepare records the exact entry generation, document/context
identity, and required winner; the external CDP response runs outside every
profile/global lock; and a short serialized finalize accepts only the
still-current lease and an exact-epoch acknowledgement of the latest required
revision. Advancing the durable winner cache synchronously invalidates older
prepared leases before delivery begins. A held old response therefore cannot
block cache advancement or later clear booting, while a response that completes
first may linearize before the next winner. The browser reads its actual bridge
revision while processing every pending or complete leased response, retains the
exact ready request across pending/replacement delivery, and echoes the accepted
opaque lease token and monotonic lease revision in its acknowledgement. Unknown,
expired, completed, duplicate, divergent-token, and actual-revision-mismatched
responses fail closed. Finalize compares that echoed identity with the current
lease before it may clear booting.
The hub keeps durable winner state
separate from each document's acknowledged and pending revisions, lets a higher
revision supersede pending lower work, and allows explicit same-revision retry
after each bounded attempt window. A durable write response reports document
synchronization as complete or pending;
pending delivery never turns a successful atomic write into a renderer rollback.
CAS conflicts cache and attempt the durable current preference before sending
the conflict response, so response-triggered navigation cannot open a replay
window. The browser bridge also retains a winner received before the
runtime subscription exists, and startup reconciles that current value
immediately after subscribing. Each renderer rebinds the winner to its own live
handle only after an exact identity, version, artifact generation, and
active-status match. Disposed documents and closed targets cancel pending work,
and each broadcast hub is bound to exactly one app/profile. Missing, changed,
failed, or disposed providers remain on pinned Reicon; the broadcast does not
add a public Protocol surface or weaken per-process fences.
