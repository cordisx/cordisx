import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createScriptManagementHandler } from '../packages/cli/src/launcher/model-catalog/script-management.js'
import { ScriptSourceRuntime } from '../packages/cli/src/launcher/model-catalog/script-runtime.js'
import { output, scriptFixture } from './script-source-helpers.js'

describe('developer script source lifecycle', () => {
  it('save/read/subscription never execute, and editing the script needs no new grant', async () => {
    const fixture = await scriptFixture(output())
    const events = vi.fn()
    const unsubscribe = fixture.runtime.subscribe(events)
    try {
      const before = fixture.runtime.readStatus(fixture.binding.bindingRef)!
      fixture.runtime.save(fixture.binding, fixture.config)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(fixture.diagnostics).not.toHaveBeenCalled()
      expect(events).not.toHaveBeenCalled()
      expect(fixture.environment).not.toHaveBeenCalled()
      expect((await fixture.run()).models[0]?.id).toBe('fixture-model')
      await writeFile(fixture.file, output([{ id: 'edited-in-place' }]))
      expect((await fixture.run()).models[0]?.id).toBe('edited-in-place')
      const after = fixture.runtime.readStatus(fixture.binding.bindingRef)!
      expect(after.authorityRevision).toBe(before.authorityRevision)
      expect(after.runGeneration).toBeGreaterThan(before.runGeneration)
      expect(events.mock.calls.at(-1)?.[0]).toMatchObject({
        scopeRevision: 'scope-1',
        authorityRevision: after.authorityRevision,
        runGeneration: after.runGeneration,
      })
    } finally {
      unsubscribe()
      await fixture.close()
    }
  })

  it('retains LKG after invalid, partial or nonzero output, and commits complete-empty', async () => {
    const fixture = await scriptFixture(output())
    try {
      await fixture.run()
      for (
        const source of [
          'process.stdout.write("not JSON: fixture-secret")',
          `${output([{ id: 'not-accepted' }])};process.exitCode=3`,
          'process.stdout.write(JSON.stringify({schemaVersion:1,complete:false,models:[]}))',
        ]
      ) {
        await writeFile(fixture.file, source)
        const status = await fixture.run()
        expect(status).toMatchObject({ complete: true, freshness: 'stale' })
        expect(status.models.map(model => model.id)).toEqual(['fixture-model'])
      }
      await writeFile(fixture.file, output([]))
      expect(await fixture.run()).toMatchObject({ models: [], complete: true, freshness: 'fresh' })
      await writeFile(fixture.file, 'process.exit(1)')
      expect(await fixture.run()).toMatchObject({ models: [], complete: true, freshness: 'stale' })
      expect(JSON.stringify(fixture.diagnostics.mock.calls)).not.toMatch(/fixture-secret|not-accepted|not JSON/)
    } finally {
      await fixture.close()
    }
  })

  it('uses configured cwd, literal args, closed stdin, no default env or managed key', async () => {
    const fixture = await scriptFixture(`
      const fs = require('node:fs');
      const valid = fs.readFileSync(0).length === 0 && process.cwd() === __dirname
        && !process.env.FIXTURE_TOKEN && process.argv[2] === '$(touch should-not-exist)';
      process.stdout.write(JSON.stringify({schemaVersion:1,complete:true,models:[{id:valid?'safe':'bad'}]}));
    `)
    try {
      fixture.runtime.save(fixture.binding, {
        ...fixture.config,
        command: { kind: 'exec', executable: process.execPath, args: [fixture.file, '$(touch should-not-exist)'] },
      })
      expect((await fixture.run()).models[0]?.id).toBe('safe')
      expect(fixture.environment).not.toHaveBeenCalled()
      await expect(readFile(path.join(fixture.root, 'should-not-exist'))).rejects.toThrow()
    } finally {
      await fixture.close()
    }
  })

  it('allows explicit env references/inheritance for developer API authentication without logging secrets', async () => {
    const fixture = await scriptFixture(
      `
      const ok = process.env.API_KEY === 'fixture-secret-value' && !process.env.FIXTURE_TOKEN;
      process.stderr.write(process.env.API_KEY || '');
      process.stdout.write(JSON.stringify({schemaVersion:1,complete:true,models:[{id:ok?'reference-ok':'bad'}]}));
    `,
      { environment: { inherit: false, refs: { API_KEY: 'FIXTURE_TOKEN' }, values: {} } },
    )
    try {
      expect((await fixture.run()).models[0]?.id).toBe('reference-ok')
      expect(fixture.environment).toHaveBeenCalledOnce()
      expect(JSON.stringify(fixture.runtime.readStatus(fixture.binding.bindingRef))).not.toContain(
        'fixture-secret-value',
      )
      expect(JSON.stringify(fixture.diagnostics.mock.calls)).not.toContain('fixture-secret-value')
      fixture.runtime.save(fixture.binding, { ...fixture.config, environment: { inherit: true, refs: {}, values: {} } })
      await writeFile(
        fixture.file,
        `process.stdout.write(JSON.stringify({schemaVersion:1,complete:true,models:[{id:process.env.FIXTURE_TOKEN==='fixture-secret-value'?'inherit-ok':'bad'}]}))`,
      )
      expect((await fixture.run()).models[0]?.id).toBe('inherit-ok')
    } finally {
      await fixture.close()
    }
  })

  it('supports explicit shell command mode without exposing command or environment to the read DTO', async () => {
    const fixture = await scriptFixture(output())
    try {
      fixture.runtime.save(fixture.binding, {
        ...fixture.config,
        command: { kind: 'shell', command: `"${process.execPath}" "${fixture.file}"` },
      })
      expect((await fixture.run()).models[0]?.id).toBe('fixture-model')
      expect(JSON.stringify(fixture.runtime.readStatus(fixture.binding.bindingRef))).not.toMatch(
        /fixture\.cjs|executable|environment/,
      )
    } finally {
      await fixture.close()
    }
  })

  it('isolates config, mode and account changes and fences late output after removal', async () => {
    const fixture = await scriptFixture(`setTimeout(()=>{${output([{ id: 'late' }])}}, 500)`)
    try {
      const first = fixture.runtime.readStatus(fixture.binding.bindingRef)!
      fixture.runtime.run(fixture.intent())
      const next = fixture.runtime.save({ ...fixture.binding, scopeRevision: 'scope-2' }, fixture.config)
      expect(next.authorityRevision).not.toBe(first.authorityRevision)
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(fixture.runtime.readStatus(fixture.binding.bindingRef)).toMatchObject({
        scopeRevision: 'scope-2',
        models: [],
        complete: false,
      })
      fixture.runtime.save(fixture.binding, fixture.config)
      fixture.runtime.run(fixture.intent())
      await fixture.runtime.remove(fixture.binding.bindingRef)
      expect(fixture.runtime.readStatus(fixture.binding.bindingRef)).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })

  it('Run/Cancel reject stale CAS, plugin admission and arbitrary command payloads', async () => {
    const fixture = await scriptFixture(output())
    try {
      const handler = createScriptManagementHandler(
        fixture.runtime,
        (bindingRef) => bindingRef === fixture.binding.bindingRef,
      )
      const intent = { ...fixture.intent(), mode: undefined }
      delete (intent as { mode?: unknown }).mode
      const request = {
        kind: 'run',
        bindingRef: intent.bindingRef,
        scopeRevision: intent.scopeRevision,
        expectedRevision: intent.expectedRevision,
      }
      await expect(handler({ ...request, executable: '/bin/sh' })).rejects.toThrow('script-scope-invalid')
      await expect(handler({ ...request, grantId: 'legacy-grant' })).rejects.toThrow('script-scope-invalid')
      await expect(handler({ ...request, scopeRevision: 'other' })).rejects.toThrow('script-scope-invalid')
      await expect(createScriptManagementHandler(fixture.runtime, () => false)(request)).rejects.toThrow(
        'script-scope-invalid',
      )
      expect(await handler(request)).toEqual({ status: 'started' })
      await expect(handler(request)).rejects.toThrow('script-scope-invalid')
      await fixture.runtime.cancel(fixture.intent())
      expect(fixture.runtime.readStatus(fixture.binding.bindingRef)?.error).toBe('cancelled')
    } finally {
      await fixture.close()
    }
  })

  it('single-flights and caps concurrency without queuing implicit reruns', async () => {
    const fixture = await scriptFixture('setInterval(()=>{},1000)')
    const runtime = new ScriptSourceRuntime({ maxConcurrent: 1 })
    try {
      for (const bindingRef of ['one', 'two']) runtime.save({ ...fixture.binding, bindingRef }, fixture.config)
      const intent = (bindingRef: string) => ({
        bindingRef,
        scopeRevision: 'scope-1',
        expectedRevision: runtime.readStatus(bindingRef)!.revision,
      })
      expect(runtime.run(intent('one')).status).toBe('started')
      expect(runtime.run(intent('one')).status).toBe('already-running')
      expect(runtime.run(intent('two')).status).toBe('busy')
      await runtime.cancel(intent('one'))
      expect(runtime.readStatus('two')?.loading).toBe(false)
    } finally {
      await runtime.dispose()
      await fixture.close()
    }
  })

  it('bad saves leave the previous source intact and missing env refs fail safely', async () => {
    const fixture = await scriptFixture(output())
    try {
      await fixture.run()
      expect(() => fixture.runtime.save(fixture.binding, { command: 'bad' })).toThrow('script-command-invalid')
      expect(fixture.runtime.readStatus(fixture.binding.bindingRef)?.models).toHaveLength(1)
      fixture.runtime.save(fixture.binding, {
        ...fixture.config,
        environment: { inherit: false, refs: { API_KEY: 'MISSING' }, values: {} },
      })
      expect(await fixture.run()).toMatchObject({ models: [], complete: false, error: 'script-environment-missing' })
    } finally {
      await fixture.close()
    }
  })
})
