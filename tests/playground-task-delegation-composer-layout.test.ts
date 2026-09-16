import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Playground task delegation composer layout', () => {
  it('uses one compact tokenized four-control toolbar without changing form semantics', async () => {
    const [component, styles] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/components/ScenarioLabPage.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
    ])
    const toolbarStyles = styles.slice(
      styles.indexOf('.pg-event-composer {'),
      styles.indexOf('.pg-event-drawer {'),
    )

    expect(component).toContain('data-composer-event-type={eventType}')
    expect(component).toContain('void controller.injectTaskDelegation(delegationMemberId, delegationTask)')
    expect(component).toContain("aria-label={en ? 'Event type' : '事件类型'}")
    expect(component).toContain("aria-label={en ? 'Target entity' : '目标实体'}")
    expect(component).toContain("aria-label={en ? 'Delegated task' : '下发任务内容'}")
    expect(component).toMatch(/<button\s+className="pg-event-composer-submit"\s+type="submit"/u)

    expect(toolbarStyles).toContain('--pg-event-control-height: 40px')
    expect(toolbarStyles).toMatch(
      /\.pg-event-composer\[data-composer-event-type="task-delegation"\]\s*\{\s*grid-template-columns:\s*minmax\(170px,\s*(?:0)?\.82fr\)\s+minmax\(180px,\s*1fr\)\s+minmax\(240px,\s*2\.6fr\)\s+78px;\s*\}/u,
    )
    expect(toolbarStyles).toMatch(
      />\s*\.pg-event-composer-input\s*>\s*\.pg-event-composer-delegation\s*\{\s*display:\s*contents;\s*\}/u,
    )
    expect(toolbarStyles).toMatch(
      /background:\s*var\(--pg-panel-raised\);\s*color:\s*var\(--pg-text\);/u,
    )
    expect(toolbarStyles).toContain('.pg-event-composer-select:focus-within .t-input')
    expect(toolbarStyles).toContain('.pg-event-composer-submit:hover:not(:disabled)')
    expect(toolbarStyles).toContain('.pg-event-composer-submit:focus-visible')
    expect(toolbarStyles).toContain('.pg-event-composer-submit:disabled')
    expect(toolbarStyles).not.toMatch(/(?:#fff(?:fff)?|rgb\(255\s+255\s+255)/iu)
  })

  it('wraps delegation controls into explicit rows at narrow widths without an overflow column', async () => {
    const styles = await readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8')
    expect(styles).toContain('container: pg-task-debugger / inline-size')
    expect(styles).toContain('@container pg-task-debugger (max-width: 760px)')
    expect(styles).toMatch(
      /\.pg-event-composer\[data-composer-event-type="task-delegation"\]\s*\{\s*grid-template-columns:\s*minmax\(132px,\s*(?:0)?\.82fr\)\s+minmax\(180px,\s*1\.18fr\)\s+40px;\s*padding-inline:\s*12px;\s*\}/u,
    )
    expect(styles).toMatch(
      /\.pg-event-composer\[data-composer-event-type="task-delegation"\]\s+\.pg-event-composer-delegation\s*>\s*textarea\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*grid-row:\s*2;\s*\}/u,
    )
    expect(styles).toContain('@container pg-task-debugger (max-width: 520px)')
    expect(styles).toMatch(
      /\.pg-event-composer\[data-composer-event-type="task-delegation"\]\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+40px;\s*\}/u,
    )
    expect(styles).toMatch(
      /\.pg-event-composer\[data-composer-event-type="task-delegation"\]\s+\.pg-event-composer-delegation-target\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*grid-row:\s*2;\s*\}/u,
    )
    expect(styles).toMatch(
      /\.pg-event-composer\[data-composer-event-type="task-delegation"\]\s+\.pg-event-composer-delegation\s*>\s*textarea\s*\{\s*grid-column:\s*1\s*\/\s*-1;\s*grid-row:\s*3;\s*\}/u,
    )
  })
})
