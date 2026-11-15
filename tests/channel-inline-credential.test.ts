import { describe, expect, it, vi } from 'vitest'
import { ChannelCredentialWorkflow } from '../packages/cli/src/renderer/channel-credential-workflow.js'
import { PublicChannelManagerController } from '../packages/cli/src/renderer/channel-manager-public.js'
import { applyInlineChannelCredential } from '../packages/cli/src/renderer/channel-inline-credential.js'

function fixture() {
  const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
  const request = vi.fn(async (input: Record<string, unknown>) =>
    input.operation === 'capture'
      ? {
        status: 'applied',
        code: 'CAPTURED',
        ref: account,
        draftId: 'private-fixture',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }
      : { status: 'applied', code: 'APPLIED' }
  )
  const prompt = vi.fn(async () => {
    throw new Error('Inline flow must not open the modal')
  })
  let controller!: PublicChannelManagerController
  const credentials = new ChannelCredentialWorkflow({
    revision: () => controller.currentRevision(),
    advance: () => controller.invalidate(),
    target: token => controller.target(token),
    connectionToken: ref => controller.tokenFor(ref),
    available: () => true,
    prompt,
    request: request as never,
    adopt: () => {},
  })
  controller = new PublicChannelManagerController({
    profileId: 'test',
    hostGeneration: 'one',
    projection: () => ({
      contract: 'cordisx.channel-manager-projection/v1',
      schemaVersion: 1,
      status: 'implemented',
      service: {
        configurationKind: 'host',
        configApplies: 'service-restart',
        revision: 1,
        lastGoodRevision: 1,
        writable: true,
      },
      connections: [{
        ref: account,
        adapterKind: 'feishu',
        enabled: true,
        transportMode: 'websocket',
        secretState: 'ready',
      }],
      accounts: [],
      routes: [],
      bindings: [],
      diagnostics: [],
    }),
    actionsAvailable: () => true,
    runAction: async () => ({ status: 'applied' }),
    credentials,
  })
  return { account, request, prompt, credentials, controller }
}

describe('Host inline credential lineage', () => {
  it('commits the settings patch and key in the same private transaction without changing v2 documents', async () => {
    const f = fixture(), authorize = vi.fn(async () => true)
    try {
      const snapshot = f.controller.snapshot()
      const patch = { displayName: 'Updated', selectors: ['direct', 'mentions'] }
      const result = await applyInlineChannelCredential({
        ...f,
        owner: 'combined-form',
        connectionToken: snapshot.accounts[0]!.connectionToken,
        expectedRevision: snapshot.revision,
        configuration: { expectedServiceRevision: 11, patch },
        secret: 'fixture-secret',
        signal: new AbortController().signal,
        live: () => true,
        authorize,
      })
      expect(result).toEqual({ status: 'applied', code: 'APPLIED' })
      expect(f.request).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ operation: 'capture', expectedRevision: 11 }),
      )
      expect(f.request).toHaveBeenNthCalledWith(2, {
        operation: 'commit',
        owner: 'combined-form',
        draftId: 'private-fixture',
        draft: patch,
      })
      expect(authorize).toHaveBeenCalledTimes(2)
    } finally {
      f.credentials.dispose()
    }
  })

  it('rejects stale form revisions before capture and discards only a rejected commit capture', async () => {
    const f = fixture(), signal = new AbortController().signal
    const input = {
      ...f,
      owner: 'combined-form',
      connectionToken: f.controller.snapshot().accounts[0]!.connectionToken,
      configuration: { expectedServiceRevision: 11, patch: { displayName: 'Updated', selectors: ['direct'] } },
      secret: 'fixture-secret',
      signal,
      live: () => true,
      authorize: async () => true,
    }
    try {
      await expect(applyInlineChannelCredential({ ...input, expectedRevision: -1 })).resolves.toEqual({
        status: 'conflict',
        code: 'REVISION_CONFLICT',
      })
      expect(f.request).not.toHaveBeenCalled()
      f.request.mockImplementation(async request =>
        request.operation === 'capture'
          ? {
            status: 'applied',
            code: 'CAPTURED',
            ref: f.account,
            draftId: 'private-fixture',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }
          : { status: request.operation === 'commit' ? 'conflict' : 'applied', code: 'REVISION_CONFLICT' }
      )
      await expect(applyInlineChannelCredential({ ...input, expectedRevision: f.controller.currentRevision() }))
        .resolves.toEqual({ status: 'conflict', code: 'REVISION_CONFLICT' })
      expect(f.request).toHaveBeenLastCalledWith({
        operation: 'discard',
        owner: 'combined-form',
        draftId: 'private-fixture',
      })
    } finally {
      f.credentials.dispose()
    }
  })
  it('captures and commits only the selected connection with redacted output', async () => {
    const f = fixture(), authorize = vi.fn(async () => true)
    try {
      const connectionToken = f.controller.snapshot().accounts[0]!.connectionToken
      const result = await applyInlineChannelCredential({
        ...f,
        owner: 'form-one',
        connectionToken,
        signal: new AbortController().signal,
        live: () => true,
        authorize,
        secret: 'fixture-secret',
      })
      expect(result).toEqual({ status: 'applied', code: 'APPLIED' })
      expect(f.prompt).not.toHaveBeenCalled()
      expect(f.request).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          operation: 'capture',
          owner: 'form-one',
          purpose: 'rotate',
          account: f.account,
          secret: 'fixture-secret',
        }),
      )
      expect(f.request).toHaveBeenNthCalledWith(2, {
        operation: 'commit',
        owner: 'form-one',
        draftId: 'private-fixture',
      })
      expect(authorize).toHaveBeenCalledTimes(2)
      expect(f.controller.snapshot().accounts[0]!.connectionToken).toBe(connectionToken)
      expect(JSON.stringify(result)).not.toContain('fixture-secret')
      expect(JSON.stringify(result)).not.toContain('private-fixture')
    } finally {
      f.credentials.dispose()
    }
  })
  it('discards a captured private draft when the page closes before capture returns', async () => {
    const f = fixture(), lifetime = new AbortController()
    f.request.mockImplementation(async input => {
      if (input.operation === 'capture') {
        lifetime.abort()
        return {
          status: 'applied',
          code: 'CAPTURED',
          ref: f.account,
          draftId: 'private-fixture',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }
      }
      return { status: 'applied', code: 'DISCARDED' }
    })
    try {
      const result = await applyInlineChannelCredential({
        ...f,
        owner: 'form-one',
        connectionToken: f.controller.snapshot().accounts[0]!.connectionToken,
        signal: lifetime.signal,
        live: () => !lifetime.signal.aborted,
        authorize: async () => true,
        secret: 'fixture-secret',
      })
      expect(result.status).not.toBe('applied')
      expect(f.request).toHaveBeenCalledWith({ operation: 'discard', owner: 'form-one', draftId: 'private-fixture' })
      expect(f.request.mock.calls.some(([input]) => input.operation === 'commit')).toBe(false)
    } finally {
      f.credentials.dispose()
    }
  })
})
