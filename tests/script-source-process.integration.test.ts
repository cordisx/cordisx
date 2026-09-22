import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { scriptExecutionSupported } from '../packages/cli/src/launcher/model-catalog/script-executor.js'
import { output, scriptFixture } from './script-source-helpers.js'

describe('script process lifecycle and budgets', () => {
  it.each(['stdout', 'stderr'] as const)('drains and bounds %s concurrently', async stream => {
    const fixture = await scriptFixture(`process.${stream}.write('x'.repeat(131072));setInterval(()=>{},1000)`, {
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
    })
    try {
      expect(await fixture.run()).toMatchObject({ error: 'script-budget-exceeded', complete: false })
      expect(fixture.diagnostics.mock.calls[0]?.[0][`${stream}Bytes`]).toBeGreaterThan(4096)
      expect(JSON.stringify(fixture.diagnostics.mock.calls)).not.toContain('xxxx')
    } finally {
      await fixture.close()
    }
  })

  it('retains complete LKG after deadline without retrying', async () => {
    const fixture = await scriptFixture(output(), { timeoutMs: 100 })
    try {
      await fixture.run()
      await writeFile(fixture.file, 'setInterval(()=>{},1000)')
      expect(await fixture.run()).toMatchObject({ error: 'script-timeout', complete: true, freshness: 'stale' })
      const count = fixture.diagnostics.mock.calls.length
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(fixture.diagnostics).toHaveBeenCalledTimes(count)
    } finally {
      await fixture.close()
    }
  })

  it.each(['cancel', 'dispose', 'root-exit'] as const)(
    'cleans descendants after %s, including SIGTERM-resistant pipes',
    async action => {
      const fixture = await scriptFixture('')
      const pidFile = path.join(fixture.root, 'child.pid')
      try {
        const child = `require('node:fs').writeFileSync(${
          JSON.stringify(pidFile)
        }, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`
        await writeFile(
          fixture.file,
          `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${
            JSON.stringify(child)
          }], {stdio:'inherit'});
        ${
            action === 'root-exit'
              ? `setTimeout(()=>{${output()};process.exit(0)},150)`
              : 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
          }
      `,
        )
        fixture.runtime.run(fixture.intent())
        let pid = 0
        await vi.waitFor(async () => {
          pid = Number(await readFile(pidFile, 'utf8'))
          expect(pid).toBeGreaterThan(0)
        }, { timeout: 3000 })
        if (action === 'cancel') await fixture.runtime.cancel(fixture.intent())
        if (action === 'dispose') await fixture.runtime.dispose()
        if (action === 'root-exit') {
          await vi.waitFor(() => expect(fixture.runtime.readStatus(fixture.binding.bindingRef)?.loading).toBe(false), {
            timeout: 4000,
          })
        }
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
        if (action === 'cancel') expect(fixture.runtime.readStatus(fixture.binding.bindingRef)?.error).toBe('cancelled')
        if (action === 'root-exit') expect(fixture.runtime.readStatus(fixture.binding.bindingRef)?.complete).toBe(true)
      } finally {
        await fixture.close()
      }
    },
  )

  it('rejects spawn failure and unsupported platforms without a shell fallback', async () => {
    expect(scriptExecutionSupported('win32')).toBe(false)
    const fixture = await scriptFixture(output(), {
      command: { kind: 'exec', executable: '/does-not-exist/fixture', args: [] },
    })
    try {
      expect(await fixture.run()).toMatchObject({ error: 'script-exit-failed', complete: false })
    } finally {
      await fixture.close()
    }
  })
})
