import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { ScriptSourceRuntime } from '../packages/cli/src/launcher/model-catalog/script-runtime.js'
import type { ScriptMode, ScriptSourceConfig } from '../packages/cli/src/launcher/model-catalog/script-types.js'

/** Only generated, test-owned files and process.execPath are registered or executed. */
export async function scriptFixture(
  source: string,
  patch: Partial<ScriptSourceConfig> = {},
  mode: ScriptMode = 'replace',
) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cordisx-script-fixture-')))
  const file = path.join(root, 'fixture.cjs')
  await writeFile(file, source)
  const config = {
    schemaVersion: 1 as const,
    command: { kind: 'exec' as const, executable: process.execPath, args: [file] },
    cwd: root,
    environment: { inherit: false, refs: {}, values: {} },
    timeoutMs: 3000,
    maxStdoutBytes: 1_048_576,
    maxStderrBytes: 65_536,
    maxModels: 1000,
    ...patch,
  }
  const binding = { bindingRef: 'fixture-binding', scopeRevision: 'scope-1', mode }
  const diagnostics = vi.fn()
  const environment = vi.fn(() => ({
    FIXTURE_TOKEN: 'fixture-secret-value',
    FIXTURE_VALUE: 'allowed',
    PATH: process.env.PATH,
  }))
  const runtime = new ScriptSourceRuntime({ diagnostic: diagnostics, environment })
  runtime.save(binding, config)
  const intent = () => ({ ...binding, expectedRevision: runtime.readStatus(binding.bindingRef)!.revision })
  return {
    root,
    file,
    config,
    binding,
    runtime,
    diagnostics,
    environment,
    intent,
    async run() {
      expect(runtime.run(intent()).status).toBe('started')
      await vi.waitFor(() => expect(runtime.readStatus(binding.bindingRef)?.loading).toBe(false), {
        timeout: 10_000,
        interval: 20,
      })
      return runtime.readStatus(binding.bindingRef)!
    },
    async close() {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export const output = (models: unknown[] = [{ id: 'fixture-model' }]) =>
  `process.stdout.write(${JSON.stringify(JSON.stringify({ schemaVersion: 1, complete: true, models }))})`
