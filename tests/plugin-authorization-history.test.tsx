import React from 'react'
import { expect, it, vi } from 'vitest'
import { PluginAuthorizationHistory } from '../packages/cli/src/renderer/manager/pages/PluginAuthorizationHistory.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'

it('shows the service-reported client and leaves unconfirmed outcomes visible', async () => {
  const fixture = reactManagerFixture()
  const read = vi.fn().mockResolvedValue([{
    operation: 'install',
    client: 'codex',
    requestedAt: '2026-11-28T08:00:00.000Z',
    decisions: [{ capability: 'models.read', decision: 'allow-once' }],
  }])
  const model = managerModel(undefined, { pluginAuthorizationHistory: read })
  try {
    await fixture.render(<PluginAuthorizationHistory pluginId="demo" locale="zh-CN" model={model} />)
    const text = fixture.element('[data-plugin-authorization-history]').textContent ?? ''
    expect(text).toContain('Codex')
    expect(text).toContain('单次允许')
    expect(text).toContain('结果未确认')
    expect(read).toHaveBeenCalledWith('demo')
    await fixture.click('[data-plugin-authorization-history] button')
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    await fixture.dispose()
  }
})
