import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../assets', import.meta.url))
const destination = fileURLToPath(new URL('../dist/assets', import.meta.url))
const cliProxySource = fileURLToPath(new URL('../src/plugins/cli-proxy-api', import.meta.url))
const cliProxyDestination = fileURLToPath(new URL('../dist/src/plugins/cli-proxy-api', import.meta.url))
const channelSource = fileURLToPath(new URL('../src/plugins/channel', import.meta.url))
const channelDestination = fileURLToPath(new URL('../dist/src/plugins/channel', import.meta.url))
const channelRuntimeSource = fileURLToPath(new URL('../../channel-runtime/dist', import.meta.url))
const channelRuntimeDestination = fileURLToPath(new URL('../dist/channel-runtime', import.meta.url))
const channelServiceDestination = fileURLToPath(new URL('../dist/src/launcher/channel-service.js', import.meta.url))
const cordisxSkillSource = fileURLToPath(new URL('../../../skills/cordisx-plugin-development', import.meta.url))
const cordisxSkillDestination = fileURLToPath(new URL('../dist/skills/cordisx-plugin-development', import.meta.url))

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
await mkdir(cliProxyDestination, { recursive: true })
await cp(cliProxySource, cliProxyDestination, {
  recursive: true,
  force: true,
  filter: sourcePath => !sourcePath.endsWith('index.ts'),
})
await mkdir(channelDestination, { recursive: true })
await cp(channelSource, channelDestination, {
  recursive: true,
  force: true,
  filter: sourcePath => !sourcePath.endsWith('index.ts'),
})
// Channel runtime is private workspace infrastructure. Package the compiled
// launcher-only runtime beside the CLI and rewrite its single Node entry import
// so an installed `cordisx` tarball never relies on a workspace symlink.
await mkdir(channelRuntimeDestination, { recursive: true })
await cp(channelRuntimeSource, channelRuntimeDestination, { recursive: true, force: true })
// Mirror the complete maintained Skill into dist so the npm package and CLI
// launcher use the same immutable source tree without publishing source paths.
await rm(cordisxSkillDestination, { recursive: true, force: true })
await mkdir(path.dirname(cordisxSkillDestination), { recursive: true })
await cp(cordisxSkillSource, cordisxSkillDestination, { recursive: true, force: false, errorOnExist: true })
const channelService = await readFile(channelServiceDestination, 'utf8')
await writeFile(
  channelServiceDestination,
  channelService.replace("from '@cordisx/channel-runtime'", "from '../../channel-runtime/index.js'"),
  'utf8',
)
