import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadStagedPluginPackage,
  removeStagedPluginPackage,
  stageLocalPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async root => {
    const home = path.join(root, 'home')
    const digests = await readdir(path.join(home, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(async digest => {
      await removeStagedPluginPackage(home, `sha256:${digest}`)
    }))
    await chmod(root, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }))
  temporary.clear()
})

describe('lifecycle smoke local package', () => {
  it('builds through the strict v1 store without bundling Cordis or leaking a local source', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.lifecycle-smoke-test-'))
    temporary.add(root)
    const home = path.join(root, 'home')
    const source = path.resolve('examples/plugins/lifecycle-smoke')
    const staged = await stageLocalPluginPackage(home, source)

    expect(staged.manifest).toMatchObject({
      id: 'lifecycle-smoke',
      version: '1.0.0',
      runtimeManifest: {
        id: 'lifecycle-smoke',
        capabilities: [expect.objectContaining({ name: 'models.read', required: false })],
      },
    })
    expect(staged.identitySource).toBe('https://github.com/cordisx/cordisx/tree/main/examples/plugins/lifecycle-smoke')
    expect(staged.moduleSource).not.toContain(source)
    expect(staged.artifactSource).not.toContain('@deepseek-ai/cordis')
    expect((await loadStagedPluginPackage(home, staged.digest)).readme).toContain('owning-fiber reload')
  })
})
