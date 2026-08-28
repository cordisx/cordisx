# Manager icon token audit

This is the Host-owned acceptance map for Manager icon seats. `Current semantic`
is the exact key shipped by the current Host candidate. `Target semantic` is
used only for rows blocked on the formally merged 64-key Protocol catalog; the
Host must not substitute a different 51-key semantic while it waits.

Reicon glyph names are Host-private implementation choices. They are not part
of the public provider contract and do not export Reicon data or SVG paths.

| Manager token | Current semantic | Target semantic | Reicon glyph | Status / seat meaning |
| --- | --- | --- | --- | --- |
| `add` | `action.add` | same | `Add` | accepted |
| `back` | `action.back` | same | `ArrowLeft` | accepted |
| `capability-fallback` | `status.info` | same | `InfoCircle` | accepted generic capability information |
| `close` | `action.close` | same | `X` | accepted |
| `configuration` | `action.settings` | same | `Settings` | accepted |
| `copy` | `action.copy` | same | `Copy` | accepted |
| `delete` | `action.delete` | same | `Trash2` | accepted |
| `edit` | `action.edit` | same | `Edit` | accepted |
| `move` | none (Host builtin-only) | `action.move` | `Layers` | wait for formal 64-key API; ArrayEditor reorder action; custom providers receive no request |
| `console-clear` | `action.delete` | same | `Trash2` | accepted destructive clear action |
| `console-copy` | `action.copy` | same | `Copy` | accepted |
| `console-export` | none (Host builtin-only) | `action.export` | `Folder` | wait for formal 64-key API; custom providers receive no request |
| `console-follow` | none (Host builtin-only) | `action.follow` | `Folder` | wait for formal 64-key API; follow latest output; custom providers receive no request |
| `console-pause` | none (Host builtin-only) | `action.pause` | `Clock2` | wait for formal 64-key API; custom providers receive no request |
| `console-resume` | none (Host builtin-only) | `action.resume` | `Activity` | wait for formal 64-key API; custom providers receive no request |
| `contributions` | none (Host builtin-only) | `content.contributions` | `Component` | wait for formal 64-key API; extension-point/contribution content; custom providers receive no request |
| `acknowledgements` (planned Host token) | absent | `content.acknowledgements` | `HandHeart` candidate | add only after formal 64-key API; About acknowledgements card |
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
| `turns-control` | none (Host builtin-only) | `agent.turn-control` | `Clock2` | wait for formal 64-key API; custom providers receive no request |
| `turns-submit` | none (Host builtin-only) | `action.submit` | `Activity` | wait for formal 64-key API; custom providers receive no request |
| `authors-source` | `action.external-link` | same | `ArrowUpRightSquare` | accepted Host-local audit decision |
| `disable-plugin` | none (Host builtin-only) | `action.disable` | `Clock2` | wait for formal 64-key API; custom providers receive no request |
| `enable-plugin` | none (Host builtin-only) | `action.enable` | `Activity` | wait for formal 64-key API; custom providers receive no request |
| `favorite` | none (Host builtin-only) | `action.favorite` | `InfoCircle` | wait for formal 64-key API; default state is regular; custom providers receive no request |
| `favorite-active` | none (Host builtin-only) | `action.favorite` | `InfoCircle` | wait for formal 64-key API; Host keeps selected state locally; custom providers receive no request |
| `import-plugin` | none (Host builtin-only) | `action.import` | `Folder` | wait for formal 64-key API; custom providers receive no request |
| `uninstall-plugin` | `action.delete` | same | `Trash2` | accepted destructive uninstall action |

The pending rows show the current provisional Host-only Reicon glyph, not a
semantic alias or an accepted future visual. After the formal 64-key Protocol
merge, Host must compile all 64 keys across 3 variants and 8 states, regenerate
the 1,536-tuple proof, and re-run the light/dark 16/18/24 px matrix before
marking the target semantics and glyphs accepted.
