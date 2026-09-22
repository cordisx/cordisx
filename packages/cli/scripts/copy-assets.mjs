import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../assets', import.meta.url))
const destination = fileURLToPath(new URL('../dist/assets', import.meta.url))
const channelRuntimeSource = fileURLToPath(new URL('../../channel-runtime/dist', import.meta.url))
const channelRuntimeDestination = fileURLToPath(new URL('../dist/channel-runtime', import.meta.url))
const channelServiceDestination = fileURLToPath(new URL('../dist/src/launcher/channel-service.js', import.meta.url))
const cordisxSkillsSource = fileURLToPath(new URL('../../../skills', import.meta.url))
const cordisxSkillsDestination = fileURLToPath(new URL('../dist/skills', import.meta.url))
const bundledSkillNames = ['cordisx', 'cordisx-docs', 'cordisx-qa', 'cordisx-plugin-development', 'cordisx-feedback']
const preservedRendererStyles = [
  'renderer/host-ui/public-markdown-editor.css',
  'renderer/model-providers.css',
  'renderer/manager/pages/model-services.css',
  'renderer/manager/pages/model-catalog/model-catalog.css',
]

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
// TypeScript preserves CSS imports used by the installed renderer graph. Keep
// each stylesheet beside its compiled module so Vite can resolve that graph.
for (const relative of preservedRendererStyles) {
  const styleSource = fileURLToPath(new URL(`../src/${relative}`, import.meta.url))
  const styleDestination = fileURLToPath(new URL(`../dist/src/${relative}`, import.meta.url))
  await mkdir(path.dirname(styleDestination), { recursive: true })
  await copyFile(styleSource, styleDestination)
}
// Channel runtime is private workspace infrastructure. Package the compiled
// launcher-only runtime beside the CLI and rewrite its single Node entry import
// so an installed `cordisx` tarball never relies on a workspace symlink.
await mkdir(channelRuntimeDestination, { recursive: true })
await cp(channelRuntimeSource, channelRuntimeDestination, { recursive: true, force: true })
// Mirror every release-owned Skill into dist so the npm package and CLI
// launcher use the same immutable source trees without publishing source paths.
await rm(cordisxSkillsDestination, { recursive: true, force: true })
await mkdir(cordisxSkillsDestination, { recursive: true })
for (const skillName of bundledSkillNames) {
  await cp(
    path.join(cordisxSkillsSource, skillName),
    path.join(cordisxSkillsDestination, skillName),
    { recursive: true, force: false, errorOnExist: true },
  )
}
const channelService = await readFile(channelServiceDestination, 'utf8')
await writeFile(
  channelServiceDestination,
  channelService.replace("from '@cordisx/channel-runtime'", "from '../../channel-runtime/index.js'"),
  'utf8',
)

// npm bin linking can chmod an old output; fresh tsc output must pack identically.
await chmod(fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 0o755)

const notificationStyles = '../src/renderer/notifications/styles.css'
const notificationDestination = new URL('../dist/src/renderer/notifications/styles.css', import.meta.url)
await mkdir(path.dirname(fileURLToPath(notificationDestination)), { recursive: true })
await copyFile(new URL(notificationStyles, import.meta.url), notificationDestination)

const dialogDestination = new URL('../dist/src/renderer/dialogs/styles.css', import.meta.url)
await mkdir(new URL('.', dialogDestination), { recursive: true })
await copyFile(new URL('../src/renderer/dialogs/styles.css', import.meta.url), dialogDestination)
