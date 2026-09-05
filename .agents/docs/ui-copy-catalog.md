# UI Copy Catalog and Integration Map

## Purpose

`renderer/ui-copy.ts` is the Host-owned bilingual primitive for short primary
states and actions. It deliberately contains presentation text only. Machine
IDs, URLs, error payloads, and diagnostics stay in the surfaces that display
them as secondary detail.

Each key carries both `en` and `zh-CN`. The resolver selects `zh-CN` for a
Chinese language locale and `en` otherwise, so a primary surface never joins
two languages merely because its locale contains a region subtag.

## Semantic inventory

| Semantic group               | Required primary text                                      | Next action                           | Integration owner            |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| Marketplace source           | `No marketplaces yet` / `暂无插件商店`                     | `Add marketplace`, configuration docs | Marketplace source owner     |
| Marketplace loading          | `Loading`, `Failed to load` / `加载中`, `加载失败`         | `View error details`, reload          | Marketplace source owner     |
| Runtime                      | `No blocked plugins` / `暂无被屏蔽的插件`                  | `Restore`, runtime-status docs        | Configuration/Runtime owner  |
| Launcher                     | configuration location only                                | configuration docs                    | Configuration/Launcher owner |
| Generic availability         | `Currently unavailable` / `当前不可用`                     | relevant document or retry            | surface owner                |
| Empty or missing resource    | `No data yet`, `File not found` / `暂无数据`, `文件不存在` | create/open/retry when available      | surface owner                |
| Apply-required configuration | `Restart required` / `需要重启`                            | restart                               | Configuration owner          |
| Permission confirmation      | concise required-risk statement                            | allow or deny                         | TDesign/dialog owner         |

## Historical scan — 2026-08-25

The following table preserves the source scan from 2026-08-25. Its file names
and integration states are historical observations, not current ownership or
editing restrictions. Confirm the current implementation before changing a
surface; use the [copy principles](ui-copy-principles.md) for stable product
constraints.

| Source family at the scan                                                 | Observed localization mechanism              | Recorded integration concern                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer/manager.ts`                                                     | hard-coded Host text plus plugin projections | At the scan, integration waited for the Configuration, Marketplace source, and TDesign owners. This temporary file lock has no authority over a new task; coordinate any current overlap with its current owner. |
| `renderer/permission-authorization-dialog.ts` and `permission-locales.ts` | `CordisXLocaleCatalog` with en/zh-CN         | The dialog was assigned to the TDesign owner; its stable requirement is short risk text plus an explicit decision.                                                                                               |
| `renderer/capability-availability.ts`                                     | en/zh-CN keyed catalog                       | Keep provider/route explanations out of primary state labels; show them in detail or diagnostics.                                                                                                                |
| `renderer/extension-points.ts`                                            | localized catalog projections                | Keep semantic point IDs secondary; unavailable anchors remain `pending` plus diagnostic.                                                                                                                         |
| `plugins/cli-proxy-api` and `agent-trace-showcase`                        | plugin catalogs with en/zh-CN                | Their empty/error states already have a dedicated plugin localization boundary.                                                                                                                                  |

## Gate and handoff

Run `npm test -- --run tests/ui-copy-principles.test.ts` before integrating a
catalog key. The gate requires every catalog entry to have non-empty `en` and
`zh-CN` text and verifies the locale selector. The integrating owner must add
a focused DOM assertion for its own state; the catalog test intentionally does
not claim that an unmerged owner page already consumes the primitive.
