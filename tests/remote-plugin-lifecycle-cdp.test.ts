import { expect, it, vi } from 'vitest'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { installRemotePluginLifecycleBinding } from '../packages/cli/src/launcher/remote-plugin-lifecycle-cdp.js'
import { PLUGIN_LIFECYCLE_BINDING } from '../packages/cli/src/launcher/plugin-lifecycle-rpc.js'
import { request } from './suites/plugin-lifecycle.fixtures.js'

it('checks the native binding token before forwarding to the owner without forwarding that token', async () => {
  let listener: ((params: Record<string, unknown>) => void) | undefined
  const session = {
    onEvent: (_name: string, callback: typeof listener) => {
      listener = callback
      return () => listener = undefined
    },
  } as unknown as CdpSession
  const requests: unknown[] = []
  const responses: Record<string, unknown>[] = []
  const controller = new AbortController()
  const remove = installRemotePluginLifecycleBinding({
    session,
    binding: {
      scope: { token: 'local-secret', profileId: 'work', generation: 'runtime-1' },
      request: async value => {
        requests.push(value)
        return { outcome: 'planned' }
      },
    },
    signal: controller.signal,
    respond: async value => {
      responses.push(value)
    },
    error: () => ({ code: 'rejected', error: 'rejected' }),
  })
  const operation = request({ kind: 'disable', pluginId: 'fixture', impactToken: '' })
  listener!({ name: PLUGIN_LIFECYCLE_BINDING, payload: JSON.stringify({ token: 'wrong', request: operation }) })
  await vi.waitFor(() => expect(responses).toHaveLength(1))
  expect(requests).toEqual([])
  listener!({
    name: PLUGIN_LIFECYCLE_BINDING,
    payload: JSON.stringify({
      token: 'local-secret',
      privateRequest: {
        kind: 'bundle-snapshot-v1',
        requestId: 'startup-probe',
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
      },
    }),
  })
  await vi.waitFor(() => expect(responses).toHaveLength(2))
  expect(responses[1]).toEqual({ requestId: 'startup-probe', ok: false, code: 'rejected', error: 'rejected' })
  listener!({ name: PLUGIN_LIFECYCLE_BINDING, payload: JSON.stringify({ token: 'local-secret', request: operation }) })
  await vi.waitFor(() => expect(responses).toHaveLength(3))
  expect(requests).toEqual([{ request: operation }])
  expect(responses[2]).toEqual({ requestId: operation.requestId, ok: true, value: { outcome: 'planned' } })
  remove()
  expect(listener).toBeUndefined()
})

it('allows a renderer to send its next request synchronously while receiving an owner result', async () => {
  let listener: ((params: Record<string, unknown>) => void) | undefined
  const session = {
    onEvent: (_name: string, callback: typeof listener) => {
      listener = callback
      return () => listener = undefined
    },
  } as unknown as CdpSession
  const first = request({ kind: 'disable', pluginId: 'fixture', impactToken: '' })
  const second = request({ kind: 'enable', pluginId: 'fixture' })
  const requests: unknown[] = []
  const responses: Record<string, unknown>[] = []
  const controller = new AbortController()
  const remove = installRemotePluginLifecycleBinding({
    session,
    binding: {
      scope: { token: 'local-secret', profileId: 'work', generation: 'runtime-1' },
      request: async value => {
        requests.push(value)
        return { outcome: 'planned' }
      },
    },
    signal: controller.signal,
    respond: async value => {
      responses.push(value)
      if (value.requestId === first.requestId) {
        listener!({
          name: PLUGIN_LIFECYCLE_BINDING,
          payload: JSON.stringify({ token: 'local-secret', request: second }),
        })
      }
    },
    error: error => ({ code: 'rejected', error: String(error) }),
  })
  try {
    listener!({ name: PLUGIN_LIFECYCLE_BINDING, payload: JSON.stringify({ token: 'local-secret', request: first }) })
    await vi.waitFor(() => expect(responses).toHaveLength(2))
    expect(requests).toEqual([{ request: first }, { request: second }])
    expect(responses.every(value => value.ok === true)).toBe(true)
  } finally {
    remove()
    controller.abort()
  }
})
