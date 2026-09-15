import { describe, expect, it } from 'vitest'
import {
  type NativeSubmissionOrchestratorDescriptor,
  normalizeNativeSubmissionAction,
} from '../packages/cli/src/renderer/adapter/native-submission-action-normalizer.js'

const identity = Object.freeze({ operationId: 'native-submit-1', operationGeneration: 11 })
const ordinaryDescriptor = Object.freeze({
  target: 'local',
  thread: undefined,
  response: false,
  followUp: undefined,
  followUpThread: undefined,
  defaultAction: 'steer',
  explicitAction: undefined,
  edit: undefined,
  promptOverride: false,
}) satisfies NativeSubmissionOrchestratorDescriptor

function action(overrides: Partial<NativeSubmissionOrchestratorDescriptor> = {}) {
  return normalizeNativeSubmissionAction(identity, { ...ordinaryDescriptor, ...overrides })
}

describe('native submit orchestrator normalization', () => {
  it('accepts idle new local and observed new worktree ordinary Send shapes', () => {
    expect(action()).toEqual({ ...identity, intent: 'ordinary-send' })
    expect(action({ target: 'worktree', thread: false })).toEqual({ ...identity, intent: 'ordinary-send' })
  })

  it('accepts an existing idle local thread with a matching follow-up target', () => {
    expect(action({
      thread: 'thread-1',
      followUp: 'local',
      followUpThread: 'thread-1',
    })).toEqual({ ...identity, intent: 'ordinary-send', threadId: 'thread-1' })
  })

  it('does not use the idle default queue or steer setting as action intent', () => {
    expect(action({ defaultAction: 'queue' }).intent).toBe('ordinary-send')
    expect(action({ defaultAction: 'steer' }).intent).toBe('ordinary-send')
  })

  it('classifies explicit and active-response queue or steer actions', () => {
    expect(action({ explicitAction: 'queue' }).intent).toBe('queue')
    expect(action({ explicitAction: 'steer' }).intent).toBe('steer')
    expect(action({ response: true, defaultAction: 'queue' }).intent).toBe('queue')
    expect(action({ response: true, defaultAction: 'steer' }).intent).toBe('steer')
  })

  it('classifies queued-message editing before queue policy', () => {
    expect(action({ edit: 0 }).intent).toBe('edit-retry')
    expect(action({ edit: 1, explicitAction: 'queue' }).intent).toBe('edit-retry')
  })

  it('rejects ambiguous targets, mismatched threads, overrides, and unknown state', () => {
    expect(action({ target: 'cloud' }).intent).toBe('unknown-submission')
    expect(action({ target: 'worktree', followUp: 'local', followUpThread: 'thread-1' }).intent)
      .toBe('unknown-submission')
    expect(action({ thread: 'thread-1' }).intent).toBe('unknown-submission')
    expect(action({ thread: 'thread-1', followUp: 'local', followUpThread: 'thread-2' }).intent)
      .toBe('unknown-submission')
    expect(action({ response: undefined }).intent).toBe('unknown-submission')
    expect(action({ promptOverride: true }).intent).toBe('unknown-submission')
    expect(action({ explicitAction: 'send-now' }).intent).toBe('unknown-submission')
    expect(action({ edit: 'unknown' }).intent).toBe('unknown-submission')
  })
})
