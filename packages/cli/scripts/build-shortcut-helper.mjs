import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
await build({
  entryPoints: [fileURLToPath(new URL('src/renderer/current-user/shortcut.ts', root))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  globalName: 'CordisXShortcutPresentation',
  outfile: fileURLToPath(new URL('dist/shortcut-presentation.js', root)),
})
if (process.platform === 'darwin') {
  const out = fileURLToPath(new URL('dist/native', root))
  mkdirSync(out, { recursive: true })
  copyFileSync(fileURLToPath(new URL('native/dock-agent.cjs', root)), `${out}/dock-agent.cjs`)
  execFileSync('/usr/bin/swiftc', [
    '-O',
    ...['Images.swift', 'Runner.swift', 'Entry.swift', 'main.swift'].map(name =>
      fileURLToPath(new URL(`native/shortcut-helper/${name}`, root))
    ),
    '-o',
    `${out}/CordisXEntry`,
  ], { stdio: 'inherit' })
  execFileSync('/usr/bin/swiftc', [
    '-O',
    fileURLToPath(new URL('native/app-launcher.swift', root)),
    '-o',
    `${out}/CordisXLauncher`,
  ], { stdio: 'inherit' })
  execFileSync('/usr/bin/swiftc', [
    '-O',
    fileURLToPath(new URL('native/startup-gate.swift', root)),
    '-o',
    `${out}/CordisXStartupGate`,
  ], { stdio: 'inherit' })
}
