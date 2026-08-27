import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { primaryFor } from '../packages/cli/src/renderer/manager/model/routes.js'
import { AcknowledgementsPage } from '../packages/cli/src/renderer/manager/pages/AcknowledgementsPage.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('Manager acknowledgements', () => {
  it('keeps the secondary page under About and localizes both sections', () => {
    expect(primaryFor({ kind: 'about-acknowledgements' })).toBe('about')

    const zh = renderToStaticMarkup(<AcknowledgementsPage locale="zh-CN" />)
    expect(zh).toContain('仓库与工具')
    expect(zh).toContain('贡献者')
    expect(zh).toContain('Cordis')
    expect(zh).toContain('TDesign React')
    expect(zh).toContain('https://raw.githubusercontent.com/Tencent/tdesign/main/site/src/assets/logo.png')
    expect(zh).not.toContain('Material Symbols')
    expect(zh).not.toContain('CordisX 核心的可组合服务运行时。')
    expect(zh).not.toContain('Apache-2.0')
    expect(zh).not.toContain('名单由版本库数据生成')
    expect(zh).toContain('<ul class="cxr-ack-grid cxr-tool-grid"><li><a')
    expect(zh).toContain('<ul class="cxr-ack-grid cxr-contributor-grid"><li><a')
    expect(zh).toContain('YiJie')
    expect(zh).toContain('创建者与维护者')
    expect(zh).toContain('https://avatars.githubusercontent.com/u/51358815?v=4')
    expect(zh).toContain('https://github.com/NWYLZW')

    const en = renderToStaticMarkup(<AcknowledgementsPage locale="en-US" />)
    expect(en).toContain('Repositories &amp; tools')
    expect(en).toContain('Contributors')
    expect(en).toContain('Creator &amp; maintainer')
  })

  it('provides a validated CI generator for contributor data', async () => {
    const source = await readFile(path.join(projectRoot, 'packages/cli/scripts/generate-contributors.mjs'), 'utf8')
    expect(source).toContain('CORDISX_CONTRIBUTORS_JSON')
    expect(source).toContain('Contributor data must be an array with at most 500 entries')
    expect(source).toContain("url.protocol !== 'https:'")
    expect(source).toContain('contributors.generated.ts')
  })
})
