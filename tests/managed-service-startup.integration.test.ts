import { type ChildProcess, spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { declaration, definition, fixture, owner, runtime } from './managed-service-runtime-fixture.js'

it('reaps a slow real child at the short deadline and admits it with sufficient startup headroom', async () => {
  const { root, home } = await fixture()
  const children: ChildProcess[] = []
  const diagnostic = vi.fn()
  const host = runtime(home, {
    onStartupDiagnostic: diagnostic,
    spawn: ((_executable, arguments_, options) => {
      const child = spawn(process.execPath, [
        '-e',
        `
        const { createServer } = require('node:http')
        setTimeout(() => {
          const server = createServer((request, response) => response.writeHead(204).end())
          server.listen(Number(process.argv[1]), '127.0.0.1')
          process.on('SIGTERM', () => server.close(() => process.exit(0)))
        }, 300)
      `,
        ...arguments_!,
      ], options!)
      children.push(child)
      return child
    }) as typeof spawn,
  })
  try {
    for (const budget of [100, 3_000]) {
      const id = `slow-${budget}`
      const binding = host.bind({
        owner: owner(id, 'one'),
        source: `https://plugins.example.test/${id}`,
        declaration: declaration(id, id, []),
        artifactDirectory: root,
      }, new AbortController().signal)
      try {
        const value = definition(id)
        value.launch = { ...value.launch, startupTimeoutMs: budget }
        const registration = await binding.registry.register(value, { revision: `sha256:${'c'.repeat(64)}` })
        const result = await registration.ensureReady()
        expect(result.status).toBe(budget === 100 ? 'failed' : 'ready')
        if (budget === 100) {
          expect(diagnostic).toHaveBeenCalledWith(
            expect.objectContaining({ reason: 'startup-timeout', timeoutMs: 100 }),
          )
          expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
        } else {
          expect(children[1]!.exitCode).toBeNull()
          expect(children[1]!.signalCode).toBeNull()
        }
      } finally {
        await binding.dispose()
      }
    }
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
    expect(host.listRegistrationIdentities()).toEqual([])
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise(resolve => child.once('exit', resolve))
      }
    }
    await rm(root, { recursive: true, force: true })
  }
})
