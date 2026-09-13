# Isolated game UI implementation

The independent `ctx.isolatedGameUi` capability implements the
[Protocol contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/isolated-game-ui.md).
The existing restricted-content scene renderer and its strict v1 validation
remain unchanged. This is an experimental implementation, not a published SDK.

`renderer/isolated-game-ui` owns package materialization, child SDK and
MessageChannel lifecycle. The runtime installs one service per plugin owner
and disposes it alongside the owner generation. HTML is never parsed into the
privileged document: the renderer verifies resource hashes, resolves declared
entry references to inline data resources and passes the resulting document to
an iframe with only `allow-scripts`. The first CSP precedes all author bytes.

The trusted consumer must admit the exact bundle under its product policy.
Game Room currently admits only its two locally developed resource digests;
imported HTML cannot claim admission through package metadata. An installed
trusted plugin is already privileged renderer code; this service does not
claim to sandbox that plugin or replace its permission review.

The frame cannot access the parent DOM or credentials. The CSP blocks fetch,
WebSocket and non-package resources, but self-navigation can still make a
network request. A second frame load retires the seat and reports an error;
this is recovery, not preventative egress control. A stronger adapter would
need verified pre-request navigation/network containment across frames and
browser mechanisms. Do not call this implementation a zero-egress sandbox.

The caller owns outer recovery/exit controls and server-request reconciliation.
The service owns request deduplication, projection sequence checks, read-only
fencing, size/rate limits, port disposal, generation retirement and response
classification. It never selects room/account authority from author data.
Gameplay actions remain gated by `canAct`. The separate room-action request is
gated by the current snapshot's `roomActions` list and read-only state, so
waiting-room ready, cancel-ready, start and funding navigation do not weaken
the gameplay action fence. Accepted gameplay and room actions remain locked
until a newer authoritative projection arrives.

Optional `participants` metadata is cloned and passed through the existing
snapshot channel to `GameUI.subscribe`. The service rejects unknown snapshot
and participant fields, duplicate/out-of-range `seatIndex` values, invalid
names/kinds/owner flags and unbounded or external avatar references. Avatars
use only existing data-image CSP support for PNG/JPEG/WebP base64 URLs; the
child owns missing/broken-image fallback. Total snapshot limits still apply.
Participant changes, including owner transfer, require a newer sequence and
cannot unlock pending actions at the same sequence. `isOwner` is display data;
the trusted consumer derives it from authoritative room ownership. This adds
no account identity API or permission. There is currently no supported public
getter for the native user's avatar; consumers without a real avatar source
omit it and use their ordinary fallback.
