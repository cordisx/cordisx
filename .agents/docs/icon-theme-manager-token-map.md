# Manager icon token audit

Type: Host implementation reference. This table preserves the recorded Manager
icon-seat decisions; its `accepted` entries do not establish new runtime or user
acceptance. Runtime ownership and synchronization are described in
[Host icon themes](host-icon-theme.md).

`Semantic` is the
exact key from the formally merged 64-key Protocol catalog. Host tokens may
share a key only when they express the same action and do not collapse distinct
product meanings.

Reicon glyph names are Host-private implementation choices. They are not part
of the public provider contract and do not export Reicon data or SVG paths.

| Manager token | Semantic | Target semantic | Reicon glyph | Status / seat meaning |
| --- | --- | --- | --- | --- |
| `add` | `action.add` | same | `Add` | accepted |
| `back` | `action.back` | same | `ArrowLeft` | accepted |
| `capability-fallback` | `status.info` | same | `InfoCircle` | accepted generic capability information |
| `close` | `action.close` | same | `X` | accepted |
| `configuration` | `action.settings` | same | `Settings` | accepted |
| `copy` | `action.copy` | same | `Copy` | accepted |
| `delete` | `action.delete` | same | `Trash2` | accepted |
| `edit` | `action.edit` | same | `Edit` | accepted |
| `move` | `action.move` | same | `ArrangeSquare2` | accepted ArrayEditor reorder action |
| `console-clear` | `action.delete` | same | `Trash2` | accepted destructive clear action |
| `console-copy` | `action.copy` | same | `Copy` | accepted |
| `console-export` | `action.export` | same | `Export` | accepted |
| `console-follow` | `action.follow` | same | `ArrowDownSquare` | accepted follow-latest action |
| `console-pause` | `action.pause` | same | `Pause` | accepted |
| `console-resume` | `action.resume` | same | `Play` | accepted |
| `contributions` | `content.contributions` | same | `Plug` | accepted extension-point/contribution content |
| `acknowledgements` | `content.acknowledgements` | same | `HandHeart` | accepted About acknowledgements content |
| `diagnostics` | `status.error` | same | `XCircle` | accepted diagnostic/error seat |
| `document` | `content.files` | same | `File` | accepted document content |
| `external-link` | `action.external-link` | same | `ArrowUpRightSquare` | accepted |
| `launcher` | `navigation.launcher` | same | `Rocket` | accepted |
| `marketplace` | `navigation.marketplace` | same | `Shop` | accepted |
| `marketplace-certified` | `trust.certified` | same | `Verified` | accepted; distinct from official |
| `marketplace-official` | `trust.official` | same | `Crown` | accepted; distinct from certified |
| `marketplace-source-add` | `action.add` | same | `Add` | accepted |
| `marketplace-source-copy` | `action.copy` | same | `Copy` | accepted |
| `marketplace-source-edit` | `action.edit` | same | `Edit` | accepted |
| `marketplace-source-move-down` | `control.chevron-down` | same | `ArrowDown` | accepted directional control |
| `marketplace-source-move-up` | `control.chevron-up` | same | `ArrowUp` | accepted directional control |
| `models-read` | `agent.reasoning` | same | `Sparkles` | accepted agent/model capability |
| `more` | `action.more` | same | `MoreH` | accepted |
| `outlets` | `content.layers` | same | `Layers` | accepted layered extension-point content |
| `overview` | `navigation.overview` | same | `Chart` | accepted |
| `permissions` | `content.key` | same | `Key` | accepted |
| `plugins` | `navigation.plugins` | same | `Puzzle` | accepted |
| `point-info` | `status.info` | same | `InfoCircle` | accepted |
| `reload-plugin` | `action.refresh` | same | `Refresh` | accepted |
| `reset-configuration` | `action.reset` | same | `Refresh` | accepted reset action; never shares a simultaneous refresh seat |
| `routes` | `navigation.routes` | same | `Route` | accepted |
| `runtime` | `navigation.runtime` | same | `Activity` | accepted |
| `save-configuration` | `action.save` | same | `Floppy` | accepted |
| `search` | `action.search` | same | `Search` | accepted |
| `settings` | `action.settings` | same | `Settings` | accepted |
| `share-plugin` | `action.share` | same | `Share` | accepted |
| `tasks-catalog-read` | `content.panel` | same | `Component` | accepted catalog panel content |
| `tasks-content-read` | `content.files` | same | `File` | accepted task content |
| `tasks-control` | `action.settings` | same | `Settings` | accepted task-control configuration |
| `tasks-create` | `action.add` | same | `Add` | accepted create action |
| `turns-control` | `agent.turn-control` | same | `CommandSquare` | accepted agent turn control |
| `turns-submit` | `action.submit` | same | `Send` | accepted submit action |
| `authors-source` | `action.external-link` | same | `ArrowUpRightSquare` | accepted Host-local audit decision |
| `disable-plugin` | `action.disable` | same | `PowerOff` | accepted |
| `enable-plugin` | `action.enable` | same | `Power` | accepted |
| `favorite` | `action.favorite` | same | `Star` | accepted regular default state |
| `favorite-active` | `action.favorite` | same | `Star` | accepted Host-selected state |
| `import-plugin` | `action.import` | same | `Import` | accepted |
| `uninstall-plugin` | `action.delete` | same | `Trash2` | accepted destructive uninstall action |

The Host compiles all 64 keys across 3 variants and 8 states into the 1,536
tuple proof. The light/dark 16/18/24 px matrix keeps default geometry regular
and reserves filled geometry for explicit active or selected state.
