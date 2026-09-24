# Model Service Preferences

Date: 2026-09-25. Status: local source checkpoint; not integrated, installed,
released, natively verified, or user-accepted.

This record covers PREF / UX-6 for task
`01a0d44a-74f9-7861-9fbd-eb3e8f059182`. It is a dated handoff, not a public
plugin contract or permanent ownership instruction.

## Implemented Scope

- The profile-owned managed catalog document can embed an optional
  `modelPreferences` section represented by `ManagementPreferenceData`:
  `schemaVersion: 2`, a numeric section `revision`, and stable per-binding
  entries for exact model IDs, block state, and optional pin rank.
- `ManagementOverlayStore` accepts missing state as empty, validates v2 data,
  fail-closes on malformed or future data, and conservatively converts legacy
  v1 scope-keyed data only when a unique latest numeric revision exists.
- Persistence receives `(nextSection, expectedSectionRevision)` so the profile
  owner can merge the section under its existing lease and root CAS. Source
  `scopeRevision` remains command fencing and is not durable preference identity.
- Plugin preference identity is
  `plugin:${encodeURIComponent(pluginId)}:${encodeURIComponent(providerId)}`.
  Exact model IDs are not normalized. Source membership and authorization remain
  ceilings: preferences cannot create a removed model or grant source access.
- Catalog DTOs distinguish `sourceCapabilities` from
  `preferenceCapabilities` while retaining `capabilities` as a transitional
  union. Plugin sources use `sourceKind: 'plugin'`.
- Every parsed management row exposes
  `compatibility: 'supported' | 'unsupported' | 'unknown'`. Missing values from
  transitional producers become `unknown`, never `supported`. The client
  recomputes `sourceCount` from explicit supported rows and `selectableCount`
  from supported plus currently selectable rows. The consumer contract requires
  ordinary/all model lists to use the same explicit-supported rule.
  Compatibility, route availability, and user `blocked` state remain independent.
- Renderer projection intersects ordered Host rows with exact current source
  membership. Plugin views use the full plugin/provider binding identity;
  non-plugin views retain provider-based matching. Disabled models disappear
  from selection, retain recoverable preferences, and return when restored.

## Consumer Handoff

FILE-STORE must import
`packages/cli/src/model-catalog/management-overlay.ts` and consume these exports:

- `ManagementPreferenceData`
- `ManagementOverlayStore`
- `emptyManagementPreferenceData`

Construction is `new ManagementOverlayStore((next, expectedRevision) => ...,
initialSection)`. The callback must merge `next` into the profile root under the
existing lease/root CAS and reject an unexpected section revision; it must not
blindly replace the root document.

The corrected FILE-STORE source input is
`485fa1fd0c810e08877126ea0d392dcec44b8bf8`, delta
`cc34216..485fa1fd0c810e08877126ea0d392dcec44b8bf8`. Its plaintext state path is
`<profile>.lock.state.v2.json`; that filename does not change the root
`StoredState.version = 1`, and this section independently remains
`modelPreferences.schemaVersion = 2`. FILE-STORE wiring is not part of this
checkpoint and must be completed by its owner using this checkpoint's exact SHA.

UX task `01a0d44a-2f2a-75d2-850f-0671ffb76120` consumed the split capability
names at `3d41bea0a8706137e551b902ab7f7143589ee0c4`. The coordinator must combine the
checkpoints and rerun its focused UI tests. CAPS task
`01a0d44a-c7dd-7c90-91e9-50f2ee9eb588` exposes its immutable checkpoint at
`c4f0401cf98d476014c4c785505a1bdc84ba9908` (parent
`c9f5d2601ef0286f8f11b41d0504fbcfb5cf3142`) and exports
`resolveNativeModelEligibility(...)` from
`packages/cli/src/renderer/native-provider-submission-policy.ts` for UX-7..9.
This delta preserves optional `protocolCapabilities.responses` as evidence with
unknown represented by absence. CAPS must compute native compatibility;
FILE-STORE must consume the managed-source resolver; UX must filter ordinary/all
rows by explicit compatibility after combining this checkpoint. `unknown`
remains visible as unconfirmed management
data but is not selectable, and compatible blocked/offline rows remain available
for management and recovery. No consumer may infer compatibility from
`selectable` or `blocked`. A disconnected management transport retains those
diagnostic rows for management but fails closed to an empty selector projection.
ROUNDTRIP task `01a0c901-87d6-7292-91ed-2e53c2cadb41` remains a separate
integration input.

## Verification And Limits

- Five focused core/renderer files pass 28 tests covering v2 validation, legacy
  conversion, CAS, reload, plugin re-registration, exact identity isolation,
  permission revocation, transient source failure, dormant preferences,
  capability separation, and renderer membership intersection.
- Changed-file dprint, ESLint, and `git diff --check` pass using an existing
  dependency checkout without installing, copying, or linking dependencies.
- Adjacent registry/owner/composer suites were selected but could not be
  collected in this isolated worktree because `react` and
  `@cordisx/protocol/brand-icon/v1` are not resolvable here. They provide no
  passing or failing behavior evidence for this checkpoint.
- Full workspace typecheck was not established: the isolated worktree lacks its
  own dependency installation, and the reused environment reports unrelated
  Node/Protocol resolution noise. No clean full-typecheck claim is made.
- No FILE-STORE composition wiring, native submission composition, page/CSS,
  plugin-private code, real profile state, Keychain access, model request, App
  launch, package/install, release, Mono gitlink, native acceptance, or user
  acceptance is included.

## RouteSpecHandoff

- route: PREF / UX-6
- routeTaskRef: `01a0d44a-74f9-7861-9fbd-eb3e8f059182`
- sourceBase: `2a9fccd2209966780f68807867476566d2fc706b`
- formalMainAtStart: `bc54b83790ba07e28d76a7aafee929b2d5b7954a`
- outputRef: this document and the exact local checkpoint reported after commit
- coordinatorTaskRef: `01a095b6-4e9b-7341-8a17-f6d206e7f6ad`
- coordinatorContinuationRequired: true
- coordinatorMayComplete: false
