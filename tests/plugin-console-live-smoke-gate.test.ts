import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('plugin Console live smoke gate', () => {
  it('uses stable Console anchors and fails for every reported invariant', async () => {
    const source = await readFile(path.join(root, 'packages/cli/scripts/live-smoke.mjs'), 'utf8')

    expect(source).toContain("const pluginConsoleLocale = locale === 'zh-CN'")
    expect(source).toContain("kindSelect: 'API / 类型'")
    expect(source).toContain("kindSelect: 'API / type'")
    expect(source).toContain("[data-plugin-console=\"' + CSS.escape(owner) + '\"]")
    expect(source).not.toContain("[role=\"tabpanel\"][aria-label=\"运行状态\"]")
    expect(source).not.toContain('t-select[aria-label="API / 类型"]')
    expect(source).toContain('for (let attempt = 0; attempt < 3; attempt += 1)')
    expect(source).toContain("await pressKey('ArrowDown', 'ArrowDown', 40)")
    expect(source).toContain('globalThis.__cordisxRestoreSmokeTheme?.()')
    expect(source).toContain('if (toolbarTooltip.text !== null && toolbarTooltip.describedBy !== null) break')
    expect(source).toContain("document.querySelector('[data-console-action=\"pause\"]')?.focus()")
    expect(source).toContain("'plugin-console-expanded-screenshot': { type: 'string' }")
    expect(source).toContain("'--plugin-console-expanded-screenshot requires --plugin-console-exercise'")
    expect(source).toContain("document.documentElement.setAttribute('data-theme', 'light')")

    for (const assertion of [
      'before.entries', 'before.methods', 'before.sources', 'before.permissionDenied', 'before.success', 'before.failure',
      'silent.entries', 'silent.automaticWithoutConsole',
      'ui.paused', 'ui.detailOpened', 'ui.inspectorMetadataOnly', 'ui.scopedFiltered', 'ui.cleared',
      'ui.lunaOnly', 'ui.nativePayloads', 'ui.firstLineAtTop', 'ui.fillsRemainingHeight', 'ui.logsOnlyConsoleTools', 'ui.independentEntries',
      'ui.independentEntryCount', 'ui.mountedEntryCount', 'ui.levelVisuals', 'ui.objectExpanded', 'ui.coverageRemoved',
      'ui.iconToolbar', 'ui.runtimeConsoleSummary', 'ui.pointerPaused', 'ui.pointerPauseDetail.label', 'ui.pointerPauseDetail.rect',
      'ui.keyboardFocused', 'ui.keyboardResumed', 'ui.keyboardResumeDetail.label', 'ui.toolbarTooltip.text',
      'ui.toolbarTooltip.describedBy', 'ui.returnLatestVisible', 'ui.returnedToLatest', 'ui.lightTheme', 'ui.darkTheme',
      'ui.screenshotPreparedAtTop', 'ui.runtimeChrome.runtimeDetailsAbsent', 'ui.runtimeChrome.diagnosticsCollapsed', 'ui.runtimeChrome.runtimeStatusOnly',
      'ui.runtimeChrome.diagnosticsExpanded', 'ui.runtimeChrome.diagnosticsLocalized', 'ui.runtimeChrome.diagnosticsNoCjk',
      'reload.entries', 'reload.lifecycle', 'reload.terminalCount',
      'privacy.structuredOnly', 'privacy.partialObservability',
    ]) expect(source).toContain(`'${assertion}'`)

    expect(source).toContain('pluginConsoleReport = { ...pluginConsoleReport, assertions: pluginConsoleAssertions }')
    expect(source).toContain('plugin Console smoke assertions failed: ${failures.join(\', \')}')
  })
})
