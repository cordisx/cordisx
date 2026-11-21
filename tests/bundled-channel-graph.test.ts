import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { verifyBundledChannelBrowserGraph } from '../scripts/check-installed-channel.mjs'

it('checks the installed Channel module and its initial stylesheet', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-graph-'))
  try {
    const graphRoot = path.join(root, 'dist/browser')
    await mkdir(path.join(graphRoot, 'assets'), { recursive: true })
    const module = Buffer.from('export const ready = true\n')
    const style = Buffer.from('.channel { color: inherit }\n')
    const file = (name: string, kind: string, data: Buffer) => ({
      path: name,
      kind,
      byteLength: data.byteLength,
      digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    })
    await Promise.all([
      writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({ entry: './dist/browser/module.js' })),
      writeFile(path.join(graphRoot, 'module.js'), module),
      writeFile(path.join(graphRoot, 'assets/channel.css'), style),
      writeFile(
        path.join(graphRoot, 'artifact.json'),
        JSON.stringify({
          contract: 'cordisx.plugin-generation-artifact/v1',
          entry: './module.js',
          initialStyles: ['./assets/channel.css'],
          files: [file('./module.js', 'module', module), file('./assets/channel.css', 'stylesheet', style)],
        }),
      ),
    ])
    await expect(verifyBundledChannelBrowserGraph(root)).resolves.toBeUndefined()
    await writeFile(path.join(graphRoot, 'assets/channel.css'), 'corrupted')
    await expect(verifyBundledChannelBrowserGraph(root)).rejects.toThrow('integrity readback')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
