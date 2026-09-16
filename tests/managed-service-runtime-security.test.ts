import type { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cliDefinition,
  declaration,
  definition,
  fixture,
  owner,
  runtime,
  syntheticChild,
} from './managed-service-runtime-fixture.js'

describe('managed service runtime security boundaries', () => {
  it('rejects protected HOME bindings before authentication or launch', async () => {
    const { root, home } = await fixture()
    let spawnCount = 0
    const host = runtime(home, {
      spawn: (() => {
        spawnCount += 1
        return syntheticChild().child
      }) as typeof nodeSpawn,
    })
    const binding = host.bind({
      owner: owner('protected-home-plugin', 'home-one'),
      source: 'https://plugins.example.test/protected-home',
      declaration: declaration('protected-home-service', 'protected-home-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = cliDefinition('protected-home-service')
    value.protectedBindings = [{
      slot: 'service_key',
      source: 'generated-local-key',
      target: 'environment',
      variable: 'HOME',
    }]
    const registration = await binding.registry.register(value, { revision: `sha256:${'3'.repeat(64)}` })

    expect((await registration.authenticate('login')).status).toBe('failed')
    expect((await registration.ensureReady()).status).toBe('failed')
    expect(spawnCount).toBe(0)
    await binding.dispose()
  })

  it('rejects a mutated package-root port file before discovery or spawn', async () => {
    const { root, home } = await fixture()
    const declaredPort = '41231'
    await writeFile(path.join(root, 'package.port'), declaredPort)
    let spawnCount = 0
    let fetchCount = 0
    const host = runtime(home, {
      spawn: (() => {
        spawnCount += 1
        return syntheticChild().child
      }) as typeof nodeSpawn,
      fetch: async () => {
        fetchCount += 1
        return new Response(null, { status: 204 })
      },
    })
    const serviceDeclaration = declaration('package-port-service', 'package-port-plugin', [])
    serviceDeclaration.runtimeResources = [
      ...serviceDeclaration.runtimeResources,
      {
        path: './package.port',
        mode: 'data',
        byteLength: Buffer.byteLength(declaredPort),
        digest: `sha256:${createHash('sha256').update(declaredPort).digest('hex')}`,
      },
    ]
    const binding = host.bind({
      owner: owner('package-port-plugin', 'port-one'),
      source: 'https://plugins.example.test/package-port',
      declaration: serviceDeclaration,
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = definition('package-port-service', { fixedPort: 41_231 })
    value.launch = {
      executable: { kind: 'named-command', command: 'must-not-spawn' },
      arguments: [],
      startupTimeoutMs: 100,
    }
    value.discovery = {
      kind: 'restricted-port-file',
      root: 'package',
      file: './package.port',
      format: 'decimal-port',
    }
    const registration = await binding.registry.register(value, { revision: `sha256:${'e'.repeat(64)}` })
    await writeFile(path.join(root, 'package.port'), '41232')

    expect((await registration.ensureReady()).status).toBe('failed')
    expect(fetchCount).toBe(0)
    expect(spawnCount).toBe(0)
    await binding.dispose()
  })
})
