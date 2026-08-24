import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MANAGER_PRODUCT_COPY, managerCopy } from '../packages/cli/src/renderer/ui-copy.js'

const managerPath = fileURLToPath(new URL('../packages/cli/src/renderer/manager.ts', import.meta.url))
const tracePath = fileURLToPath(new URL('../packages/agent-trace-showcase/src/view.ts', import.meta.url))
const cliProxyPath = fileURLToPath(new URL('../packages/cli/src/plugins/cli-proxy-api/index.ts', import.meta.url))
const principlesPath = fileURLToPath(new URL('../.agents/docs/ui-copy-principles.md', import.meta.url))

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`missing copy section: ${start}`)
  return source.slice(from, to)
}

describe('UI copy principles', () => {
  it('keeps settings primary states short and sends implementation detail to docs or expandable diagnostics', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const marketplace = section(manager, 'const renderMarketplaceSettings', 'const renderRuntimeSettings')
    const runtime = section(manager, 'const renderRuntimeSettings', 'const renderLauncherSettings')
    const launcher = section(manager, 'const renderLauncherSettings', 'const settingsTabs')

    expect(marketplace).toContain('管理插件商店来源。')
    expect(marketplace).toContain('查看配置文档')
    expect(marketplace).toContain('暂无插件商店。')
    expect(marketplace).toContain('加载失败')
    expect(marketplace).toContain('查看错误详情')
    expect(marketplace).not.toMatch(/canonical source|小写 id/)

    expect(runtime).toContain('暂无被屏蔽的插件。')
    expect(runtime).toContain('查看运行状态说明')
    expect(runtime).not.toMatch(/profile|Cordis fiber|卸载、权限隔离/)

    expect(launcher).toContain('启动器配置由 cordisx.config.json 管理。')
    expect(launcher).toContain('查看配置文档')
    expect(launcher).not.toMatch(/composition|generation/)
  })

  it('keeps the Host catalog complete and locale-first for every governed primary state', () => {
    for (const [key, messages] of Object.entries(MANAGER_PRODUCT_COPY)) {
      expect(messages.en, `${key}: en`).toMatch(/\S/u)
      expect(messages['zh-CN'], `${key}: zh-CN`).toMatch(/\S/u)
      expect(managerCopy('en-US', key as keyof typeof MANAGER_PRODUCT_COPY)).toBe(messages.en)
      expect(managerCopy('zh-Hans-CN', key as keyof typeof MANAGER_PRODUCT_COPY)).toBe(messages['zh-CN'])
    }
    expect(managerCopy('en', 'marketplace.failed')).toBe('Failed to load')
    expect(managerCopy('zh-CN', 'status.file-not-found')).toBe('文件不存在')
    expect(managerCopy('en', 'status.restart-required')).toBe('Restart required')
  })

  it('keeps diagnostics and documentation as the home for developer terminology', async () => {
    const [manager, trace, cliProxy, principles] = await Promise.all([
      readFile(managerPath, 'utf8'), readFile(tracePath, 'utf8'), readFile(cliProxyPath, 'utf8'), readFile(principlesPath, 'utf8'),
    ])
    const runtime = section(manager, "if (activeFacet === 'runtime')", "if (activeFacet === 'extension-points')")

    expect(runtime).toContain("diagnostics.append(diagnosticsBody)")
    expect(trace).toContain("'Agent events are currently unavailable.'")
    expect(trace).not.toContain('This plugin will not inspect a raw bridge or private adapter store.')
    expect(cliProxy).toContain("'navigation.description': 'Manage provider models and sessions'")
    expect(cliProxy).toContain("'navigation.description': '管理 Provider 模型和会话'")
    expect(principles).toContain('`fiber`, `generation`, `canonical identity`')
    expect(principles).toContain('`en` and `zh-CN`')
  })
})
