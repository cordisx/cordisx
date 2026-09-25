import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildNativeHelperArtifact, copyNativeResources } from './native-helper-artifact.mjs'
const root = new URL('../', import.meta.url)
await build({
  entryPoints: [fileURLToPath(new URL('src/renderer/current-user/shortcut.ts', root))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  globalName: 'CordisXShortcutPresentation',
  outfile: fileURLToPath(new URL('dist/shortcut-presentation.js', root)),
})
const sourceRoot = fileURLToPath(root)
const nativeOutput = fileURLToPath(new URL('dist/native', root))
copyNativeResources(sourceRoot, nativeOutput)
if (process.platform === 'darwin') {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  buildNativeHelperArtifact(sourceRoot, nativeOutput, sourceCommit)
}
