import { describe, expect, it, vi } from 'vitest'
import { prepareManagedResume } from '../packages/cli/assets/launcher/native-managed-resume.mjs'

function fixture(thread: Record<string, unknown> = {}) {
  const nativeCall = vi.fn(async () => ({
    thread: { id: 'history', modelProvider: 'provider', model: 'model', status: { type: 'notLoaded' }, ...thread },
  }))
  const controlCall = vi.fn(async () => ({
    kind: 'resume',
    resumeToken: 'valid-current-resume-token',
    configOverrides: { 'model_providers.provider': { base_url: 'http://127.0.0.1:1234/replay' } },
  }))
  return { nativeCall, controlCall }
}
const request = {
  id: 'resume',
  method: 'thread/resume',
  params: {
    threadId: 'history',
    config: { keep: true, 'model_providers.provider': { base_url: 'https://old.example/v1' } },
    approvalPolicy: 'on-request',
  },
}

describe('current managed resume route', () => {
  it('retains unrelated params and replaces only the prepared provider routing table', async () => {
    const f = fixture()
    const original = JSON.stringify(request)
    const result = await prepareManagedResume(request, f)
    expect(result).toMatchObject({
      threadId: 'history',
      resumeToken: 'valid-current-resume-token',
      message: {
        id: 'resume',
        params: {
          approvalPolicy: 'on-request',
          config: { keep: true, 'model_providers.provider': { base_url: 'http://127.0.0.1:1234/replay' } },
        },
      },
    })
    expect(f.controlCall).toHaveBeenCalledWith('managed-resume', {
      threadId: 'history',
      providerId: 'provider',
      model: 'model',
    })
    expect(JSON.stringify(request)).toBe(original)
  })
  it.each([
    { id: 'different' },
    { modelProvider: 'openai' },
    { model: '' },
    { status: { type: 'active' } },
    { status: { type: 'unknown' } },
  ])('does not prepare an unproven/ineligible thread: %s', async thread => {
    const f = fixture(thread)
    expect(await prepareManagedResume(request, f)).toBeUndefined()
    expect(f.controlCall).not.toHaveBeenCalled()
  })
  it.each([
    { modelProvider: 'another' },
    { config: { model_provider: 'another' } },
  ])('does not undo an explicit provider change: %s', async params => {
    const f = fixture()
    expect(await prepareManagedResume({ ...request, params: { ...request.params, ...params } }, f)).toBeUndefined()
    expect(f.controlCall).not.toHaveBeenCalled()
  })
  it('keeps an explicit requested model on the same provider', async () => {
    const f = fixture()
    await prepareManagedResume({ ...request, params: { ...request.params, model: 'new-model' } }, f)
    expect(f.controlCall).toHaveBeenCalledWith('managed-resume', {
      threadId: 'history',
      providerId: 'provider',
      model: 'new-model',
    })
  })
  it.each([{ kind: 'reject' }, { kind: 'resume', resumeToken: 'bad', configOverrides: {} }])(
    'does not apply rejected preparations: %s',
    async prepared => {
      const f = fixture()
      f.controlCall.mockResolvedValue(prepared as any)
      expect(await prepareManagedResume(request, f)).toBeUndefined()
    },
  )
})
