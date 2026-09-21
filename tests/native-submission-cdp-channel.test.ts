import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createNativeSubmissionCdpAuthority } from '../packages/cli/src/launcher/native-submission-cdp-channel.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import type {
  NativeSubmissionController,
  NativeSubmissionScope,
} from '../packages/cli/src/launcher/native-submission-controller.js'

async function harness(options: Readonly<{
  defaultProviderId?: string
  catalog?: () => readonly {
    providerId: string
    pluginId: string
    label: string
    models: readonly { id: string; label: string; aliases?: readonly string[] }[]
  }[]
}> = {}) {
  const world: Record<string, any> = { crypto, setTimeout, clearTimeout }
  let live: NativeSubmissionScope
  let receive: (params: Record<string, any>) => void
  const idle = vi.fn(async () => true)
  const authority = createNativeSubmissionCdpAuthority({
    catalog: async () =>
      options.catalog?.() ?? [{
        providerId: 'provider-b',
        pluginId: 'plugin-b',
        label: 'Provider B',
        models: [{ id: 'model-b', label: 'Model B', aliases: [] }],
      }],
    isThreadIdle: idle,
    ...(options.defaultProviderId === undefined ? {} : { defaultProviderId: options.defaultProviderId }),
  })
  const session = {
    isClosed: () => false,
    onEvent: (_event: string, handler: typeof receive) => {
      receive = handler
      return () => {}
    },
    send: vi.fn(async (method: string, params: Record<string, any>) => {
      if (method === 'Runtime.addBinding') {
        world[params.name] = (payload: string) => receive({ name: params.name, payload })
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'globalThis.__cordisxNativeSubmissionAuthority?.snapshot?.()') {
          return { result: { value: { scope: live } } }
        }
        vm.runInNewContext(params.expression, world)
      }
      return {}
    }),
  }
  const controller = {
    commitSelection: vi.fn<NativeSubmissionController['commitSelection']>(async () => ({
      kind: 'reject',
      reason: 'stale-operation',
    })),
    releaseScope: vi.fn(async () => {}),
  } as unknown as NativeSubmissionController
  authority.bindController(controller)
  const installed = await authority.install(session as unknown as CdpSession, {
    id: 'target',
    url: 'app://-/index.html',
    type: 'page',
    title: '',
  })
  const draft: NativeSubmissionScope = { ...world.__cordisxNativeProviderOwner, navigationGeneration: 3 }
  live = draft
  return {
    authority,
    draft,
    idle,
    installed,
    channel: world.__cordisxNativeProviderCommandChannel,
    controller,
    setLive(value: NativeSubmissionScope) {
      live = value
    },
  }
}

