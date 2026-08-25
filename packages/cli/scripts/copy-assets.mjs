import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../assets', import.meta.url))
const destination = fileURLToPath(new URL('../dist/assets', import.meta.url))
const cliProxyReadmeSource = fileURLToPath(new URL('../src/plugins/cli-proxy-api/README.md', import.meta.url))
const cliProxyReadmeDestination = fileURLToPath(new URL('../dist/src/plugins/cli-proxy-api/README.md', import.meta.url))
const channelSource = fileURLToPath(new URL('../src/plugins/channel', import.meta.url))
const channelDestination = fileURLToPath(new URL('../dist/src/plugins/channel', import.meta.url))
const channelRuntimeSource = fileURLToPath(new URL('../../channel-runtime/dist', import.meta.url))
const channelRuntimeDestination = fileURLToPath(new URL('../dist/channel-runtime', import.meta.url))
const channelServiceDestination = fileURLToPath(new URL('../dist/src/launcher/channel-service.js', import.meta.url))

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
await mkdir(path.dirname(cliProxyReadmeDestination), { recursive: true })
await cp(cliProxyReadmeSource, cliProxyReadmeDestination, { force: true })
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
const channelService = await readFile(channelServiceDestination, 'utf8')
await writeFile(
  channelServiceDestination,
  channelService.replace("from '@cordisx/channel-runtime'", "from '../../channel-runtime/index.js'"),
  'utf8',
)
