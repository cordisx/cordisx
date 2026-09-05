import { readFile } from 'node:fs/promises'
import path from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreviewConnectionNotice } from '../packages/cli/src/playground/client/components/PreviewConnectionNotice.js'

describe('Playground preview connection diagnosis', () => {
  it('replaces stale content with an explicit disconnected diagnostic', () => {
    const markup = renderToString(
      <PreviewConnectionNotice state="disconnected" locale="zh-CN" onRefresh={() => undefined} />,
    )
    expect(markup).toContain('data-playground-preview-connection="disconnected"')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('本地预览服务已断开')
    expect(markup).toContain('请刷新页面或等待预览服务重启')
    expect(markup).not.toContain('正在为 Lead 创建会话')
  })

  it('keeps a generation-incomplete runtime out of the stale conversation surface', async () => {
    const [app, runtime] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/runtime-store.ts'), 'utf8'),
    ])
    expect(app).toContain("hot.on('vite:ws:disconnect', disconnect)")
    expect(app).toContain("hot.on('vite:ws:connect', reconnect)")
    expect(app).toContain("runtime.status !== 'active'")
    expect(app.indexOf('previewNoticeState === undefined')).toBeLessThan(app.indexOf('<HostSeats'))
    expect(runtime.indexOf("publish({ status: 'starting', plugins: [] })")).toBeLessThan(
      runtime.indexOf("await import('virtual:cordisx-composition')"),
    )
    expect(runtime).toContain('if (pendingRuntimeGeneration !== undefined) return')
    expect(runtime).toContain('pendingRuntimeGeneration = undefined\n    refresh()')
  })

  it('renders a reconnecting generation notice with a refresh action', () => {
    const markup = renderToString(
      <PreviewConnectionNotice state="reconnecting" locale="en" onRefresh={() => undefined} />,
    )
    expect(markup).toContain('Local preview is reconnecting')
    expect(markup).toContain('runtime generation to finish')
    expect(markup).toContain('Refresh')
  })
})