describe('native submission document authority', () => {
  it('projects a valid configured default only for new drafts', async () => {
    const h = await harness({ defaultProviderId: 'provider-b' })
    try {
      await expect(h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.toMatchObject({
        effective: { providerId: 'openai', model: 'gpt-current' },
        draftPreference: { providerId: 'provider-b', generation: 1 },
      })
      const thread = { ...h.draft, threadId: 'thread-1', navigationGeneration: 4 }
      h.setLive(thread)
      await expect(h.channel.selectionRead({
        scope: thread,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.not.toHaveProperty('draftPreference')
    } finally {
      await h.installed.dispose()
    }
  })

  it('remembers only explicit new-draft provider choices, including OpenAI', async () => {
    const h = await harness({ defaultProviderId: 'provider-b' })
    try {
      const first = await h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })
      await h.channel.selectionSelect({
        scope: h.draft,
        providerId: 'provider-b',
        model: 'model-b',
        source: 'preference',
        expectedRevision: first.revision,
      })
      await h.channel.selectionSelect({
        scope: h.draft,
        providerId: 'openai',
        model: 'gpt-current',
      })
      const second = { ...h.draft, navigationGeneration: 4 }
      h.setLive(second)
      await expect(h.channel.selectionRead({
        scope: second,
        effective: { providerId: 'provider-b', model: 'model-b' },
      })).resolves.toMatchObject({ draftPreference: { providerId: 'openai', generation: 2 } })

      const thread = { ...second, threadId: 'thread-1', navigationGeneration: 5 }
      h.setLive(thread)
      await h.channel.selectionRead({ scope: thread, effective: { providerId: 'openai', model: 'gpt-current' } })
      vi.mocked(h.controller.commitSelection).mockResolvedValueOnce({
        kind: 'accepted',
        projection: {
          available: true,
          revision: 3,
          effective: { providerId: 'provider-b', model: 'model-b' },
        },
      })
      await h.channel.selectionSelect({ scope: thread, providerId: 'provider-b', model: 'model-b' })
      const third = { ...h.draft, navigationGeneration: 6 }
      h.setLive(third)
      await expect(h.channel.selectionRead({
        scope: third,
        effective: { providerId: 'provider-b', model: 'model-b' },
      })).resolves.toMatchObject({ draftPreference: { providerId: 'openai', generation: 3 } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('updates the next-draft Provider after each explicit draft choice', async () => {
    const h = await harness({
      catalog: () => [
        {
          providerId: 'provider-a',
          pluginId: 'plugin-a',
          label: 'Provider A',
          models: [{ id: 'model-a', label: 'Model A', aliases: [] }],
        },
        {
          providerId: 'provider-b',
          pluginId: 'plugin-b',
          label: 'Provider B',
          models: [{ id: 'model-b', label: 'Model B', aliases: [] }],
        },
      ],
    })
    try {
      await h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'provider-a', model: 'model-a' },
      })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-a', model: 'model-a' })
      const second = { ...h.draft, navigationGeneration: 4 }
      h.setLive(second)
      await expect(h.channel.selectionRead({
        scope: second,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.toMatchObject({ draftPreference: { providerId: 'provider-a', generation: 1 } })
      await h.channel.selectionSelect({ scope: second, providerId: 'provider-b', model: 'model-b' })
      const third = { ...h.draft, navigationGeneration: 5 }
      h.setLive(third)
      await expect(h.channel.selectionRead({
        scope: third,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.toMatchObject({ draftPreference: { providerId: 'provider-b', generation: 2 } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('falls through unavailable memory and configuration without activating a provider', async () => {
    const h = await harness({ defaultProviderId: 'missing-provider', catalog: () => [] })
    try {
      await expect(h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.not.toHaveProperty('draftPreference')
    } finally {
      await h.installed.dispose()
    }
  })

  it('falls through an unavailable remembered Provider to a valid configured default', async () => {
    let providers = [{
      providerId: 'provider-b',
      pluginId: 'plugin-b',
      label: 'Provider B',
      models: [{ id: 'model-b', label: 'Model B', aliases: [] }],
    }]
    const h = await harness({ defaultProviderId: 'openai', catalog: () => providers })
    try {
      await h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-b' })
      providers = []
      const next = { ...h.draft, navigationGeneration: 4 }
      h.setLive(next)
      await expect(h.channel.selectionRead({
        scope: next,
        effective: { providerId: 'provider-a', model: 'model-a' },
      })).resolves.toMatchObject({ draftPreference: { providerId: 'openai', generation: 2 } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('rejects a stale configured-default projection after a user selection wins', async () => {
    const h = await harness({ defaultProviderId: 'provider-b' })
    try {
      const initial = await h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })
      await h.channel.selectionSelect({
        scope: h.draft,
        providerId: 'openai',
        model: 'gpt-current',
      })
      await expect(h.channel.selectionSelect({
        scope: h.draft,
        providerId: 'provider-b',
        model: 'model-b',
        source: 'preference',
        expectedRevision: initial.revision,
      })).rejects.toThrow()
    } finally {
      await h.installed.dispose()
    }
  })

  it('retires a draft preference when its Provider disappears before application', async () => {
    let providers = [{
      providerId: 'provider-b',
      pluginId: 'plugin-b',
      label: 'Provider B',
      models: [{ id: 'model-b', label: 'Model B', aliases: [] }],
    }]
    const h = await harness({ defaultProviderId: 'provider-b', catalog: () => providers })
    try {
      const initial = await h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })
      providers = []
      await expect(h.channel.selectionSelect({
        scope: h.draft,
        providerId: 'provider-b',
        model: 'model-b',
        source: 'preference',
        expectedRevision: initial.revision,
      })).rejects.toThrow()
      await expect(h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.toMatchObject({ revision: 2, effective: { providerId: 'openai', model: 'gpt-current' } })
      await expect(h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'openai', model: 'gpt-current' },
      })).resolves.not.toHaveProperty('draftPreference')
    } finally {
      await h.installed.dispose()
    }
  })

  it('admits built-in OpenAI without requiring a plugin catalog entry', async () => {
    const h = await harness()
    try {
      await h.channel.selectionRead({ scope: h.draft, effective: { providerId: 'provider-b', model: 'model-b' } })
      await expect(h.channel.selectionSelect({ scope: h.draft, providerId: 'openai', model: 'gpt-6-astra' }))
        .resolves.toMatchObject({ status: 'accepted', pending: { providerId: 'openai', model: 'gpt-6-astra' } })
    } finally {
      await h.installed.dispose()
    }
  })

  it('projects the launcher catalog through the private native command channel', async () => {
    const h = await harness()
    try {
      await expect(h.channel.catalogRead()).resolves.toEqual([{
        providerId: 'provider-b',
        pluginId: 'plugin-b',
        label: 'Provider B',
        models: [{ id: 'model-b', label: 'Model B', aliases: [] }],
      }])
    } finally {
      await h.installed.dispose()
    }
  })

  it('keeps reads observational and commits same-provider model changes only through selection', async () => {
    const h = await harness()
    try {
      const first = { providerId: 'provider', model: 'current' }
      await h.channel.selectionRead({ scope: h.draft, effective: first })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider', model: 'chosen' })
      const read = await h.channel.selectionRead({ scope: h.draft, effective: first })
      expect(read.effective).toEqual({ providerId: 'provider', model: 'chosen' })
      expect(read.revision).toBe(2)
    } finally {
      await h.installed.dispose()
    }
  })

  it('commits an existing-thread provider selection before acknowledging the renderer', async () => {
    const h = await harness()
    const scope = { ...h.draft, threadId: 'thread' }
    h.setLive(scope)
    const commitSelection = vi.mocked(h.controller.commitSelection)
    commitSelection.mockResolvedValueOnce({
      kind: 'accepted' as const,
      projection: {
        available: true as const,
        revision: 3,
        effective: { providerId: 'provider-b', model: 'model-b' },
      },
    })
    await h.channel.selectionRead({ scope, effective: { providerId: 'provider-a', model: 'model-a' } })
    await expect(h.channel.selectionSelect({ scope, providerId: 'provider-b', model: 'model-b' })).resolves.toEqual({
      status: 'accepted',
      available: true,
      revision: 3,
      effective: { providerId: 'provider-b', model: 'model-b' },
    })
    expect(commitSelection).toHaveBeenCalledWith(scope)
    await h.installed.dispose()
  })
  it('resolves only the original draft or the exact returned thread at its next navigation', async () => {
    const h = await harness()
    try {
      await expect(h.authority.runtime.resolveCreatedScope(h.draft, 'new')).resolves.toEqual({
        ...h.draft,
        threadId: 'new',
      })
      const mounted = { ...h.draft, threadId: 'new', navigationGeneration: 4 }
      h.setLive(mounted)
      await expect(h.authority.runtime.resolveCreatedScope(h.draft, 'new')).resolves.toEqual(mounted)
      for (
        const wrong of [{ ...mounted, threadId: 'other' }, { ...mounted, navigationGeneration: 5 }, {
          ...mounted,
          targetId: 'other',
        }]
      ) {
        h.setLive(wrong)
        await expect(h.authority.runtime.resolveCreatedScope(h.draft, 'new')).resolves.toBeUndefined()
      }
    } finally {
      await h.installed.dispose()
    }
  })

  it('moves the authoritative operation projection instead of retaining stale draft state', async () => {
    const h = await harness()
    try {
      await h.channel.selectionRead({
        scope: h.draft,
        effective: { providerId: 'provider-a', model: 'model-a' },
      })
      await h.channel.selectionSelect({ scope: h.draft, providerId: 'provider-b', model: 'model-b' })
      const created = { ...h.draft, threadId: 'new' }
      expect(h.authority.selection.commitEffective({
        scope: created,
        sourceScope: h.draft,
        expectedRevision: 2,
        pendingGeneration: 1,
        selection: { providerId: 'provider-b', model: 'model-b' },
      })).toBe(true)
      expect(() => h.authority.selection.snapshot(h.draft)).toThrow('scope unavailable')
      expect(h.authority.selection.snapshot(created)).toEqual({
        revision: 3,
        effective: { providerId: 'provider-b', model: 'model-b' },
      })

      const mounted = { ...created, navigationGeneration: created.navigationGeneration + 1 }
      h.setLive(mounted)
      await h.channel.selectionRead({
        scope: mounted,
        effective: { providerId: 'provider-b', model: 'model-b' },
      })
      expect(h.authority.selection.adoptScope(created, mounted)).toBe(true)
      expect(() => h.authority.selection.snapshot(created)).toThrow('scope unavailable')
      expect(h.authority.selection.snapshot(mounted).revision).toBe(3)

      const later = { ...mounted, navigationGeneration: mounted.navigationGeneration + 1 }
      h.setLive(later)
      await h.channel.selectionRead({
        scope: later,
        effective: { providerId: 'provider-b', model: 'model-b' },
      })
      await h.channel.selectionSelect({ scope: later, providerId: 'provider-b', model: 'model-b' })
      expect(h.authority.selection.adoptScope(mounted, later)).toBe(false)
      expect(h.authority.selection.snapshot(mounted).revision).toBe(3)
    } finally {
      await h.installed.dispose()
    }
  })

  it('rechecks navigation after awaiting app-server idle state', async () => {
    const h = await harness()
    try {
      const scope = { ...h.draft, threadId: 'thread' }
      h.setLive(scope)
      h.idle.mockImplementationOnce(async () => {
        h.setLive({ ...scope, navigationGeneration: 4 })
        return true
      })
      await expect(h.authority.runtime.revalidate(scope, true)).resolves.toBe(false)
      h.setLive(h.draft)
      await expect(h.authority.runtime.revalidate(scope, true)).resolves.toBe(false)
      await expect(h.authority.runtime.revalidate(scope, true, h.draft)).resolves.toBe(true)
    } finally {
      await h.installed.dispose()
    }
  })
})
