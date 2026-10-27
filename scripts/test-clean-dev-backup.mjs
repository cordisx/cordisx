import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const source = new URL('./check-clean-dev.mjs', import.meta.url)
const outputs = ['channel-runtime', 'schemastery-ui', 'cli']

test('clean-dev backs up on the checkout filesystem and restores outputs after preparation fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cordisx-backup-test-'))
  try {
    await mkdir(path.join(root, 'scripts'))
    await mkdir(path.join(root, 'bin'))
    await copyFile(source, path.join(root, 'scripts/check-clean-dev.mjs'))
    for (const name of outputs) {
      const directory = path.join(root, 'packages', name, 'dist')
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'original'), name)
    }
    await writeFile(
      path.join(root, 'bin/npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const backups = fs.readdirSync(root).filter(name => name.startsWith('.cordisx-clean-dev-'));
if (backups.length !== 1) process.exit(42);
for (const name of ['channel-runtime', 'schemastery-ui', 'cli']) {
  if (!fs.existsSync(path.join(root, backups[0], 'packages', name, 'dist/original'))) process.exit(43);
  const dist = path.join(root, 'packages', name, 'dist');
  fs.mkdirSync(dist, {recursive: true});
  fs.writeFileSync(path.join(dist, 'partial'), 'incomplete');
}
console.error('intentional preparation failure');
process.exit(17);
`,
      { mode: 0o755 },
    )
    await assert.rejects(
      exec(process.execPath, ['scripts/check-clean-dev.mjs'], {
        cwd: root,
        env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` },
      }),
      /intentional preparation failure/,
    )
    for (const name of outputs) {
      const directory = path.join(root, 'packages', name, 'dist')
      assert.equal(await readFile(path.join(directory, 'original'), 'utf8'), name)
      assert.deepEqual(await readdir(directory), ['original'])
    }
    assert.equal((await readdir(root)).some(name => name.startsWith('.cordisx-clean-dev-')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
