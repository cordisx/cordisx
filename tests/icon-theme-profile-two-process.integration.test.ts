import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'tests/fixtures/icon-theme-profile-process.ts')

async function processPhase(phase: 'a' | 'b' | 'drain-error', configPath: string, hostGeneration: string): Promise<Record<string, unknown>> {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', fixture, phase, configPath, hostGeneration], {
    cwd: root,
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const line = stdout.split('\n').find(value => value.startsWith('CORDISX_ICON_PROCESS_RESULT='))
  if (line === undefined) throw new Error(`child process returned no icon-theme result: ${stdout}`)
  return JSON.parse(line.slice('CORDISX_ICON_PROCESS_RESULT='.length)) as Record<string, unknown>
}

describe('two-process icon-theme profile persistence', () => {
  it('propagates an unexpected Host-private callback failure through the teardown drain', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-drain-error-'))
    await expect(processPhase('drain-error', path.join(home, 'config.json'), 'host-drain-error'))
      .rejects.toMatchObject({ stderr: expect.stringContaining('discriminating callback failure') })
  })

  it('restores the same approved artifact across a fresh Host process and rejects changed or absent artifacts', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-icon-theme-two-process-'))
    const configPath = path.join(home, 'config.json')
    const processA = await processPhase('a', configPath, 'host-process-a-11111111')
    const processB = await processPhase('b', configPath, 'host-process-b-22222222')

    expect(processA.hostGeneration).not.toBe(processB.hostGeneration)
    expect(processA.configMode).toBe(0o600)
    expect(processB.configMode).toBe(0o600)
    expect(processA.wireCandidateKeys).toEqual([
      'namespace', 'providerGeneration', 'providerId', 'providerVersion',
    ])
    expect(processA.teardown).toEqual({
      callbacksPendingAtShutdown: 0,
      lateCallbackTouchedDom: false,
      callbacksDrained: true,
      nestedWindowMicrotasksDrained: true,
    })
    expect(processA.selected).toMatchObject({ providerId: 'plugin:icon-theme-test:aurora' })
    expect(processB.exact).toMatchObject({
      selected: {
        providerId: 'plugin:icon-theme-test:aurora',
        providerGeneration: (processA.selected as { providerGeneration: string }).providerGeneration,
      },
    })
    for (const result of [processB.changedArtifact, processB.missing, processB.disabled]) {
      expect(result).toMatchObject({ selected: { providerId: 'builtin:reicon', providerGeneration: 'reicon-1.2.1' } })
    }
    const preference = (await loadHomeConfig(configPath)).apps.codex!.profiles.default!.iconTheme!
    expect(preference).toEqual(processA.preference)
    expect(preference.providerGeneration).toBe((processA.selected as { providerGeneration: string }).providerGeneration)
  }, 120_000)
})
