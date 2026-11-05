import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { prepareTerminalCodexProviderLayer } from '../packages/cli/src/cli/terminal-codex-provider-layer.js'

it('masks only inherited runtime keys, preserving explicit zero and leaving native config unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'terminal-provider-layer-'))
  const filename = path.join(root, 'config.toml')
  const original = `[model_providers."example.service"]
request_max_retries = 9
stream_idle_timeout_ms = 1
query_params.untouched = "fixture"
env_http_headers."X-Stale" = "FIXTURE"
[model_providers."example.service".http_headers]
"X-Old" = "private-fixture"
`
  const selection = {
    providerId: 'example.service',
    runtimeOptionsOwned: true,
    provider: { http_headers: { 'X-Empty': '' }, request_max_retries: 0 },
  }
  try {
    await writeFile(filename, original)
    await expect(
      prepareTerminalCodexProviderLayer({ ...selection, runtimeOptionsOwned: false }, { CODEX_HOME: root }, []),
    )
      .resolves.toBeUndefined()
    await expect(prepareTerminalCodexProviderLayer(selection, { CODEX_HOME: root }, ['exec', '--profile', 'native']))
      .rejects.toThrow(/native --profile/)
    expect(await readdir(root)).toEqual(['config.toml'])
    const layer = await prepareTerminalCodexProviderLayer(selection, { CODEX_HOME: root }, ['exec'])
    if (!layer?.name) throw new Error('expected runtime map layer')
    try {
      const layerPath = path.join(root, layer.name + '.config.toml')
      expect(await readFile(layerPath, 'utf8')).toBe(
        '[model_providers."example.service"]\nhttp_headers = false\nenv_http_headers = false\n',
      )
      expect(layer.provider).toEqual({
        http_headers: { 'X-Empty': '' },
        env_http_headers: {},
        request_max_retries: 0,
        stream_idle_timeout_ms: 300_000,
      })
    } finally {
      await layer.close()
    }
    expect(await readdir(root)).toEqual(['config.toml'])
    expect(await readFile(filename, 'utf8')).toBe(original)
    const alias = path.join(root, 'alias')
    await symlink(root, alias)
    await expect(prepareTerminalCodexProviderLayer(selection, { CODEX_HOME: alias }, [])).rejects.toThrow(
      /CODEX_HOME directory/,
    )
    expect((await readdir(root)).sort()).toEqual(['alias', 'config.toml'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
