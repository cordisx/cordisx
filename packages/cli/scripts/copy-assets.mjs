import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyEmptyStateAssets } from './empty-state-assets.mjs'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../assets', import.meta.url))
const destination = fileURLToPath(new URL('../dist/assets', import.meta.url))
const channelRuntimeSource = fileURLToPath(new URL('../../channel-runtime/dist', import.meta.url))
const channelRuntimeDestination = fileURLToPath(new URL('../dist/channel-runtime', import.meta.url))
const cordisxSkillsSource = fileURLToPath(new URL('../../../skills', import.meta.url))
const cordisxSkillsDestination = fileURLToPath(new URL('../dist/skills', import.meta.url))
const bundledSkillNames = ['cordisx', 'cordisx-docs', 'cordisx-qa', 'cordisx-plugin-development', 'cordisx-feedback']
const preservedRendererStyles = [
  'renderer/host-ui/public-markdown-editor.css',
  'renderer/host-ui/search.css',
  'renderer/host-ui/empty-state.css',
  'renderer/host-ui/empty-state-illustration-theme.css',
  'renderer/host-ui/action-group.css',
  'renderer/host-ui/account-identity.css',
  'renderer/model-providers.css',
  'renderer/page-header-actions.css',
  'renderer/native-logical-continuation-dialog.css',
  'renderer/manager/manager-navigation.css',
  'renderer/manager/manager-content.css',
  'renderer/manager/manager-record-summary.css',
  'renderer/manager/manager-catalog.css',
  'renderer/manager/manager-details.css',
  'renderer/manager/manager-marketplace.css',
  'renderer/manager/manager-markdown.css',
  'renderer/manager/manager-plugin-details.css',
  'renderer/manager/manager-about.css',
  'renderer/manager/manager-collection.css',
  'renderer/manager/manager-compact-shell.css',
  'renderer/manager/manager-standalone.css',
  'renderer/manager/manager-browse.css',
  'renderer/manager/pages/model-services.css',
  'renderer/manager/pages/model-catalog/model-catalog.css',
]

verifyEmptyStateAssets(source)
await mkdir(destination, { recursive: true })
await mkdir(fileURLToPath(new URL('../dist/src/launcher', import.meta.url)), { recursive: true })
await cp(source, destination, { recursive: true, force: true })
verifyEmptyStateAssets(destination)
// TypeScript preserves CSS imports used by the installed renderer graph. Keep
// each stylesheet beside its compiled module so Vite can resolve that graph.
for (const relative of preservedRendererStyles) {
  const styleSource = fileURLToPath(new URL(`../src/${relative}`, import.meta.url))
  const styleDestination = fileURLToPath(new URL(`../dist/src/${relative}`, import.meta.url))
  await mkdir(path.dirname(styleDestination), { recursive: true })
  await copyFile(styleSource, styleDestination)
}
// Channel runtime is private workspace infrastructure. Package the compiled
// launcher-only runtime beside the CLI and rewrite its compiled consumers
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

// npm bin linking can chmod an old output; fresh tsc output must pack identically.
await chmod(fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 0o755)

const notificationStyles = '../src/renderer/notifications/styles.css'
const notificationDestination = new URL('../dist/src/renderer/notifications/styles.css', import.meta.url)
await mkdir(path.dirname(fileURLToPath(notificationDestination)), { recursive: true })
await copyFile(new URL(notificationStyles, import.meta.url), notificationDestination)

const dialogDestination = new URL('../dist/src/renderer/dialogs/styles.css', import.meta.url)
await mkdir(new URL('.', dialogDestination), { recursive: true })
await copyFile(new URL('../src/renderer/dialogs/styles.css', import.meta.url), dialogDestination)

// The adapter workspace releases independently; Host retains this exact built baseline offline.
const adapterDestination = fileURLToPath(new URL('../dist/codex-adapter', import.meta.url))
await rm(adapterDestination, { recursive: true, force: true })
await cp(new URL('../../codex-adapter/dist', import.meta.url), adapterDestination, { recursive: true })
async function bindBuiltinModules(directory) {
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await bindBuiltinModules(file)
    else if (/\.(?:js|ts)$/u.test(entry.name)) {
      const source = await readFile(file, 'utf8')
      const target = path.relative(path.dirname(file), adapterDestination).split(path.sep).join('/')
      const channelTarget = path.relative(path.dirname(file), channelRuntimeDestination).split(path.sep).join('/')
      await writeFile(
        file,
        source.replace(
          /(['"])@cordisx\/channel-runtime\1/gu,
          (_all, quote) =>
            `${quote}${channelTarget.startsWith('.') ? channelTarget : `./${channelTarget}`}/index.js${quote}`,
        )
          .replace(
            /(['"])@cordisx\/codex-adapter(?:\/([^'"]+))?\1/gu,
            (_all, quote) => `${quote}${target.startsWith('.') ? target : `./${target}`}/adapter.mjs${quote}`,
          ),
      )
    }
  }
}
await bindBuiltinModules(fileURLToPath(new URL('../dist/src', import.meta.url)))
