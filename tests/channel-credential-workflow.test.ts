import { describe, expect, it, vi } from 'vitest'
import { ChannelCredentialWorkflow } from '../packages/cli/src/renderer/channel-credential-workflow.js'

const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
describe('Host credential entry authorization timing', () => {
  it('captures the service revision when a connection creation starts', async () => {
    let serviceRevision = 7
    const request = vi.fn(async (input: Record<string, unknown>) =>
      input.operation === 'capture'
        ? {
          status: 'applied' as const,
          code: 'CAPTURED',
          draftId: 'private-draft',
          ref: account,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        : { status: 'applied' as const, code: 'DISCARDED' }
    )
    const flow = new ChannelCredentialWorkflow({
      revision: () => 1,
      serviceRevision: () => serviceRevision,
      advance: () => {},
      target: () => undefined,
      connectionToken: () => 'unused',
      available: () => true,
      prompt: async input => await input.submit(account, 'fixture-secret', input.signal),
      request,
      adopt: () => {},
    })
    try {
      const issued = await flow.issue({
        operation: 'target.credential.capture.create',
        adapterKind: 'feishu',
        purpose: 'create',
        target: { kind: 'root' },
        expectedRevision: 1,
      } as never, 'owner')
      serviceRevision = 8
      await expect(flow.execute(
        { operation: 'credential.capture', target: issued.target } as never,
        'owner',
        () => true,
        async () => true,
      )).resolves.toMatchObject({ status: 'applied' })
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ operation: 'capture', expectedRevision: 7 }))
    } finally {
      flow.dispose()
    }
  })
  it('reuses the opaque connection target when a pending account is resolved', async () => {
    const pending = { ...account, tenantId: '' }, order: string[] = []
    const request = vi.fn(async () => ({ status: 'applied' as const, code: 'APPLIED', ref: account, projection: {} }))
    const flow = new ChannelCredentialWorkflow({
      revision: () => 1,
      advance: () => {
        order.push('advance')
      },
      target: () => pending,
      connectionToken: () => 'same-token',
      available: () => true,
      rekeyConnection: (before, after) => {
        expect(before).toEqual(pending)
        expect(after).toEqual(account)
        order.push('rekey')
      },
      prompt: async () => false,
      request,
      adopt: () => {
        order.push('adopt')
      },
    })
    try {
      await expect(
        flow.resolveTenant({
          owner: 'owner',
          account: pending,
          tenantId: '',
          expectedServiceRevision: 4,
          signal: new AbortController().signal,
          live: () => true,
          authorize: async () => true,
        }),
      ).resolves.toMatchObject({ status: 'applied' })
      expect(order).toEqual(['rekey', 'adopt', 'advance'])
      expect(request).toHaveBeenCalledWith({
        operation: 'resolve-tenant',
        owner: 'owner',
        account: pending,
        tenantId: '',
        expectedRevision: 4,
      })
    } finally {
      flow.dispose()
    }
  })
  it('can open/cancel an entry with no account yet, without a secret or transport effect', async () => {
    const request = vi.fn(), authorize = vi.fn(), prompt = vi.fn(async () => false)
    const flow = new ChannelCredentialWorkflow({
      revision: () => 1,
      advance: () => {},
      target: () => undefined,
      connectionToken: () => 'unused',
      available: () => true,
      prompt,
      request,
      adopt: () => {},
    })
    try {
      const issued = await flow.issue(
        {
          operation: 'target.credential.capture.create',
          adapterKind: 'feishu',
          purpose: 'create',
          target: { kind: 'root' },
          expectedRevision: 1,
        } as never,
        'owner',
      )
      expect(issued.status).toBe('applied')
      const captured = await flow.execute(
        { operation: 'credential.capture', target: issued.target } as never,
        'owner',
        () => true,
        authorize,
      )
      expect(captured).toMatchObject({ code: 'CAPTURE_CANCELLED' })
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(authorize).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    } finally {
      flow.dispose()
    }
  })
  it('denies the actual private account before any credential persistence', async () => {
    const request = vi.fn(), authorize = vi.fn(async () => false)
    const flow = new ChannelCredentialWorkflow({
      revision: () => 1,
      advance: () => {},
      target: () => undefined,
      connectionToken: () => 'unused',
      available: () => true,
      request,
      adopt: () => {},
      prompt: async input => await input.submit(account, 'fixture-secret', input.signal),
    })
    try {
      const issued = await flow.issue(
        {
          operation: 'target.credential.capture.create',
          adapterKind: 'feishu',
          purpose: 'create',
          target: { kind: 'root' },
          expectedRevision: 1,
        } as never,
        'owner',
      )
      expect(
        await flow.execute(
          { operation: 'credential.capture', target: issued.target } as never,
          'owner',
          () => true,
          authorize,
        ),
      ).toMatchObject({ status: 'rejected' })
      expect(authorize).toHaveBeenCalledWith(account)
      expect(request).not.toHaveBeenCalled()
    } finally {
      flow.dispose()
    }
  })
  it('reports the safe tenant failure to the Host form and allows a corrected retry on the same capture', async () => {
    const reportFailure = vi.fn(), submitResults: boolean[] = []
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 'rejected', code: 'TENANT_DISCOVERY_PERMISSION_DENIED' })
      .mockResolvedValueOnce({
        status: 'applied',
        code: 'CAPTURED',
        draftId: 'fixture-private-draft',
        ref: account,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      })
      .mockResolvedValue({ status: 'applied', code: 'DISCARDED' })
    let revision = 1
    const flow = new ChannelCredentialWorkflow({
      revision: () => revision,
      advance: () => {
        revision += 1
      },
      target: () => undefined,
      connectionToken: () => 'unused',
      available: () => true,
      request,
      adopt: () => {},
      prompt: async input => {
        submitResults.push(
          await input.submit({ ...account, tenantId: '' }, 'fixture-secret', input.signal, reportFailure),
        )
        submitResults.push(await input.submit(account, 'fixture-secret', input.signal, reportFailure))
        return submitResults[1]!
      },
    })
    try {
      const issued = await flow.issue({
        operation: 'target.credential.capture.create',
        adapterKind: 'feishu',
        purpose: 'create',
        target: { kind: 'root' },
        expectedRevision: 1,
      } as never, 'owner')
      await expect(
        flow.execute(
          { operation: 'credential.capture', target: issued.target } as never,
          'owner',
          () => true,
          async () => true,
        ),
      ).resolves.toMatchObject({ status: 'applied' })
      expect(submitResults).toEqual([false, true])
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith('TENANT_DISCOVERY_PERMISSION_DENIED')
    } finally {
      flow.dispose()
    }
  })
  it('waits for private draft cleanup and stops subsequent operations when cleanup fails', async () => {
    for (const succeeds of [true, false]) {
      let finishDiscard!: (value: { status: 'applied' | 'unavailable'; code: string }) => void
      const discarded = new Promise<{ status: 'applied' | 'unavailable'; code: string }>(resolve => {
        finishDiscard = resolve
      })
      let revision = 1
      const flow = new ChannelCredentialWorkflow({
        revision: () => revision,
        advance: () => {
          revision += 1
        },
        target: () => account,
        connectionToken: () => 'connection',
        available: () => true,
        prompt: async input => await input.submit(account, 'synthetic-fixture-value', input.signal),
        request: async input =>
          input.operation === 'capture'
            ? {
              status: 'applied',
              code: 'CAPTURED',
              draftId: 'private-draft',
              ref: account,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }
            : await discarded,
        adopt: () => {},
      })
      try {
        const request = () =>
          ({
            operation: 'target.credential.capture.rotate',
            target: { kind: 'connection', connectionToken: 'connection' },
            expectedRevision: revision,
          }) as never
        const first = await flow.issue(request(), 'owner')
        expect(
          await flow.execute(
            { operation: 'credential.capture', target: first.target } as never,
            'owner',
            () => true,
            async () => true,
          ),
        ).toMatchObject({ status: 'applied' })
        flow.retireOwner('owner')
        let settled = false
        const next = flow.issue(request(), 'owner').then(value => {
          settled = true
          return value
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        finishDiscard(
          succeeds
            ? { status: 'applied', code: 'DISCARDED' }
            : { status: 'unavailable', code: 'CREDENTIAL_CLEANUP_UNAVAILABLE' },
        )
        expect(await next).toMatchObject(
          succeeds
            ? { status: 'applied' }
            : { status: 'unavailable', code: 'CREDENTIAL_CLEANUP_UNAVAILABLE' },
        )
      } finally {
        finishDiscard({ status: 'applied', code: 'DISCARDED' })
        flow.dispose()
      }
    }
  })
})
