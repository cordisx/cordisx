import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const pluginRoots = [
  'examples/plugins/slot-showcase',
  'examples/plugins/hello-toolbar',
  'examples/plugins/form-schema-gallery',
  'examples/plugins/settings-tab-demo',
  'examples/plugins/console-showcase',
  'examples/plugins/cli-proxy-api',
  'examples/plugins/lifecycle-smoke',
  'examples/plugins/permission-v2-smoke',
  'examples/plugins/permission-v2-smoke-expanded',
  'packages/cli/src/plugins/channel',
  'packages/cli/src/plugins/cli-proxy-api',
  'packages/agent-trace-showcase',
] as const

describe('first-party plugin README localization files', () => {
  for (const root of pluginRoots) {
    it(`${root} ships an English fallback and Simplified Chinese README`, async () => {
      const [fallback, simplifiedChinese] = await Promise.all([
        readFile(path.join(projectRoot, root, 'README.md'), 'utf8'),
        readFile(path.join(projectRoot, root, 'README.zh-Hans.md'), 'utf8'),
      ])

      expect(fallback).toMatch(/^#\s+\S/m)
      expect(simplifiedChinese).toMatch(/^#\s+\S/m)
      expect(fallback.trim().length).toBeGreaterThan(120)
      expect(simplifiedChinese.trim().length).toBeGreaterThan(120)
    })
  }
})
