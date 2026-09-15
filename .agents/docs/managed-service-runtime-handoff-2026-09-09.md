# Managed service runtime handoff, 2026-09-09

Status: local product checkpoint; formal promotion remains incomplete.

This dated record preserves the evidence state of the managed service runtime
checkpoint. It is not a current specification, release record, or instruction
to retain an old task lock. Protocol remains the normative contract source.

## RouteSpecHandoff

| Field                             | Value                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readDocs`                        | Host `AGENTS.md`; `.agents/rules/README.md`; `.agents/rules/documentation-maintenance.md`; `.agents/rules/functional-delivery.md`; organization formatting/file-size and risk-tiered gate rules; exact Protocol manifest-v14 schema |
| `outputRef`                       | Product commit `44abadae43a3abefc1708fee4acc83ea0a99193e`, tree `9a5183ff0a7889bb0237b977450dba024937f08b`, parent `d4d217a1f762b2ee42b9ff6003236d06fde9c4bf`                                                                       |
| `completedAt`                     | `2026-09-09T09:06:22Z`                                                                                                                                                                                                              |
| `coordinatorContinuationRequired` | `true`                                                                                                                                                                                                                              |
| `coordinatorMayComplete`          | `false`                                                                                                                                                                                                                             |

## Functional requirement coverage

| Requirement | Checkpoint coverage                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-H1       | Host injects a stable service-home-relative path without reading or requiring the target.                                                                                                       |
| FR-H2       | Current target selection precedes resource I/O and each managed service's selected-resource quota checks.                                                                                       |
| FR-H3       | Package staging and stored readback allow the deduplicated union of independently valid service resource sets while retaining per-service access isolation and package-wide conflict detection. |
| FR-H4       | Package-root port files are checked for declared length, digest, containment, mode, and bounded content before parsing.                                                                         |
| FR-H5       | Protected process bindings cannot replace `HOME`, or `USERPROFILE` on Windows, at authentication or launch boundaries.                                                                          |
| FR-H6       | Manifest ingress and stored replay both enforce at most 32 consumer grants and 1 to 32 unique operations per grant.                                                                             |
| FR-H7       | Native provider publication validates exact shape and canonical catalog identity, exposes an immutable projection, rejects duplicate ownership, and fences retired handles.                     |
| FR-H8       | Immutable package roundtrip checks path, mode, length, digest, and content, including a synthetic two-service union of 130 selected resources.                                                  |

## Checks and evidence

- Affected workspace typecheck passed.
- Six focused test files passed with 46 tests covering native publication,
  runtime security, runtime support, runtime behavior, the Node host, and
  manifest-v14 package staging and stored replay.
- Normal ESLint and dprint checks passed for the 20 checkpoint TypeScript
  files.
- `git diff --check` passed.
- The consolidated local evidence digest is
  `sha256:ea262ff03f433d03a7bc077006ae5584a9bf5c3ddaaae9b5fbac35d7256a2512`.
- The 20 reviewed product files were hashed before staging; their index blobs,
  committed blobs, and post-commit working files matched exactly. The hash
  manifest digest is
  `sha256:5a5e0c3f9f9e12c2945498c22be8766e4616e928ec4e8a8288d050d9f6f3a967`.

## Known blockers and evidence limits

- The declared Protocol dependency is pinned to the experimental review commit
  `a1127780513b76f0c3b1acee70cd638b5348c6a5` from
  `cordisx/cordisx-protocol#139`. That dependency is not merged or published,
  so formal dependency compatibility is not established.
- The complete `npm run check` gate was not run for this local checkpoint.
- Live runtime, native integration, authentication, installation, and user
  acceptance were not exercised or established.
- No push, pull request, merge, publication, release, or compatible-set update
  is represented by this record.

The coordinator must continue formal dependency alignment, complete owner
validation, review, and compatible-set delivery. This checkpoint alone cannot
complete the overall delivery.
