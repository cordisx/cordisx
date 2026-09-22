import { describe, expect, it, vi } from 'vitest'
import { discoverNativeSubmissionTransforms } from '../packages/cli/src/launcher/native-submission-structure.js'
import {
  collaborationMode,
  firstTurnRuntime,
  firstTurnToken,
  nativeModelChangeState,
} from './fixtures/native-model-change-baseline.js'
import { resources } from './fixtures/native-submission-structure.js'

const nativeModel = 'gpt-5.6-sol'
const selectedModel = 'deepseek-v4-flash'
const create = (model: unknown = selectedModel) => vi.fn(async () => ({ conversationResponse: { model } }))
const input = (token: unknown = firstTurnToken) => ({
  input: [{ type: 'text', text: 'hello' }],
  collaborationMode: collaborationMode(nativeModel),
  config: { 'cordisx.operation_token': token },
  serviceTier: null,
})

describe('native first-turn model baseline', () => {
  it('prevents the config-backed first-turn synchronization from fabricating a model change', async () => {
    const run = firstTurnRuntime(create())
    const original = input()
    const request = await run.first(original)
    const state = nativeModelChangeState(nativeModel)
    expect(state.beginTurn(request.collaborationMode.settings.model)).toEqual([])
    state.applySettings(selectedModel)
    state.applySettings(selectedModel)
    expect(state.beginTurn()).toEqual([])
    expect(original.collaborationMode.settings.model).toBe(nativeModel)
    expect(request.collaborationMode.settings).toEqual({
      ...original.collaborationMode.settings,
      model: selectedModel,
    })
    expect(request.input).toBe(original.input)
    expect(request.effort).toBe('medium')
  })

  it('keeps a real later switch and switch-back cancellation instead of suppressing all events', async () => {
    const run = firstTurnRuntime(create())
    const request = await run.first(input())
    const state = nativeModelChangeState(nativeModel)
    state.beginTurn(request.collaborationMode.settings.model)
    state.applySettings(selectedModel)
    state.applySettings('another-model')
    expect(state.beginTurn()).toEqual([{
      type: 'modelChanged',
      fromModel: selectedModel,
      toModel: 'another-model',
    }])
    state.applySettings(selectedModel)
    state.applySettings('another-model')
    expect(state.beginTurn()).toEqual([])
  })

  it.each([undefined, 'short', 'invalid\noperation-token'])('preserves native unmarked requests (%j)', async token => {
    const run = firstTurnRuntime(create())
    const original = input(null)
    original.config['cordisx.operation_token'] = token
    const request = await run.first(original)
    expect(request.collaborationMode).toBe(original.collaborationMode)
    expect(request.model).toBeNull()
    expect(request).not.toHaveProperty('config')
  })

  it.each([null, '', 17, 'x'.repeat(513)])('does not guess a missing or invalid accepted model (%j)', async model => {
    const run = firstTurnRuntime(create(model))
    const original = input()
    expect((await run.first(original)).collaborationMode).toBe(original.collaborationMode)
  })

  it('preserves native defaults when no collaboration mode is supplied', async () => {
    const run = firstTurnRuntime(create(nativeModel))
    expect(await run.first({ input: 'hello', serviceTier: null })).toMatchObject({ model: nativeModel })
  })

  it('uses exact model IDs regardless of aliases, provider labels, or plan mode', async () => {
    const exact = 'deployment/selected-id'
    const run = firstTurnRuntime(create(exact))
    const original = input()
    original.collaborationMode.mode = 'plan'
    original.collaborationMode.settings.model = 'Friendly Display Name'
    const request = await run.first(original)
    expect(request.collaborationMode).toEqual({
      ...original.collaborationMode,
      settings: { ...original.collaborationMode.settings, model: exact },
    })
  })

  it('waits for creation and does not mutate a draft on rejection or outcome unknown', async () => {
    for (const reason of ['authorization expired', 'catalog removed', 'outcome unknown']) {
      const original = input()
      const run = firstTurnRuntime(vi.fn(async () => {
        throw new Error(reason)
      }))
      await expect(run.first(original)).rejects.toThrow(reason)
      expect(original.collaborationMode.settings.model).toBe(nativeModel)
    }
  })

  it('keeps concurrent created-thread receipts local instead of using mutable selection globals', async () => {
    const completions: Array<(value: unknown) => void> = []
    const run = firstTurnRuntime(() => new Promise(resolve => completions.push(resolve)))
    const a = run.first(input()), b = run.first(input())
    completions[1]!({ conversationResponse: { model: 'second' } })
    completions[0]!({ conversationResponse: { model: 'first' } })
    expect((await a).collaborationMode.settings.model).toBe('first')
    expect((await b).collaborationMode.settings.model).toBe('second')
  })

  it('keeps existing, hydrated and in-flight paths outside the initialization transform', async () => {
    const run = firstTurnRuntime(create())
    const mode = collaborationMode(selectedModel)
    const request = { threadId: 'existing', input: 'steer', collaborationMode: mode }
    const sendRequest = vi.fn(async (_method, value) => value)
    expect(await run.steer({ sendRequest }, request)).toBe(request)
    expect(sendRequest).toHaveBeenCalledWith('turn/steer', request)
    const state = nativeModelChangeState(selectedModel)
    state.beginTurn()
    state.applySettings(selectedModel)
    expect(state.beginTurn()).toEqual([])
  })

  it('rejects an unbound, duplicate or non-awaited creation receipt', () => {
    for (
      const replacement of [
        'let receipt=await createNativeThread(input);',
        'let {conversationResponse:receipt}=createNativeThread(input);',
        'let {conversationResponse:receipt}=await createNativeThread(input);let {conversationResponse:other}=await createNativeThread(input);',
      ]
    ) {
      const source = resources()
      source[1]!.source = source[1]!.source.replace(
        'let {conversationResponse:receipt}=await createNativeThread(input);',
        replacement,
      )
      expect(() => discoverNativeSubmissionTransforms(source)).toThrow('first-turn-receipt')
    }
    const source = resources()
    source[1]!.source = source[1]!.source.replace('mode==null?receipt.model:null', 'null')
    expect(() => discoverNativeSubmissionTransforms(source)).toThrow('not bound')
  })
})
