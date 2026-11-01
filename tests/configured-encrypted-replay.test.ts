import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { configuredEncryptedReplay } from '../packages/cli/src/launcher/configured-encrypted-replay.js'

describe('configured encrypted replay routing', () => {
  it('overrides only a Responses base URL, preserves native auth and rereads config', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'replay-config-'))
    const route = vi.fn(() => 'http://127.0.0.1:1234/opaque')
    try {
      await writeFile(
        path.join(home, 'config.toml'),
        'model_provider="modelhub"\n[model_providers.modelhub]\nbase_url="https://example.com/v1"\nenv_key="ORIGINAL_KEY"\n[model_providers.chat]\nbase_url="https://other.example/v1"\nwire_api="chat-completions"\n',
      )
      const prepare = configuredEncryptedReplay(home, route)
      expect(await prepare()).toEqual({ 'model_providers.modelhub.base_url': 'http://127.0.0.1:1234/opaque' })
      expect(await prepare('modelhub')).toEqual({ 'model_providers.modelhub.base_url': 'http://127.0.0.1:1234/opaque' })
      expect(await prepare('openai')).toEqual({})
      expect(await prepare('chat')).toEqual({})
      expect(await prepare('missing')).toEqual({})
      await writeFile(path.join(home, 'config.toml'), 'model_provider="openai"\n')
      expect(await prepare()).toEqual({})
      expect(route).toHaveBeenCalledTimes(2)
      expect(route).toHaveBeenCalledWith('https://example.com/v1')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
