import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { configuredEncryptedReplay } from '../packages/cli/src/launcher/configured-encrypted-replay.js'
import { accountRouting } from '../packages/cli/assets/launcher/native-responses-recovery.mjs'

describe('configured encrypted replay routing', () => {
  it('overrides only a Responses base URL, preserves native auth and rereads config', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'replay-config-'))
    const route = vi.fn(() => 'http://127.0.0.1:1234/opaque')
    try {
      await writeFile(
        path.join(home, 'config.toml'),
        'model_provider="modelhub"\n[model_providers.modelhub]\nbase_url="https://example.com/v1"\nenv_key="ORIGINAL_KEY"\n[model_providers.chat]\nbase_url="https://other.example/v1"\nwire_api="chat-completions"\n',
      )
      const prepare = configuredEncryptedReplay(home, route, [], async () => true)
      const expected = {
        'model_providers.modelhub': {
          base_url: 'http://127.0.0.1:1234/opaque',
          env_key: 'ORIGINAL_KEY',
          wire_api: 'responses',
        },
      }
      expect(await prepare()).toEqual(expected)
      expect(await prepare('modelhub')).toEqual(expected)
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

  it('routes an explicitly configured native OpenAI endpoint without guessing an implicit one', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'replay-native-openai-'))
    const route = vi.fn(() => 'http://127.0.0.1:1234/opaque')
    try {
      await writeFile(path.join(home, 'config.toml'), 'model_provider="openai"\n')
      const prepare = configuredEncryptedReplay(home, route, [], async () => true)
      expect(await prepare('openai')).toEqual({})
      await writeFile(
        path.join(home, 'config.toml'),
        'model_provider="openai"\nopenai_base_url="https://example.test/backend-api/codex"\n',
      )
      expect(await prepare('openai', { type: 'apiKey' })).toEqual({ openai_base_url: 'http://127.0.0.1:1234/opaque' })
      await writeFile(path.join(home, 'config.toml'), 'openai_base_url="https://example.test/backend-api/codex"\n')
      expect(await prepare(undefined, { type: 'apiKey' })).toEqual({ openai_base_url: 'http://127.0.0.1:1234/opaque' })
      expect(await configuredEncryptedReplay(home, route)(undefined, { type: 'apiKey' })).toEqual({})
      expect(route).toHaveBeenCalledWith(
        'https://example.test/backend-api/codex',
        expect.objectContaining({
          nativeOpenAi: true,
          nativeStreamIdlePolicy: true,
          accountSnapshot: JSON.stringify({ type: 'apiKey' }),
          verifyAccount: expect.any(Function),
        }),
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('uses verified ChatGPT workspace routing and never guesses an unavailable account', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'replay-chatgpt-route-'))
    const route = vi.fn(() => 'http://127.0.0.1:1234/opaque')
    try {
      await writeFile(path.join(home, 'config.toml'), 'model_provider="openai"\n')
      const verify = vi.fn(async () => true)
      const prepare = configuredEncryptedReplay(home, route, [], verify)
      expect(await prepare('openai', { type: 'chatgpt' })).toEqual({})
      const account = accountRouting({
        account: { type: 'chatgpt', email: 'never-transfer@example.test' },
        userId: 'synthetic-user',
        workspaceRouting: {
          chatgptAccountId: 'account-one',
          backendOrigin: 'https://regional.chatgpt.com',
          accountRoutingOverride: 'us',
        },
      }) as {
        type: string
        workspaceRouting: {
          workspaceDigest: string
          ownerDigest: string
          backendOrigin: string
          accountRoutingOverride: string
        }
      }
      expect(await prepare('openai', account)).toEqual({ openai_base_url: 'http://127.0.0.1:1234/opaque' })
      expect(route).toHaveBeenCalledWith(
        'https://regional.chatgpt.com/backend-api/codex',
        expect.objectContaining({
          nativeOpenAi: true,
          nativeStreamIdlePolicy: true,
          expectedAccountDigest: account.workspaceRouting.workspaceDigest,
          accountSnapshot: JSON.stringify(account),
          verifyAccount: verify,
          accountRoutingOverride: 'us',
        }),
      )
      expect(
        await prepare('openai', {
          ...account,
          workspaceRouting: {
            ...account.workspaceRouting,
            backendOrigin: 'http://bad.example',
          },
        }),
      ).toEqual({})
      expect(
        await prepare('openai', {
          ...account,
          workspaceRouting: {
            ...account.workspaceRouting,
            accountRoutingOverride: 'unknown',
          },
        }),
      ).toEqual({})
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
