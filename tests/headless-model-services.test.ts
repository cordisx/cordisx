import { describe, expect, it } from 'vitest'
import { createDefaultHomeConfig, parseHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  availableHeadlessModelServices,
  prepareHeadlessModelServices,
} from '../packages/cli/src/launcher/headless-model-services.js'
import { withoutLauncherSecrets } from '../packages/cli/src/launcher/secret-resolver.js'

const service = (id: string, extra = {}) => ({
  id,
  kind: 'model-service',
  displayName: id,
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: id.toUpperCase() + '_KEY',
  protocols: ['openai-responses'],
  models: { codex: ['work'] },
  ...extra,
})
const saved = (name: string, value: string, enabled = true) => ({ name, value, enabled })

describe('headless model-service credentials', () => {
  it('merges only needed saved keys and headers without mutating the launch environment', () => {
    const config = parseHomeConfig({
      ...createDefaultHomeConfig(),
      providers: [
        service('one', { runtimeOptions: { codex: { env_http_headers: { 'X-Token': 'HEADER_KEY' } } } }),
        service('two'),
        service('disabled', { enabled: false }),
        service('claude', { protocols: ['anthropic-messages'] }),
        service('other', { appliesTo: ['claude'] }),
        service('empty', { models: undefined }),
      ],
      environmentVariables: [
        'ONE_KEY',
        'TWO_KEY',
        'HEADER_KEY',
        'DISABLED_KEY',
        'CLAUDE_KEY',
        'OTHER_KEY',
        'EMPTY_KEY',
        'UNRELATED',
      ].map(name => saved(name, 'saved-' + name)),
    })
    const base = { PATH: '/bin', ONE_KEY: 'old', NATIVE_KEY: 'external' }
    const prepared = prepareHeadlessModelServices(config, base)
    expect(prepared.services.map(service => service.id)).toEqual(['one', 'two'])
    expect(prepared.environment).toEqual({
      PATH: '/bin',
      NATIVE_KEY: 'external',
      ONE_KEY: 'saved-ONE_KEY',
      TWO_KEY: 'saved-TWO_KEY',
      HEADER_KEY: 'saved-HEADER_KEY',
    })
    expect(base.ONE_KEY).toBe('old')
  })

  it('honors disabled saved values, missing headers, and the Channel credential exclusion', () => {
    const config = parseHomeConfig({
      ...createDefaultHomeConfig(),
      providers: [
        service('one'),
        service('channel', { apiKeyEnv: 'CHANNEL_KEY' }),
        service('headers', { runtimeOptions: { codex: { env_http_headers: { 'X-Token': 'MISSING_HEADER' } } } }),
        service('ready'),
      ],
      environmentVariables: [saved('ONE_KEY', 'revoked', false), saved('CHANNEL_KEY', 'channel-secret')],
    })
    const prepared = prepareHeadlessModelServices(config, {
      ONE_KEY: 'inherited',
      HEADERS_KEY: 'key',
      READY_KEY: 'ready',
    })
    const safe = withoutLauncherSecrets(prepared.environment, ['host-secret:env/CHANNEL_KEY'])
    const report: string[] = []
    expect(availableHeadlessModelServices(prepared, safe, code => report.push(code)).map(service => service.id))
      .toEqual(['ready'])
    expect(safe.ONE_KEY).toBeUndefined()
    expect(safe.CHANNEL_KEY).toBeUndefined()
    expect(report).toEqual([
      'HEADLESS_MODEL_SERVICE_CREDENTIAL_UNAVAILABLE:one',
      'HEADLESS_MODEL_SERVICE_CREDENTIAL_UNAVAILABLE:channel',
      'HEADLESS_MODEL_SERVICE_CREDENTIAL_UNAVAILABLE:headers',
    ])
    expect(JSON.stringify(report)).not.toMatch(/inherited|revoked|channel-secret/)
  })

  it('keeps saved credentials separate across selected homes', () => {
    const make = (key: string) =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        providers: [service('one')],
        environmentVariables: [saved('ONE_KEY', key)],
      })
    expect(prepareHeadlessModelServices(make('account-a'), {}).environment.ONE_KEY).toBe('account-a')
    expect(prepareHeadlessModelServices(make('account-b'), {}).environment.ONE_KEY).toBe('account-b')
  })
})
