import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { registerNativeComposerSubmission } from '../packages/cli/src/renderer/native-composer-submission-router.js'
import type { NativeSubmissionOrchestratorDescriptor } from '../packages/cli/src/renderer/adapter/native-submission-action-normalizer.js'

const descriptor = (thread?: string): NativeSubmissionOrchestratorDescriptor => ({
  target: 'local',
  thread,
  response: false,
  followUp: thread ? 'local' : undefined,
  followUpThread: thread,
  defaultAction: 'queue',
  explicitAction: undefined,
  edit: null,
  promptOverride: false,
})

it('routes by the native submission thread even when focus belongs to the other composer', async () => {
  const dom = new JSDOM('<main><input></main><aside><input></aside>')
  const main = dom.window.document.querySelector('main')!
  const side = dom.window.document.querySelector('aside')!
  const mainSubmit = vi.fn(async () => ({ allow: true as const, operationToken: 'main-operation-token' }))
  const sideSubmit = vi.fn(async () => ({ allow: true as const, operationToken: 'side-operation-token' }))
  const scope = (composerId: string, threadId?: string) => ({
    targetId: 'target',
    rendererGeneration: 'renderer',
    navigationGeneration: 0,
    composerId,
    ...(threadId ? { threadId } : {}),
  })
  let sideThread: string | undefined = 'side-thread'
  const detachMain = registerNativeComposerSubmission({
    snapshot: () => ({ scope: scope('main', 'main-thread'), idle: false }),
    composer: () => main,
    submit: mainSubmit,
    serviceTier: () => 'priority',
  })
  const detachSide = registerNativeComposerSubmission({
    snapshot: () => ({ scope: scope('side', sideThread), idle: true }),
    composer: () => side,
    submit: sideSubmit,
    serviceTier: () => 'default',
  })
  const page = globalThis as any
  try {
    main.querySelector('input')!.focus()
    expect(page.__cordisxNativeServiceTierOverride).toBeUndefined()
    await expect(page.__cordisxNativeSubmitHook(descriptor('side-thread'))).resolves.toEqual({
      allow: true,
      operationToken: 'side-operation-token',
      serviceTier: 'default',
    })
    expect(mainSubmit).not.toHaveBeenCalled()
    expect(sideSubmit).toHaveBeenCalledTimes(1)
    expect(page.__cordisxNativeSubmissionAuthority.resolve(scope('side', 'stale-thread'))).toEqual({
      scope: scope('side', 'side-thread'),
      idle: true,
    })
    expect(page.__cordisxNativeSubmissionAuthority.resolve(scope('unknown'))).toBeUndefined()
    await expect(page.__cordisxNativeSubmitHook(descriptor('unknown'))).resolves.toEqual({ allow: false })
    sideThread = undefined
    await expect(page.__cordisxNativeSubmitHook(descriptor())).resolves.toMatchObject({
      operationToken: 'side-operation-token',
    })
    detachSide()
    await expect(page.__cordisxNativeSubmitHook(descriptor('side-thread'))).resolves.toEqual({ allow: false })
    expect(page.__cordisxNativeServiceTierOverride).toBe('priority')
  } finally {
    detachSide()
    detachMain()
    dom.window.close()
  }
})

it('keeps two new side drafts isolated and refuses a threadless Send without a unique focus owner', async () => {
  const dom = new JSDOM('<main><input></main><aside><input></aside>')
  const submissions = [vi.fn(async () => ({ allow: true as const })), vi.fn(async () => ({ allow: true as const }))]
  const detach = [...dom.window.document.querySelectorAll<HTMLElement>('main,aside')].map((composer, index) =>
    registerNativeComposerSubmission({
      snapshot: () => ({
        scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 0, composerId: String(index) },
        idle: true,
      }),
      composer: () => composer,
      submit: submissions[index]!,
      serviceTier: () => 'default',
    })
  )
  try {
    const hook = (globalThis as any).__cordisxNativeSubmitHook
    await expect(hook(descriptor())).resolves.toEqual({ allow: false })
    dom.window.document.querySelector('aside input')!.focus()
    await expect(hook(descriptor())).resolves.toEqual({ allow: true, serviceTier: 'default' })
    expect(submissions[0]).not.toHaveBeenCalled()
    expect(submissions[1]).toHaveBeenCalledTimes(1)
  } finally {
    detach.forEach(dispose => dispose())
    dom.window.close()
  }
})

it('captures Fast before asynchronous Send admission for both handoff and native request', async () => {
  const dom = new JSDOM('<main></main>')
  const composer = dom.window.document.querySelector('main')!
  let tier: 'priority' | 'default' = 'priority'
  let finish!: (value: { allow: true; operationToken: string }) => void
  const admitted = vi.fn()
  const detach = registerNativeComposerSubmission({
    snapshot: () => ({
      scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 0, composerId: 'c' },
      idle: true,
    }),
    composer: () => composer,
    submit: () =>
      new Promise(resolve => {
        finish = resolve
      }),
    serviceTier: () => tier,
    creationAdmitted: admitted,
  })
  try {
    const result = (globalThis as any).__cordisxNativeSubmitHook(descriptor())
    tier = 'default'
    finish({ allow: true, operationToken: 'exact-operation-token' })
    await expect(result).resolves.toMatchObject({ serviceTier: 'priority' })
    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ serviceTier: 'priority' }), expect.anything())
  } finally {
    detach()
    dom.window.close()
  }
})

it('leaves an unknown Fast value to native handling instead of inventing a default', async () => {
  const dom = new JSDOM('<main></main>')
  const detach = registerNativeComposerSubmission({
    snapshot: () => ({
      scope: { targetId: 't', rendererGeneration: 'r', navigationGeneration: 0, composerId: 'c' },
      idle: true,
    }),
    composer: () => dom.window.document.querySelector('main'),
    submit: async () => ({ allow: true as const }),
    serviceTier: () => undefined,
  })
  try {
    await expect((globalThis as any).__cordisxNativeSubmitHook(descriptor())).resolves.toEqual({ allow: true })
    expect((globalThis as any).__cordisxNativeServiceTierOverride).toBeUndefined()
  } finally {
    detach()
    dom.window.close()
  }
})
