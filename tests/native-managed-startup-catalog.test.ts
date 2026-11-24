import { lstat, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  prepareNativeManagedStartupCatalog,
  projectNativeManagedStartupCatalog,
} from '../packages/cli/assets/launcher/native-managed-startup-catalog.mjs'

const row = (slug: string) => ({
  slug,
  display_name: slug,
  supported_in_api: true,
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  priority: 1,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10_000 },
  experimental_supported_tools: [],
  model_messages: { auto_review: { policy: 'keep' } },
  context_window: 128_000,
  max_context_window: 128_000,
  auto_compact_token_limit: 100_000,
})
const baseBytes = () => Buffer.from(JSON.stringify({ models: [row('model-a'), row('model-b'), row('other')] }))
const input = () => ({
  nativeVersion: '0.149.1',
  providerId: 'synthetic',
  pluginId: 'plugin',
  serviceId: 'gateway',
  serviceGeneration: 'service-1',
  catalogGeneration: 'one',
  baseBytes: baseBytes(),
  routes: [
    {
      gatewayModelId: 'model-a',
      aliases: ['a'],
      contextWindow: 64_000,
      reasoningCapabilities: { efforts: ['low', 'high'] },
    },
    { gatewayModelId: 'model-b', aliases: ['b'] },
  ],
})

describe('native managed startup catalog', () => {
  it('projects exact windows and unknowns while retaining native policy and other models', () => {
    const source = input()
    const result = projectNativeManagedStartupCatalog(source)
    expect(result.status).toBe('ready')
    const models = JSON.parse(result.bytes.toString()).models
    expect(models[0]).toMatchObject({
      context_window: 64_000,
      max_context_window: 64_000,
      auto_compact_token_limit: 57_600,
      default_reasoning_level: null,
      supported_reasoning_levels: [{ effort: 'low', description: '' }, { effort: 'high', description: '' }],
      model_messages: { auto_review: { policy: 'keep' } },
    })
    expect(models[1]).toMatchObject({
      context_window: null,
      max_context_window: null,
      auto_compact_token_limit: null,
      default_reasoning_level: null,
      supported_reasoning_levels: [],
    })
    expect(models[2]).toEqual(row('other'))
    expect(JSON.parse(source.baseBytes.toString()).models[0]).toEqual(row('model-a'))
  })

  it('reports unprojectable, invalid, ambiguous and unsupported inputs instead of using fallback', () => {
    const source = input()
    expect(projectNativeManagedStartupCatalog({ ...source, nativeVersion: '0.171.0-alpha.13' }).reason)
      .toBe('unsupported-input')
    expect(
      projectNativeManagedStartupCatalog({ ...source, routes: [{ gatewayModelId: 'absent', aliases: ['absent'] }] })
        .reason,
    )
      .toBe('model-metadata-unavailable')
    for (const contextWindow of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(
        projectNativeManagedStartupCatalog({
          ...source,
          routes: [{ gatewayModelId: 'model-a', aliases: ['a'], contextWindow }],
        }).reason,
      ).toBe('invalid-route')
    }
    expect(
      projectNativeManagedStartupCatalog({
        ...source,
        routes: [{ gatewayModelId: 'model-a', aliases: ['a'] }, { gatewayModelId: 'model-a', aliases: ['a2'] }],
      }).reason,
    ).toBe('invalid-route')
    expect(
      projectNativeManagedStartupCatalog({
        ...source,
        baseBytes: Buffer.from(JSON.stringify({ models: [row('model-a'), row('model-a')] })),
      }).reason,
    ).toBe('invalid-catalog')
  })

  it('changes revision on ownership, generation, window or native metadata changes', () => {
    const source = input()
    const baseline = projectNativeManagedStartupCatalog(source).revision
    expect(projectNativeManagedStartupCatalog({ ...source, providerId: 'other' }).revision).not.toBe(baseline)
    expect(projectNativeManagedStartupCatalog({ ...source, pluginId: 'other' }).revision).not.toBe(baseline)
    expect(projectNativeManagedStartupCatalog({ ...source, serviceId: 'other' }).revision).not.toBe(baseline)
    expect(projectNativeManagedStartupCatalog({ ...source, serviceGeneration: 'two' }).revision).not.toBe(baseline)
    expect(projectNativeManagedStartupCatalog({ ...source, catalogGeneration: 'two' }).revision).not.toBe(baseline)
    expect(
      projectNativeManagedStartupCatalog({
        ...source,
        routes: [{ gatewayModelId: 'model-a', aliases: ['a'], contextWindow: 32_000 }],
      }).revision,
    ).not.toBe(baseline)
    const native = JSON.parse(source.baseBytes.toString())
    native.models[0].model_messages.auto_review.policy = 'changed'
    expect(projectNativeManagedStartupCatalog({ ...source, baseBytes: Buffer.from(JSON.stringify(native)) }).revision)
      .not.toBe(baseline)
  })

  it('fails closed when native token-budget policy cannot be safely projected', () => {
    const source = input(), native = JSON.parse(source.baseBytes.toString())
    native.models[0].model_messages.token_budget = { reminder_threshold_tokens: 100_000 }
    expect(projectNativeManagedStartupCatalog({ ...source, baseBytes: Buffer.from(JSON.stringify(native)) }).reason)
      .toBe('model-budget-unavailable')
  })

  it('keeps its immutable private snapshot until explicitly closed', async () => {
    const result = await prepareNativeManagedStartupCatalog(input())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    const metadata = await lstat(result.path)
    if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o400)
    expect(JSON.parse(await readFile(result.path, 'utf8')).models[0].context_window).toBe(64_000)
    await Promise.all([result.close(), result.close()])
    await expect(lstat(result.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
