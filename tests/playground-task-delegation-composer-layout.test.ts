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
    expect(toolbarStyles).toContain(
      '.pg-event-composer[data-composer-event-type="task-delegation"] { grid-template-columns: minmax(170px,.82fr) minmax(180px,1fr) minmax(240px,2.6fr) 78px; }',
    )
    expect(toolbarStyles).toContain('> .pg-event-composer-input > .pg-event-composer-delegation { display: contents; }')
    expect(toolbarStyles).toContain('background: var(--pg-panel-raised); color: var(--pg-text);')
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
    expect(styles).toContain(
      '.pg-event-composer[data-composer-event-type="task-delegation"] { grid-template-columns: minmax(132px,.82fr) minmax(180px,1.18fr) 40px; padding-inline: 12px; }',
    )
    expect(styles).toContain(
      '.pg-event-composer[data-composer-event-type="task-delegation"] .pg-event-composer-delegation > textarea { grid-column: 1 / -1; grid-row: 2; }',
    )
    expect(styles).toContain('@container pg-task-debugger (max-width: 520px)')
    expect(styles).toContain(
      '.pg-event-composer[data-composer-event-type="task-delegation"] { grid-template-columns: minmax(0,1fr) 40px; }',
    )
    expect(styles).toContain(
      '.pg-event-composer[data-composer-event-type="task-delegation"] .pg-event-composer-delegation-target { grid-column: 1 / -1; grid-row: 2; }',
    )
    expect(styles).toContain(
      '.pg-event-composer[data-composer-event-type="task-delegation"] .pg-event-composer-delegation > textarea { grid-column: 1 / -1; grid-row: 3; }',
    )
  })
})
