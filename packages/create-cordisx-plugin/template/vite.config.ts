import { fileURLToPath } from 'node:url'
import { cordisXPluginViteConfig } from 'cordisx/vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

const config: ReturnType<typeof cordisXPluginViteConfig> = cordisXPluginViteConfig({
  root: projectRoot,
  entry: fileURLToPath(new URL('./{{sourceEntry}}', import.meta.url)),
  outDir: fileURLToPath(new URL('./{{outDir}}', import.meta.url)),
  entryFileName: 'module.js',
})

export default config
