import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeCliPath } from '../packages/cli/assets/launcher/native-cli-path.mjs'

describe('native CLI identity after tool environment filtering', () => {
  it('resolves only the same packaged App CLI and rejects an escaping symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-native-cli-'))
    const resources = path.join(root, 'Test.app', 'Contents', 'Resources')
    const node = path.join(resources, 'cua_node', 'bin', 'node')
    const cli = path.join(resources, 'codex-cli', 'bin', 'codex')
    try {
      await mkdir(path.dirname(node), { recursive: true })
      await mkdir(path.dirname(cli), { recursive: true })
      await writeFile(node, '')
      await writeFile(cli, '', { mode: 0o700 })
      expect(nativeCliPath({}, node)).toBe(await realpath(cli))
      expect(() => nativeCliPath({}, process.execPath)).toThrow('Native CLI path is not configured')
      expect(() => nativeCliPath({ CORDISX_NATIVE_REAL_CODEX_PATH: 'relative' }, node)).toThrow()
      await rm(cli)
      const outside = path.join(root, 'outside')
      await writeFile(outside, '', { mode: 0o700 })
      await symlink(outside, cli)
      expect(() => nativeCliPath({}, node)).toThrow('left its App installation')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
