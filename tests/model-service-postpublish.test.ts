import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ file: '', afterRename: false, enabled: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    rename: async (from: Parameters<typeof original.rename>[0], to: Parameters<typeof original.rename>[1]) => {
      await original.rename(from, to)
      if (fault.enabled && to === fault.file) fault.afterRename = true
    },
    chmod: async (file: Parameters<typeof original.chmod>[0], mode: Parameters<typeof original.chmod>[1]) => {
      if (fault.enabled && fault.afterRename && file === fault.file) throw new Error('invalid post-rename chmod')
      return await original.chmod(file, mode)
    },
  }
})

import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { readModelServices, saveModelServices } from '../packages/cli/src/launcher/model-service-store.js'

it('reports an indeterminate persistence failure when chmod fails after model configuration was published', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-model-postpublish-'))
  const configPath = path.join(directory, 'config.json')
  try {
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const before = await readModelServices(configPath, {})
    if (before.status !== 'ok') throw new Error('fixture read failed')
    fault.file = configPath
    fault.enabled = true
    const result = await saveModelServices(configPath, {
      expectedRevision: before.revision,
      services: [{
        id: 'sample',
        displayName: 'Sample',
        baseUrl: 'https://example.test',
        protocols: ['openai-responses'],
        codexModels: ['model'],
        claudeModels: [],
        enabled: true,
        apiKey: 'fixture-secret',
      }],
    })
    fault.enabled = false
    expect(result).toEqual({ status: 'rejected', code: 'persist-failed' })
    const written = JSON.parse(await readFile(configPath, 'utf8'))
    expect(written.providers).toEqual([expect.objectContaining({ id: 'sample' })])
    expect(written.environmentVariables).toEqual([expect.objectContaining({ value: 'fixture-secret' })])
  } finally {
    fault.enabled = false
    await rm(directory, { recursive: true, force: true })
  }
})
