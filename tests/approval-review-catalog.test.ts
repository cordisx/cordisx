import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseApprovalReviewSettings } from '../packages/cli/src/config/approval-review-config.js'
import { createDefaultHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  approvalReviewCatalog,
  prepareApprovalReviewCatalog,
} from '../packages/cli/src/launcher/approval-review-catalog.js'
import { createApprovalReviewConfiguration } from '../packages/cli/src/launcher/approval-review-configuration.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { localCodexAppServerArguments } from '../packages/cli/src/providers/codex-app-server.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const settings = { providerId: 'gateway', catalogPath: 'models.json', models: { 'work-model': 'review-model' } }
const metadata = {
  display_name: 'Test model',
  supported_in_api: true,
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  priority: 1,
  support_verbosity: false,
  truncation_policy: { mode: 'bytes', limit: 10000 },
  experimental_supported_tools: [],
  model_messages: { auto_review: { policy_template: 'Original template', policy: 'Original policy' } },
}
const source = {
  models: [
    { ...metadata, slug: 'work-model' },
    { ...metadata, slug: 'review-model' },
    { ...metadata, slug: 'native-model', auto_review_model_override: 'native-review' },
  ],
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-review-test-'))
  roots.push(root)
  const configPath = path.join(root, 'config.json')
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  await writeFile(path.join(root, 'models.json'), JSON.stringify(source))
  return { root, configPath }
}
it('changes only reviewer metadata and preserves complete unrelated models and policy', () => {
  const input = structuredClone(source), before = structuredClone(source)
  const changed = approvalReviewCatalog(input, settings)
  expect(input).toEqual(before)
  expect(changed.models).toHaveLength(3)
  expect(changed.models[0]).toEqual({ ...source.models[0], auto_review_model_override: 'review-model' })
  expect(changed.models[1]).toEqual(source.models[1])
  expect(changed.models[2]).toEqual(source.models[2])
  expect(
    approvalReviewCatalog(source, { ...settings, defaultModel: 'native-model' }).models[0]!.auto_review_model_override,
  )
    .toBe('review-model')
})
it('rejects invalid routes, unknown IDs, duplicate models and non-API reviewers', () => {
  for (
    const value of [null, {}, { ...settings, providerId: '' }, { ...settings, providerId: 'other', extra: true }, {
      ...settings,
      catalogPath: 'https://example.com/models',
    }, { ...settings, models: { 'work-model': '' } }]
  ) {
    expect(() => parseApprovalReviewSettings(value)).toThrow()
  }
  expect(() => approvalReviewCatalog(source, { ...settings, models: { absent: 'review-model' } })).toThrow(
    'NOT_IN_CATALOG',
  )
  expect(() => approvalReviewCatalog(source, { ...settings, defaultModel: 'absent' })).toThrow('NOT_IN_CATALOG')
  expect(() => approvalReviewCatalog({ models: [source.models[0], source.models[0]] }, settings)).toThrow('INVALID')
  const notApi = structuredClone(source)
  notApi.models[1]!.supported_in_api = false
  expect(() => approvalReviewCatalog(notApi, settings)).toThrow('NOT_API_SUPPORTED')
  const noPolicy = structuredClone(source)
  noPolicy.models[1]!.model_messages.auto_review.policy = ''
  expect(() => approvalReviewCatalog(noPolicy, settings)).toThrow('REVIEW_POLICY_UNAVAILABLE')
  expect(() => approvalReviewCatalog({ models: [{ slug: 'work-model' }] }, settings)).toThrow('INVALID')
})
it('uses an immutable launch snapshot, preserves provider and removes only its temporary directory', async () => {
  const f = await fixture()
  await expect(prepareApprovalReviewCatalog({ settings, configPath: f.configPath, nativeVersion: 'unknown' }))
    .rejects.toThrow('VERSION_UNSUPPORTED')
  const lease = await prepareApprovalReviewCatalog({ settings, configPath: f.configPath, nativeVersion: '0.149.1' })
  expect((await stat(lease!.path)).mode & 0o777).toBe(0o400)
  expect(JSON.parse(await readFile(lease!.path, 'utf8')).models[0].auto_review_model_override).toBe('review-model')
  expect(localCodexAppServerArguments(lease!.path, true)).not.toContain('model_provider="openai"')
  await lease!.close()
  await expect(stat(lease!.path)).rejects.toThrow()
  expect(await readFile(path.join(f.root, 'models.json'), 'utf8')).toBe(JSON.stringify(source))
})
it('persists profile routing with revisions, leaves execution unchanged, and refuses agent writes', async () => {
  const f = await fixture(),
    call = createApprovalReviewConfiguration({ configPath: f.configPath, profileId: 'default' })
  expect(await call('save', { settings, expectedRevision: 0 }, { 'openai/threadId': 'agent' }))
    .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
  expect(await call('save', { settings, expectedRevision: 0 }, { 'cordisx/channelContext': 'actor' }))
    .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
  expect(await call('save', { settings, expectedRevision: 0 })).toMatchObject({
    status: 'ok',
    application: 'saved',
    applies: 'native-restart',
    revision: 1,
    sessionOverride: false,
  })
  expect((await loadHomeConfig(f.configPath)).apps.codex!.profiles.default!.chatExecution).toBeUndefined()
  expect(await call('save', { settings, expectedRevision: 0 })).toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(await call('save', { settings: null, expectedRevision: 1 })).toMatchObject({ revision: 2, settings: null })
  expect(await call('read', { sessionId: 'chat' })).toMatchObject({ status: 'rejected' })
})
it('fences incompatible provider use without changing sandbox, approvals or healthy turns', async () => {
  const f = await fixture()
  const execution = await ChatExecutionPreferences.open({
    file: path.join(f.root, 'execution.json'),
    configPath: f.configPath,
    appId: 'codex',
    profileId: 'default',
  })
  try {
    execution.bindReviewProvider('gateway', ['work-model', 'review-model'])
    const start = await execution.prepare('thread/start', {
      model: 'work-model',
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    })
    expect(start.params).toMatchObject({ modelProvider: 'gateway', sandbox: 'read-only', approvalPolicy: 'on-request' })
    expect(await execution.prepare('turn/start', { threadId: 'chat' })).toMatchObject({ contextRequired: true })
    await expect(execution.prepare('turn/start', { threadId: 'chat' }, { modelProvider: 'openai' }))
      .rejects.toThrow('REVIEW_PROVIDER_SCOPE_MISMATCH')
    expect(
      (await execution.prepare('turn/start', { threadId: 'chat' }, { modelProvider: 'gateway', model: 'work-model' }))
        .params,
    )
      .toEqual({ threadId: 'chat' })
    await expect(execution.prepare('thread/start', {})).rejects.toThrow('REVIEW_PARENT_MODEL_REQUIRED')
    await expect(execution.prepare('thread/start', { model: 'absent' })).rejects.toThrow('NOT_IN_CATALOG')
    await expect(
      execution.prepare('thread/settings/update', { threadId: 'chat', modelProvider: 'other', model: 'work-model' }),
    )
      .rejects.toThrow('REVIEW_PROVIDER_SCOPE_MISMATCH')
    await expect(execution.prepare('thread/start', { model: 'work-model', config: { model_provider: 'other' } }))
      .rejects.toThrow('REVIEW_NATIVE_CONFIG_CONFLICT')
    await expect(
      execution.prepare('turn/start', { threadId: 'chat', collaborationMode: { settings: { model: 'absent' } } }, {
        modelProvider: 'gateway',
        model: 'work-model',
      }),
    ).rejects.toThrow('NOT_IN_CATALOG')
  } finally {
    await execution.close()
  }
})
