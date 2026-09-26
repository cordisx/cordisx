import { describe, expect, it } from 'vitest'
import { maximumManagerSidebarWidth } from '../packages/cli/src/renderer/manager/sidebar-width.js'

describe('Manager sidebar width beside native titlebar', () => {
  it('keeps 320px of bounded titlebar clear of the native end control in a narrow window', () => {
    const maximum = maximumManagerSidebarWidth({
      availableWidth: 593.5,
      currentWidth: 238,
      mainLeft: 290.5,
      titlebarSafeRight: 614,
    })
    expect(maximum).toBe(241)
    expect(614 - (290.5 + maximum - 238)).toBeGreaterThanOrEqual(320)
  })

  it('permits 420px when both the content and safe titlebar spans remain wide enough', () => {
    expect(maximumManagerSidebarWidth({
      availableWidth: 1662.5,
      currentWidth: 238,
      mainLeft: 290.5,
      titlebarSafeRight: 1683,
    })).toBe(420)
  })

  it('uses the content bound for rail-only pages whose safe titlebar does not move with the sidebar', () => {
    expect(maximumManagerSidebarWidth({
      availableWidth: 650,
      currentWidth: 238,
      mainLeft: 52,
    })).toBe(330)
  })
})
