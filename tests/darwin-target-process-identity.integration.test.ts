import { constants } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { parseDarwinProcessIdentity } from '../packages/cli/src/launcher/darwin-process-identity.js'
import { compareProcessStartTimes } from '../packages/cli/src/launcher/process-start-identity.js'

async function lineFrom(child: ChildProcessWithoutNullStreams): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('sandbox identity probe timed out')), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', value => {
      output += value
      const end = output.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      resolve(output.slice(0, end))
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (!output.includes('\n')) reject(new Error(`sandbox identity probe exited: ${code}`))
    })
  })
}

it.skipIf(process.platform !== 'darwin')(
  'verifies a same-user target inside a network-restricted sandbox without enumerating other processes',
  async () => {
    await access('/usr/bin/clang', constants.X_OK)
    await access('/usr/bin/sandbox-exec', constants.X_OK)
    const root = await mkdtemp('/tmp/cx-target-identity-')
    const helper = path.join(root, 'identity')
    const source = fileURLToPath(new URL('../packages/cli/native/process-identity.c', import.meta.url))
    let sandbox: ChildProcessWithoutNullStreams | undefined
    try {
      execFileSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', helper])
      for (const invalid of ['0', '-1', '1x', '2147483648']) {
        const value = JSON.parse(execFileSync(helper, ['--pid', invalid], { encoding: 'utf8' }))
        expect(value).toMatchObject({ status: 'unavailable', reason: 'invalid-identity' })
      }
      const absent = JSON.parse(execFileSync(helper, ['--pid', '2147483647'], { encoding: 'utf8' }))
      expect(absent).toMatchObject({ status: 'unavailable', reason: 'identity-unavailable' })
      const program = `
        const { spawn, execFile } = require("node:child_process");
        const target = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { stdio: "ignore" });
        const cleanup = () => { try { target.kill(); } catch {} };
        process.on("exit", cleanup);
        process.on("SIGTERM", () => { cleanup(); process.exit(1); });
        process.stdin.once("data", () => { cleanup(); process.exit(0); });
        execFile(${JSON.stringify(helper)}, ["--pid", String(target.pid)],
          { env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
            if (error) { cleanup(); process.exit(1); }
            process.stdout.write(stdout);
          });
        setTimeout(() => { cleanup(); process.exit(1); }, 12000);
      `
      sandbox = spawn('/usr/bin/sandbox-exec', [
        '-p',
        '(version 1)(allow default)(deny network-outbound)',
        process.execPath,
        '-e',
        program,
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
      const text = await lineFrom(sandbox)
      const parsed = JSON.parse(text) as { processes?: Array<{ pid?: number }> }
      const pid = parsed.processes?.[0]?.pid
      expect(pid).toBeTypeOf('number')
      const identity = parseDarwinProcessIdentity(text, pid!)
      const fromPs = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      }).trim()
      expect(compareProcessStartTimes(identity.startedAt, fromPs)).toBe('alive')
      sandbox.stdin.end('done')
      const exit = await new Promise<number | null>(resolve => sandbox!.once('exit', resolve))
      expect(exit).toBe(0)
    } finally {
      if (sandbox && sandbox.exitCode === null) sandbox.kill('SIGTERM')
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)
