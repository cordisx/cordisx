# Scoped remote message search

The configured Channel CLI exposes `message-search` as an optional read-only
operation. It implements the independent Protocol
[message search v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/message-search-v1.md),
not a new method on frozen runtime facades. A public type export alone does not
give plugins an acquisition path. Older running Hosts may return unavailable.

Input is `{account,conversationId,kind,query,startTime,endTime,pageSize?,pageToken?}`.
Start and end are integer Unix seconds encoded as strings; the interval includes
start and excludes end. Query requires non-whitespace text and at most 1024
characters. Default page size is 50, maximum 50, and continuation tokens are
opaque and at most 2048 characters. Ranking is platform-defined, not chronological.

Feishu/Lark uses the existing configured bot SDK to POST the constant relative
`/open-apis/im/v1/messages/search` endpoint with the exact conversation and time
filters. Each returned message ID is then read using the constant relative
`/open-apis/im/v1/messages/mget` endpoint, with repeated `message_ids` parameters.
No search snippets, arbitrary URLs, user-provided resource keys, contact lookup,
or alternate identity is used. Detail records must account for every unique hit
and match its identity, selected chat, and creation-time interval before any
page is disclosed. Missing or conflicting detail reads fail closed; there is no
ID-only fallback or silent invalid-hit filtering.

Each page is bounded to 1 MiB of platform response data, 50 hits, ten seconds,
and eight unsettled calls per SDK client. Timeout keeps the unsettled-call slot
occupied until that call resolves, and a late search cannot initiate detail
reads. Source account/chat/kind, current history policy, connection readiness,
adapter identity, and Host generation are checked before reads and disclosure.
Platform search/read scopes remain required. Errors are not empty successful
results, and `hasMore` is not a promise of complete history.

This operation does not grant write, forward, resource download, directory, or
generic SDK access. Content and names remain display data, not authority.
