import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { mkdtemp } from './helpers/cli-run-fixtures.js'

it('prints managed Provider configuration without credential material', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-redacted-config-'))
  const home = path.join(root, 'home')
  await runCordisXCli(['setup'], { env: { CORDISX_HOME: home }, stdout: () => undefined })
  const configPath = path.join(home, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
  config.apps.codex.profiles.default.managedProviders = [{
    id: 'a'.repeat(43),
    revision: 'b'.repeat(43),
    scopeRevision: 'c'.repeat(43),
    credentialRevision: 'd'.repeat(43),
    credentialRef: 'e'.repeat(43),
    secret: 'fixture-provider-secret',
    settings: {
      title: 'Fixture',
      endpoint: 'https://fixture.invalid/v1',
      protocol: 'responses',
      discoveryEnabled: false,
      strategy: { kind: 'manual', ids: ['fixture-model'] },
      supplement: [],
    },
  }]
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  const output: string[] = []
  await runCordisXCli(['config'], { env: { CORDISX_HOME: home }, stdout: line => output.push(line) })
  expect(output.join('\n')).toContain('"credentialState": "set"')
  expect(output.join('\n')).not.toMatch(/fixture-provider-secret|eeeeeeee/u)
  expect(await readFile(configPath, 'utf8')).toContain('fixture-provider-secret')
})

it('prints only names and safe runtime options for shared model services', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-redacted-service-'))
  const home = path.join(root, 'home')
  await runCordisXCli(['setup'], { env: { CORDISX_HOME: home }, stdout: () => undefined })
  const configPath = path.join(home, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.providers = [{
    id: 'fixture-service',
    kind: 'model-service',
    displayName: 'Fixture',
    baseUrl: 'https://fixture.invalid/v1',
    apiKeyEnv: 'FIXTURE_API_KEY',
    protocols: ['openai-responses'],
    runtimeOptions: {
      codex: {
        http_headers: { 'X-Fixed': 'fixture-private-header', 'X-Empty': '' },
        env_http_headers: { 'X-Environment': 'FIXTURE_HEADER_REF' },
        supports_websockets: false,
        request_max_retries: 0,
      },
    },
  }]
  const raw = JSON.stringify(config)
  await writeFile(configPath, raw, { mode: 0o600 })
  for (const command of ['config', 'setup']) {
    const output: string[] = []
    await runCordisXCli([command], {
      env: { CORDISX_HOME: home, FIXTURE_HEADER_REF: 'fixture-runtime-env-value' },
      stdout: line => output.push(line),
    })
    expect(output.join('\n')).not.toMatch(/fixture-private-header|fixture-runtime-env-value/)
    const printed = JSON.parse(output.at(-1)!)
    expect(printed.providers[0]).toMatchObject({
      httpHeaderNames: ['X-Fixed', 'X-Empty'],
      runtimeOptions: {
        codex: {
          env_http_headers: { 'X-Environment': 'FIXTURE_HEADER_REF' },
          supports_websockets: false,
          request_max_retries: 0,
        },
      },
    })
    expect(printed.providers[0].runtimeOptions.codex).not.toHaveProperty('http_headers')
  }
  expect(await readFile(configPath, 'utf8')).toBe(raw)
})
