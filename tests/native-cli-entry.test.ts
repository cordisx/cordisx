import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createNativeCliEntry } from '../packages/cli/src/launcher/native-cli-entry.js'

it('retains the exact Node and argument bytes after all launcher environment variables are filtered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-entry-'quoted-"))
  const script = path.join(root, "entry 'quoted'.mjs")
  await writeFile(script, 'console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}))')
  const entry = await createNativeCliEntry(process.execPath, script)
  try {
    const args = ['sandbox', 'a b', '$value', "'quoted'"]
    const child = spawn(entry.executable, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => output += value)
    expect(await once(child, 'close')).toEqual([0, null])
    expect(JSON.parse(output)).toEqual({ node: process.execPath, args })
  } finally {
    await entry.close()
    await expect(access(entry.executable)).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
  }
})
