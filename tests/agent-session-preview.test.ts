import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'

describe('Agent/Session development composition', () => {
  it('does not create a Provider Fleet or a local CLI connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-session-development-preview-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({
      version: 1,
      codex: { executable: '/must-not-start/codex' },
      providers: [],
      plugins: [],
    }))
    const createFleet = vi.spyOn(ProviderFleet, 'create')
    const session = await createPlaygroundSession(configPath)
    try {
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('hostKind: "playground"')
      expect(composition.source).not.toContain('providerBridgeToken')
      expect(createFleet).not.toHaveBeenCalled()
    } finally {
      await session.close()
      createFleet.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
