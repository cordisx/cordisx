import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createManagerRendererModelServicesChannel } from '../packages/cli/src/cli/manager-renderer-model-services.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createHeadlessCodexOperations } from '../packages/cli/src/launcher/headless-codex-operations.js'
import {
  MODEL_SERVICE_SAFE_WRITE_CONTRACT,
  STANDALONE_MODEL_SERVICES_MARKER,
} from '../packages/cli/src/model-service-contracts.js'

const context = (signal: AbortSignal, admitted = true) => ({
  profileId: 'default',
  rendererId: 'a'.repeat(64),
  ownerGeneration: 'owner-1',
  signal,
  admitted,
})
const envelope = (requestId: string, operation: 'read' | 'save', request?: unknown) =>
  JSON.stringify({
    version: 1,
    token: STANDALONE_MODEL_SERVICES_MARKER,
    requestId,
    operation,
    ...(request === undefined ? {} : { request }),
  })

it('reads and saves the owner store with revision checks and write-only credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cx-manager-model-services-'))
  const configPath = path.join(root, 'config.json')
  const controller = new AbortController()
  try {
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const call = createHeadlessCodexOperations({ configPath, environment: {}, closed: () => false })
    const channel = createManagerRendererModelServicesChannel({
      profileId: 'default',
      generation: 'owner-1',
      isCurrent: () => true,
      call,
    })
    const first = await channel.prepare(envelope('read-1', 'read'), context(controller.signal, false)).dispatch() as any
    expect(first).toMatchObject({ ok: true, value: { status: 'ok', services: [] } })
    const request = {
      expectedRevision: first.value.revision,
      services: [{
        id: 'fixture',
        displayName: 'Fixture',
        baseUrl: 'https://example.test',
        protocols: ['openai-responses'],
        codexModels: ['fixture-model'],
        claudeModels: [],
        enabled: true,
        apiKey: 'fixture-private-value',
      }],
    }
    expect(() => channel.prepare(envelope('unadmitted', 'save', request), context(controller.signal, false)))
      .toThrow('MODEL_SERVICES_INVALID')
    const save = channel.prepare(envelope('save-1', 'save', request), context(controller.signal))
    expect(save.mode).toBe('write')
    expect(await save.dispatch()).toMatchObject({ ok: true, value: { status: 'applied', applies: 'app-restart' } })
    const readback = await channel.prepare(envelope('read-2', 'read'), context(controller.signal)).dispatch()
    expect(readback).toMatchObject({
      ok: true,
      value: { status: 'ok', services: [expect.objectContaining({ id: 'fixture', keyConfigured: true })] },
    })
    expect(JSON.stringify(readback)).not.toContain('fixture-private-value')
    expect(await channel.prepare(envelope('save-stale', 'save', request), context(controller.signal)).dispatch())
      .toMatchObject({ ok: true, value: { status: 'rejected', code: 'conflict' } })
    await expect(channel.prepare(envelope('save-1', 'save', request), context(controller.signal)).dispatch())
      .rejects.toThrow('MODEL_SERVICES_UNAVAILABLE')
    controller.abort()
    expect(() => channel.prepare(envelope('read-3', 'read'), context(controller.signal)))
      .toThrow('MODEL_SERVICES_UNAVAILABLE')
  } finally {
    controller.abort()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not write without the safe contract and reports post-publication failure as unknown', async () => {
  const controller = new AbortController()
  const request = { expectedRevision: 'revision', services: [] }
  const call = vi.fn(async (operation: string) =>
    operation === 'model-services:read'
      ? { status: 'ok', revision: 'revision', services: [], managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT }
      : { status: 'rejected', code: 'persist-failed' }
  )
  const channel = createManagerRendererModelServicesChannel({
    profileId: 'default',
    generation: 'owner-1',
    isCurrent: () => true,
    call,
  })
  await expect(channel.prepare(envelope('save', 'save', request), context(controller.signal)).dispatch())
    .rejects.toThrow('MODEL_SERVICES_RESULT_UNKNOWN')
  call.mockResolvedValueOnce({ status: 'ok', revision: 'revision', services: [] } as never)
  expect(await channel.prepare(envelope('no-capability', 'save', request), context(controller.signal)).dispatch())
    .toEqual({ requestId: 'no-capability', ok: true, value: { status: 'rejected', code: 'unavailable' } })
  expect(call).toHaveBeenCalledTimes(3)
  controller.abort()
})
