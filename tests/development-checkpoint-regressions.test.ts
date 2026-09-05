import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')

describe('development checkpoint regressions', () => {
  it('builds workspace runtime dependencies before either source CLI entry point', async () => {
    const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const cliManifest = JSON.parse(await readFile(path.join(root, 'packages/cli/package.json'), 'utf8'))

    expect(rootManifest.scripts.predev).toBe('npm run prepare:dev')
    expect(rootManifest.scripts['prepare:dev']).toBe('npm run prepare:dev --workspace=cordisx')
    expect(rootManifest.scripts['check:clean-dev']).toBe('node scripts/check-clean-dev.mjs')
    expect(rootManifest.scripts.check).toContain('npm run check:clean-dev')
    expect(cliManifest.scripts.predev).toBe('npm run prepare:dev')
    expect(cliManifest.scripts['prepare:dev']).toBe('npm run build')
    expect(cliManifest.scripts.build).toContain('npm run build --workspace=@cordisx/channel-runtime')
    expect(cliManifest.scripts.build).toContain('npm run build --workspace=@cordisx/schemastery-ui')
    expect(cliManifest.scripts.build).toContain('tsc -p tsconfig.json')
  })

  it('opens the on-demand React Manager before collecting live-smoke state', async () => {
    const source = await readFile(path.join(root, 'packages/cli/scripts/live-smoke.mjs'), 'utf8')
    const managerSmoke = source.slice(
      source.indexOf("if (parsed.values['manager-screenshot'] !== undefined)"),
      source.indexOf('let managerThemeReport'),
    )

    expect(source).toContain('async function ensureManagerVisible()')
    expect(source).toContain('async function ensureManagerClosed()')
    expect(source).toContain("trigger instanceof HTMLElement ? 'manager-trigger' : 'legacy-fallback'")
    expect(source).toContain(
      '[data-cordisx-manager-modal] [aria-label="关闭"], [data-cordisx-manager-modal] .cxm-close',
    )
    expect(source).toContain(
      'const left = switcherRect !== undefined && switcherRect.width > 0 && switcherRect.height > 0 ? switcherRect : right',
    )
    expect(managerSmoke).toContain('const managerOpenState = await ensureManagerVisible()')
    expect(managerSmoke).toContain('modal.querySelector(\'[role="dialog"], .cxr-dialog\')')
    expect(managerSmoke).not.toContain('if (modal?.hidden === true && trigger !== null) trigger.click()')
  })
})
