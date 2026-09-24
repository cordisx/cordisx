# FF Plan: Provider Favorites

## Metadata

**Feature Branch**: `codex/provider-favorites-20260925`
**Created**: 2026-09-25
**Input Source**: Coordinator delegation `PROVIDER-FAVORITE` based on integrated Host commit `2833bec7bc314e7441a92c41a4d594ddd883f477`
**Execution Root**: `/private/tmp/cordisx-provider-favorites-20260925`
**Write Scope**: Shared management contract and projection, shared preference store, native/plugin preference authorities and composite ordering, renderer provider preference projection, and focused tests. Excludes `packages/cli/src/launcher/model-catalog/managed-catalog-composition.ts`, Manager UX/CSS/ui-copy, runtime activation/projection wiring, configuration/Keychain/package/release files, live watched sources, and lower-level atomic persistence/lease logic.
**Deliverables**: Provider-favorite DTO/command/store support, native and plugin command handling, stable favorite-first management and selector ordering, compatible v1/v2 preference reads with v3 writes, focused verification evidence, isolated review, and an immutable source commit for coordinator integration.

## 1. 需求契约

- **目标**：在 Host profile 的共享 catalog preference section 中持久化 Provider 级收藏，并在管理视图和 provider selector 中按稳定收藏优先顺序投影。
- **范围**：native、managed 和 plugin provider 的共享契约；本任务实现 shared/native/plugin/composite/renderer 部分，FILE-STORE owner 实现 managed composition 的窄接线；收藏与模型 pin/block 独立；稳定 `bindingRef` 隔离；空模型 live binding 可收藏；并发 CAS 与 close fencing 沿用现有路径。
- **非目标**：Manager UI、source defaults/routing/membership/capabilities/plugin source 修改、新数据库或文件、外层 profile schema 变更、真实用户配置迁移、发布或 watched preview 修改。

### Acceptance Criteria

- **AC-001**: Given v1 或 v2 preference data，When Host 读取数据，Then 每个 binding 得到 `providerFavorite: false`，既有 model entries、binding revision 和 section revision 保留，并且后续序列化使用 v3。
- **AC-002**: Given 一个当前 live writable binding，When 提交 `setProviderFavorite`，Then 收藏值按稳定 `bindingRef` 持久化并递增既有 section/binding revision，且不改变 model pin/block entries。
- **AC-003**: Given 相同 providerId 的不同 plugin tenant 或 native/plugin provider，When 收藏其中一个 binding，Then 只有 exact `bindingRef` 对应的 view/provider 被标记和排序。
- **AC-004**: Given 一个 live 但没有 models 的 provider，When 收藏或取消收藏，Then 命令 applied；Given binding 已移除、scope 已变化或 authority 已关闭，Then 不产生成功写入。
- **AC-005**: Given 混合 native、managed 和 plugin management views，When 任意 provider 收藏状态变化，Then composites 以 canonical 原始顺序做稳定 favorite-first partition，取消收藏恢复未收藏组中的原始顺序。
- **AC-006**: Given renderer provider projections and matching management views，When provider favorites exist，Then each exact provider projection carries `providerFavorite` without changing canonical source order, fail-closed membership filtering, or model order, allowing the selector owner to apply its separate empty-first/favorite-last display partition.
- **AC-007**: Given concurrent favorite/model preference writes or a close during a queued write，When mutations resolve，Then existing optimistic revision conflict and authorization/close fencing remain observable without partial in-memory commits.

## 2. Research Context

| 项目               | 结论                                                                                                                                                                                                                                                                                                                                             | 代码证据                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 相关模块与关键符号 | `CatalogManagementView`/`CatalogManagementCommand` define Host-private DTOs; `ManagementOverlayStore` owns shared preference CAS; native/plugin authorities expose views and commands; composite authorities merge views; `applyCatalogManagementPreferences` projects selector providers.                                                       | `packages/cli/src/model-catalog-management.ts`, `packages/cli/src/model-catalog/management-overlay.ts`, `packages/cli/src/launcher/model-catalog/native-catalog-management.ts`, `packages/cli/src/model-catalog/plugin-preference-authority.ts`, `packages/cli/src/renderer/model-provider-preferences.ts` |
| 当前行为           | Preference schema v2 stores only model entries; all authorities expose model preference operations; composites concatenate owner snapshots; renderer preserves provider source order while filtering models.                                                                                                                                     | Existing code and `tests/model-catalog-management-overlay.test.ts`, `tests/model-provider-preferences.test.ts`                                                                                                                                                                                             |
| 实际影响范围       | Shared data contract/parser, persisted preference section, native/plugin mutations, merged management ordering, renderer selector ordering, and focused contract/authority tests. Managed composition consumes the contract/store but is owned by FILE-STORE.                                                                                    | Coordinator delegation and search results for operation/capability lists                                                                                                                                                                                                                                   |
| 约束与风险         | Preserve v1/v2 reads, both revision guards, exact binding identity, existing authorization and queued-write close fencing. Do not edit FILE-STORE-owned managed composition or UX/runtime/release surfaces.                                                                                                                                      | Delegation constraints; `.agents/rules/README.md`; `.agents/rules/functional-delivery.md`                                                                                                                                                                                                                  |
| Test Baseline      | Vitest core/renderer focused files cover parsing, CAS, native/plugin authorities, composites, and renderer projection. Use direct focused Vitest, changed-file ESLint/dprint, TypeScript check if focused compilation is unavailable, and `git diff --check`; no browser/native App or multi-repo verify is needed for this data-plane contract. | `vitest.config.mjs`, `.agents/docs/testing.md`, neighboring tests named below                                                                                                                                                                                                                              |

