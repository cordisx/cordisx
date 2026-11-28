import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const exec = promisify(execFile)

it.skipIf(process.platform === 'win32')('exits if a control socket cannot be published', async () => {
  const directory = await mkdtemp('/tmp/cx-control-')
  try {
    const socket = path.join(directory, 's'.repeat(160))
    const module = pathToFileURL(path.resolve('packages/cli/src/cli/supervisor-control.ts')).href
    const script = [
      'import { startSupervisorControlServer } from ' + JSON.stringify(module),
      'try {',
      "  const server = await startSupervisorControlServer({ socketPath: process.argv[1], token: 'fixture', stop() {} })",
      "  await server.close(); console.log('unexpected')",
      "} catch { console.log('rejected') }",
    ].join('\n')
    const result = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, socket], {
      cwd: process.cwd(),
      timeout: 5_000,
    })
    expect(result.stdout.trim()).toBe('rejected')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
