# Channel memory Protocol owner handoff

Task branch: `codex/channel-memory-design-20261122`. Host implementation changes
remain here; parent owns remote pushes and PR/MR creation after review.

## Exact public contract contribution requested

Protocol owner should add a versioned `channel-memory/v1` entry point using its
normal source/export layout (no Protocol checkout is available in this task).
Requested owning artifacts: the `channel-memory/v1` TypeScript contract module,
package export entry, contract reference and compatibility/fixture tests. Do
not invent upstream filenames without checking that owner's AGENTS and layout.

- Verified request context: namespaced bot account, actor, conversation,
  message ID, task/context epoch and Host-derived explicit own-topic intent.
  Agent input cannot supply actor/admin/intent authority.
- Memory operations and receipts: remember/search-page/navigate/get/batch/
  update/forget/index/guide, CAS revisions, byte budgets and stale cursors.
- Administrator capability: locally configured or provider-attested actor ×
  source-conversation grant permission, revision/validity, natural-language
  operation intent and destination audience. grant/revoke/list use that same
  resolver; conversation targets authorize future members only in that context.
- Human identity challenge: verified initiator and target tuples, expiry,
  single-use second-account confirmation and unbind/collision receipts.
- Persona routing: one effective persona/task, account-binding revision,
  pinned existing-task rebind semantics and separate export/share authority.
- Initialization: configured profile/context capsule with revision/context epoch,
  2,048-byte cap, first/resume/reset/safe-update delivery acknowledgement; it is
  preference data, not permission or system-policy authority.
- User-visible delivery preparation: one destination-specific style context for
  automatic final/manual send/ask/progress, unchanged semantic option values;
  no automatic second-model rewrite or persona mutation.

## Host owner files

`channel-memory-command.ts` resolves actor and configured authority;
`channel-agent-access.ts` reads the accepted incoming request;
`channel-memory-authority.ts` stores CAS local administrator grants;
`channel-memory-store.ts` owns records/grants/challenges;
`channel-memory-personas.ts` owns account/profile/task routing;
`channel-conversation-consumer.ts` composes scoped services;
`channel-conversation-tools.ts` admits local configuration and task memory calls;
`channel-native-sessions.ts` injects configured capsule before actual generation.
All reside under `packages/cli/src/launcher/`.

Current work adds internal Host seams, not a published plugin contract. Parent
must coordinate the compatible Protocol contribution before exposing a public
plugin service. Existing platform history capabilities remain unchanged.