## 3. 实现策略

### 文件变更

| 文件/目录                                                              | 操作 | 说明                                                                                                    |
| ---------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/model-catalog-management.ts`                         | 修改 | Add provider favorite DTO, command, and preference capability.                                          |
| `packages/cli/src/model-catalog/management-overlay.ts`                 | 修改 | Add v3 compatible parsing/writes and favorite mutation independent of entries.                          |
| `packages/cli/src/renderer/model-catalog-projection.ts`                | 修改 | Positively parse the new DTO field and capability.                                                      |
| `packages/cli/src/launcher/model-catalog/native-catalog-management.ts` | 修改 | Expose favorite state/capability, handle commands, and stable-sort composite views.                     |
| `packages/cli/src/model-catalog/plugin-preference-authority.ts`        | 修改 | Expose favorite state/capability, handle live-binding commands, and stable-sort plugin composite views. |
| `packages/cli/src/renderer/model-provider-preferences.ts`              | 修改 | Match favorite metadata by exact management view while preserving source order.                         |
| `packages/cli/src/renderer/model-providers.ts`                         | 修改 | Carry provider favorite metadata to the selector read model without owning display order.               |
| `tests/model-catalog-management-contract.test.ts`                      | 修改 | Cover the public Host-private contract shape.                                                           |
| `tests/model-catalog-management-overlay.test.ts`                       | 修改 | Cover migration, independence, concurrency, and persistence.                                            |
| `tests/model-provider-preferences.test.ts`                             | 修改 | Cover stable ordering and binding isolation.                                                            |
| `tests/native-catalog-management.test.ts`                              | 修改 | Cover native empty-provider mutation and fencing behavior.                                              |
| `tests/plugin-model-preference-authority.test.ts`                      | 修改 | Cover plugin identity, empty-provider, removed binding, persistence, and close fencing.                 |

### 实现步骤

1. Extend the shared contract and positive renderer parser with `providerFavorite` and `setProviderFavorite`.
2. Upgrade the preference section to schema v3, migrate v1/v2 reads, and add a favorite mutation that preserves model entries and current CAS semantics.
3. Wire native and plugin views/commands, admitting empty live bindings while retaining scope, expected revision, source-current, authorization, and close checks.
4. Apply a reusable stable favorite-first partition after composite management merges, and project exact favorite metadata to renderer providers without changing selector source order.
5. Add focused regression tests for migration, independence, identity isolation, stable ordering, empty/missing bindings, concurrency, close fencing, and reopen persistence.
6. Run focused validation, inspect forbidden-file scope, complete isolated review, and commit the validated delta.

### 关键技术选择

| 选择                                                                                                    | 依据                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Persist `providerFavorite` inside each stable binding record                                            | Reuses the profile-owned shared CAS section without a new store or identity.                                                      |
| Parse v1/v2 and normalize in memory to schema v3                                                        | Old profile data remains readable; future mutations cannot erase the new field.                                                   |
| Use a stable partition only for management views; leave composer display grouping to its selector owner | Manager favorites remain first while the upward selector can independently place empty providers first and usable favorites last. |
| Authorize favorite mutation through live binding membership, not model membership                       | Empty-model providers remain favoriteable without permitting removed bindings.                                                    |
| Keep managed composition as an external narrow dependency                                               | FILE-STORE owns its legacy merge and persistence wiring per coordinator instruction.                                              |

## 4. 验证策略

### Pipeline Test Contract

| AC 编号 | Pipeline Test | 测试层级         | 基线证据                                                            | 执行入口                                                                                      | 观察点                                               | 预期结果                                                        |
| ------- | ------------- | ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| AC-001  | update        | unit             | Existing schema validation and v1 migration tests                   | `tests/model-catalog-management-overlay.test.ts`                                              | Parsed/written shape and preserved entries/revisions | v1/v2 normalize to v3 with favorite false                       |
| AC-002  | update        | unit             | Existing store CAS and overlay independence tests                   | `tests/model-catalog-management-overlay.test.ts`                                              | Favorite mutation and unchanged entries              | Favorite persists independently with revision increments        |
| AC-003  | update        | unit/integration | Existing exact plugin binding and equal provider tests              | `tests/model-provider-preferences.test.ts`, `tests/plugin-model-preference-authority.test.ts` | Only exact binding is favorite                       | Same-named providers remain isolated                            |
| AC-004  | update        | integration      | Existing native/plugin command rejection and close tests            | `tests/native-catalog-management.test.ts`, `tests/plugin-model-preference-authority.test.ts`  | Empty live provider applied; missing/closed rejected | No false successful write                                       |
| AC-005  | update        | integration      | Existing composite snapshot tests                                   | Native/plugin authority test files                                                            | View binding order                                   | Stable favorite-first partition and restoration                 |
| AC-006  | update        | unit             | Existing renderer projection ordering/filtering tests               | `tests/model-provider-preferences.test.ts`                                                    | Provider order, favorite metadata, models, defaults  | Exact favorite metadata is exposed without reordering providers |
| AC-007  | update        | unit/integration | Existing shared-store concurrency and authority close fencing tests | Overlay/native/plugin authority test files                                                    | Persist calls, conflicts, final durable state        | No partial commit or post-close success                         |

## 5. 风险与假设

- **风险**：Managed providers are not fully functional until the FILE-STORE owner lands the approved narrow composition delta; coordinator must integrate compatible immutable commits. Contract lists duplicated across parsers/fixtures can reject the new operation if missed, so focused contract searches and tests are required.
- **假设**：The FILE-STORE owner will consume the exact shared v3 binding shape and mutation contract without changing stable identity or revision semantics; no outer profile document change is required.
