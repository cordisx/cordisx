import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { expect, it } from 'vitest'
import { startHeadlessService } from '../packages/cli/src/cli/headless-service.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'

it('starts the actual headless composition with all declared routes and only their saved credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-headless-models-'))
  const homeDir = path.join(root, 'cordisx'), codexHome = path.join(root, 'codex')
  const configPath = path.join(homeDir, 'config.json'), executable = path.join(root, 'codex-fixture')
  let service: Awaited<ReturnType<typeof startHeadlessService>> | undefined
  try {
    await Promise.all([mkdir(homeDir), mkdir(codexHome)])
    const config = createDefaultHomeConfig()
    const providers = ['first', 'second', 'third'].map(id => ({
      id,
      kind: 'model-service' as const,
      displayName: id,
      baseUrl: 'https://example.test/v1',
      apiKeyEnv: id.toUpperCase() + '_KEY',
      protocols: ['openai-responses'] as const,
      models: { codex: ['work'] },
    }))
    await writeFile(
      configPath,
      JSON.stringify({
        ...config,
        providers,
        environmentVariables: [...providers.map(p => ({ name: p.apiKeyEnv, value: 'saved-' + p.id, enabled: true })), {
          name: 'UNRELATED_KEY',
          value: 'do-not-forward',
          enabled: true,
        }],
        plugins: [{
          id: 'channel',
          entry: bundledPluginEntry('channel'),
          services: {
            runtime: {
              profiles: {
                default: {
                  revision: 1,
                  lastGoodRevision: 1,
                  config: {
                    contract: 'cordisx.channel-service-config/v1',
                    schemaVersion: 1,
                    connections: [],
                  },
                },
              },
            },
          },
        }],
      }),
      { mode: 0o600 },
    )
    await writeFile(path.join(codexHome, 'config.toml'), 'model_provider="old"\nmodel="original"\n', { mode: 0o600 })
    const fixture = `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli 0.149.1'); process.exit(0) }
const {createInterface}=await import('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.method==='initialized')return;
  const ready=process.env.FIRST_KEY==='saved-first'&&process.env.SECOND_KEY==='saved-second'
    &&process.env.THIRD_KEY==='saved-third'&&process.env.UNRELATED_KEY===undefined;
  const result=m.method==='model/list'?{data:[{id:'native',model:'native',hidden:false,displayName:ready?'Credentials ready':'Credentials missing'}]}:{};
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`
    await writeFile(executable, fixture)
    await chmod(executable, 0o700)
    service = await startHeadlessService({
      configPath,
      homeDir,
      appId: 'codex',
      profileId: 'default',
      userHome: root,
      codexHome,
      codexExecutable: executable,
      cwd: root,
      environment: { PATH: process.env.PATH },
      generation: 'test',
      report: () => {},
    })
    const result = await service.codex('list', {}) as {
      providers: Array<{ providerId: string; models: Array<{ label: string }> }>
    }
    expect(result.providers.map(provider => provider.providerId)).toEqual(['openai', 'first', 'second', 'third'])
    expect(result.providers[0]?.models[0]?.label).toBe('Credentials ready')
    expect(JSON.stringify(result)).not.toContain('saved-')
    const native = parse(await readFile(path.join(codexHome, 'config.toml'), 'utf8'))
    expect(native).toMatchObject({ model_provider: 'old', model: 'original' })
    expect(Object.keys(native.model_providers as object)).toEqual(['first', 'second', 'third'])
  } finally {
    await service?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
