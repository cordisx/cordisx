# Scoped Channel message operations

Candidate source capability, not a claim of installed or live-platform support.
Use the exact configured Host CLI/profile and incoming context. No SDK sending
or new dispatch path is introduced. Discover `help message-capabilities` first.

Every request selects `account`, `conversationId`, `kind`; Channel-originated
requests must match their authenticated source. Bound sessions cannot drop context.
Writes additionally carry stable `operationId`; reads are explicit single pages.
Check `message-operation-receipt` after uncertainty. Never create a new ID to
repeat an uncertain effect. Platform permission alternatives are informational,
not grants or proof of permission success.

| Operation                 | Candidate implementation   | Scope / limitations                                                                                                                                         |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| message-edit              | CLI + live-account adapter | Own text/post, unchanged type, bounded literal content, enterprise time window/20 edits. Native mention syntax rejected; no bypass of mention verification. |
| message-recall            | CLI + live-account adapter | Own message, enterprise recall window; not local-history deletion or admin recall of others.                                                                |
| pin-add / pin-remove      | CLI + live-account adapter | Visible exact-conversation message; platform membership and pin scopes.                                                                                     |
| pin-list                  | CLI + live-account adapter | Group only, one page <=50, optional decimal millisecond time bounds.                                                                                        |
| read-users                | CLI + live-account adapter | Own message <=7 days; one page <=50, normalized open IDs, no tenant keys. Read is not approval.                                                             |
| reaction-list             | CLI + live-account adapter | Channel callers: incoming source message only; one page <=50. Existing add/remove separate.                                                                 |
| card-update               | CLI + live-account adapter | Runtime-tracked, successfully sent plain card only; notice/status templates, no approval/ask replacement. Not generic card actions.                         |
| message-capabilities      | Operation discovery        | Implementation, scope, restrictions and permission alternatives; authorization remains not-verified.                                                        |
| message-operation-receipt | Durable readback           | Caller/account/conversation scoped; null does not prove no effect.                                                                                          |

## Durability

Profile `message-operations.json` persists reservations before effects. Exclusive
file locking serializes separate objects/processes; every access validates disk
state. Atomic replace and file/directory fsync precede submission. Up to 10,000
records retained without automatic eviction/replay. Full ledger rejects writes.
Crash-left locks reject further writes with STORE_BUSY rather than guessing that
the former writer cannot still submit. An operator must reconcile uncertain
effects before manually recovering a stale lock; agents never auto-break locks.
Disk corruption fails closed. No retention cleanup command is introduced.

## Remaining inventory (not implemented here)

| Capability                                                            | Status                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Full thread pagination, platform search, historical resource re-fetch | Unsupported public operation; separate official-body/authorization assessment needed.                               |
| Thread forwarding                                                     | Owned by forward implementation; do not infer support from reply/thread send.                                       |
| Generic card action lifecycle                                         | Unsupported; existing ask/approval callbacks remain specialized.                                                    |
| Richtext links, inline code, embedded images, code language           | Outside this change; follow exact merged outbound contract, not vendor payload support.                             |
| Native mentions                                                       | Owned by mention implementation; edit intentionally rejects native mention syntax.                                  |
| Member/directory reading                                              | Existing capability; not reimplemented.                                                                             |
| App urgent delivery                                                   | Not implemented; own-message, group urgent policy and explicit intent required.                                     |
| SMS/phone urgent delivery                                             | Not implemented/default disabled; separate scopes, corporate quota and explicit paid-contact confirmation required. |
| share_chat/share_user                                                 | Not implemented; possible later bounded authorized references, no ambient directory expansion.                      |
| Calendar/location sends                                               | No verified generic message-send path; not implemented.                                                             |
| Sticker pixel download                                                | Excluded by request.                                                                                                |

Official Feishu endpoint bodies were verified for message update/delete/read_users,
pin create/delete/list, reaction list and message create. Lark domain method
availability does not prove regional policy equivalence or live permissions.
Protocol [message operations v1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/channel-runtime/message-operations-v1.md)
owns normative semantics; tests establish implementation behavior, not live delivery.
