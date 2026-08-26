import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const reactPageEntries = [
  'packages/cli/src/plugins/channel/index.ts',
  'packages/cli/src/plugins/cli-proxy-api/index.ts',
  'packages/agent-trace-showcase/src/index.ts',
  'examples/plugins/slot-showcase/index.ts',
  'examples/plugins/settings-tab-demo/index.ts',
  'examples/plugins/lifecycle-smoke/index.ts',
  'packages/create-cordisx-plugin/template/src/{{packageName}}.tsx',
] as const

describe('React plugin page gate', () => {
  it('keeps every shipped custom page and the developer scaffold on the Host React runtime', async () => {
    for (const relative of reactPageEntries) {
      const source = await readFile(path.join(root, relative), 'utf8')
      expect(source, relative).toContain('defineReactPage')
      expect(source, relative).not.toContain('CordisXPageMountContext')
      expect(source, relative).not.toMatch(/pages\.register[\s\S]{0,300},\s*\(context\)\s*=>/u)
    }
  })

  it('does not retain retired imperative page renderer implementations', async () => {
    const retired = [
      'packages/cli/src/plugins/cli-proxy-api/index.ts',
      'packages/cli/src/renderer/channel-manager.ts',
      'packages/agent-trace-showcase/src/react-view.tsx',
    ] as const
    for (const relative of retired) {
      const source = await readFile(path.join(root, relative), 'utf8')
      expect(source, relative).not.toMatch(/mountFleet|mountTraceShowcase|mountSessionTimeline|\bmount\(context:/u)
    }
  })
})
