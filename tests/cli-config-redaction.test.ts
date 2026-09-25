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
