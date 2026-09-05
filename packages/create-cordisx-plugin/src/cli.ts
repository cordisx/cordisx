#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

type CreatorMode = 'single' | 'workspace' | 'embedded'
type IntegrationMode = 'auto' | 'workspace' | 'isolated'
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

interface CreatorOptions {
  readonly directory: string
  readonly mode: CreatorMode
  readonly plugins: readonly string[]
  readonly integration: IntegrationMode
  readonly packageManager?: PackageManager
}

interface CreatorManifest { readonly version: string }

interface WorkspaceDetection {
  readonly manager: PackageManager
  readonly kind: 'pnpm-yaml' | 'package-json'
  readonly manifestPath: string
}

const HELP = `Usage:
  npm create cordisx-plugin <directory>
  npx create-cordisx-plugin <directory>
  create-cordisx-plugin --mode workspace <directory> --plugin <id> [--plugin <id> ...]
  create-cordisx-plugin --mode embedded <project> --plugin <id> [options]

Modes:
  single       Create one standalone plugin project (default)
  workspace    Create a dedicated multi-plugin workspace
  embedded     Add one or more plugins under <project>/.cordisx

Options:
  --plugin <id>                 Plugin id; repeat for multiple plugins
  --integration <mode>          embedded mode: auto, workspace, or isolated
  --package-manager <manager>   auto, npm, pnpm, yarn, or bun
  -h, --help                    Show this help

Embedded mode always creates an independent .cordisx package.json and
tsconfig.json. With --integration auto it joins an existing workspace when one
is detected; otherwise it remains an isolated Node project.`

function packageName(directory: string): string {
  const normalized = path.basename(path.resolve(directory))
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 180)
  return normalized === '' ? 'cordisx-plugin' : normalized
}

function derivedPluginId(name: string): string {
  return name === 'host' || name.startsWith('cordisx.') ? `local-${name}` : name
}

function explicitPluginId(value: string): string {
  const id = value.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(id)) throw new Error(`invalid plugin id: ${value}`)
  if (id === 'host' || id.startsWith('cordisx.')) throw new Error(`reserved plugin id: ${id}`)
  return id
}

function optionValue(argv: readonly string[], index: number, name: string): [string, number] {
  const current = argv[index]
  const inline = current?.startsWith(`${name}=`) === true ? current.slice(name.length + 1) : undefined
  if (inline !== undefined) {
    if (inline === '') throw new Error(`${name} requires a value`)
    return [inline, index]
  }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('-')) throw new Error(`${name} requires a value`)
  return [next, index + 1]
}

function choice<T extends string>(value: string, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new Error(`${name} must be one of: ${values.join(', ')}`)
  return value as T
}

function parseArguments(argv: readonly string[]): CreatorOptions | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help'
  let mode: CreatorMode = 'single'
  let integration: IntegrationMode = 'auto'
  let packageManager: PackageManager | undefined
  const plugins: string[] = []
  const positionals: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--mode' || argument.startsWith('--mode=')) {
      const [value, nextIndex] = optionValue(argv, index, '--mode')
      mode = choice(value, ['single', 'workspace', 'embedded'], '--mode')
      index = nextIndex
      continue
    }
    if (argument === '--plugin' || argument.startsWith('--plugin=')) {
      const [value, nextIndex] = optionValue(argv, index, '--plugin')
      plugins.push(explicitPluginId(value))
      index = nextIndex
      continue
    }
    if (argument === '--integration' || argument.startsWith('--integration=')) {
      const [value, nextIndex] = optionValue(argv, index, '--integration')
      integration = choice(value, ['auto', 'workspace', 'isolated'], '--integration')
      index = nextIndex
      continue
    }
    if (argument === '--package-manager' || argument.startsWith('--package-manager=')) {
      const [value, nextIndex] = optionValue(argv, index, '--package-manager')
      if (value !== 'auto') packageManager = choice<PackageManager>(value, ['npm', 'pnpm', 'yarn', 'bun'], '--package-manager')
      index = nextIndex
      continue
    }
    if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}\n\n${HELP}`)
    positionals.push(argument)
  }

  if (positionals.length !== 1) throw new Error(HELP)
  if (mode === 'single' && plugins.length > 0) throw new Error('--plugin is only valid with --mode workspace or --mode embedded')
  if (mode !== 'embedded' && integration !== 'auto') throw new Error('--integration is only valid with --mode embedded')
  if (mode !== 'single' && plugins.length === 0) throw new Error(`${mode} mode requires at least one --plugin <id>`)
  if (new Set(plugins).size !== plugins.length) throw new Error('plugin ids must be unique')
  return {
    directory: positionals[0]!, mode, plugins, integration,
    ...(packageManager === undefined ? {} : { packageManager }),
  }
}

function replaceTokens(value: string, replacements: Readonly<Record<string, string>>): string {
  let output = value
  for (const [token, replacement] of Object.entries(replacements)) output = output.replaceAll(`{{${token}}}`, replacement)
  return output
}

async function pathState(target: string): Promise<'missing' | 'file' | 'empty' | 'nonempty'> {
  try {
    const targetStat = await stat(target)
    if (!targetStat.isDirectory()) return 'file'
    return (await readdir(target)).length === 0 ? 'empty' : 'nonempty'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function renderTemplate(source: string, destination: string, replacements: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const outputName = replaceTokens(entry.name === '_gitignore' ? '.gitignore' : entry.name, replacements)
    const input = path.join(source, entry.name)
    const output = path.join(destination, outputName)
    if (entry.isDirectory()) {
      await renderTemplate(input, output, replacements)
      continue
    }
    if (!entry.isFile()) throw new Error(`unsupported template entry: ${input}`)
    await writeFile(output, replaceTokens(await readFile(input, 'utf8'), replacements), { encoding: 'utf8', flag: 'wx' })
  }
}

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

function commonCompilerOptions(): Record<string, unknown> {
  return {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    jsx: 'react-jsx', jsxImportSource: 'cordisx/react', lib: ['ES2023', 'DOM'],
    strict: true, declaration: true, forceConsistentCasingInFileNames: true, skipLibCheck: true,
  }
}

function pluginConfig(ids: readonly string[]): string {
  return json({
    version: 1,
    plugins: ids.map(id => ({ id, entry: `./plugins/${id}/src/index.tsx`, enabled: true, config: {} })),
  })
}

function manifestTest(ids: readonly string[], modulePath: (id: string) => string): string {
  const imports = ids.map((id, index) => `const plugin${index} = await import('${modulePath(id)}')`).join('\n')
  const cases = ids.map((id, index) => `  ['${id}', plugin${index}],`).join('\n')
  return `import assert from 'node:assert/strict'
import test from 'node:test'

const component = () => null
const noop = () => undefined
const React = new Proxy({ Fragment: Symbol('Fragment'), Suspense: component, lazy: () => component }, {
  get(target, property) { return Reflect.get(target, property) ?? noop },
})
globalThis.__cordisxSharedReactRuntime = {
  React,
  defineReactPage: page => page,
  jsxRuntime: { Fragment: React.Fragment, jsx: component, jsxs: component },
  jsxDevRuntime: { Fragment: React.Fragment, jsxDEV: component },
  ui: new Proxy({}, { get: () => component }),
}

${imports}

const plugins = [
${cases}
]

test('all configured CordisX plugins export matching manifests', () => {
  for (const [id, plugin] of plugins) {
    assert.equal(plugin.manifest.schemaVersion, 1)
    assert.equal(plugin.manifest.id, id)
    assert.equal(typeof plugin.apply, 'function')
  }
})
`
}

function projectBuildScript(configName: string): string {
  return `import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(await readFile(path.join(root, '${configName}'), 'utf8'))
if (config.version !== 1 || !Array.isArray(config.plugins)) throw new Error('CordisX project config must have version 1 and a plugins array')
const ids = new Set()
for (const plugin of config.plugins) {
  if (plugin === null || typeof plugin !== 'object' || typeof plugin.id !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(plugin.id) || ids.has(plugin.id)) {
    throw new Error('CordisX project config contains an invalid or duplicated plugin id')
  }
  ids.add(plugin.id)
  await build({ configFile: path.join(root, 'plugins', plugin.id, 'vite.config.ts') })
}
`
}

async function renderPluginSource(
  templateRoot: string,
  destination: string,
  id: string,
  outDir = 'dist/runtime',
): Promise<void> {
  const replacements = { packageName: id, pluginId: id, sourceEntry: 'src/index.tsx', outDir }
  const source = replaceTokens(
    await readFile(path.join(templateRoot, 'src', '{{packageName}}.tsx'), 'utf8'),
    replacements,
  )
  const page = replaceTokens(
    await readFile(path.join(templateRoot, 'src', 'overview-page.tsx'), 'utf8'),
    replacements,
  )
  const viteConfig = replaceTokens(
    await readFile(path.join(templateRoot, 'vite.config.ts'), 'utf8'),
    replacements,
  )
  await mkdir(path.join(destination, 'src'), { recursive: true })
  await writeFile(path.join(destination, 'src', 'index.tsx'), source, { encoding: 'utf8', flag: 'wx' })
  await writeFile(path.join(destination, 'src', 'overview-page.tsx'), page, { encoding: 'utf8', flag: 'wx' })
  await writeFile(path.join(destination, 'vite.config.ts'), viteConfig, { encoding: 'utf8', flag: 'wx' })
  await writeFile(path.join(destination, 'README.md'), `# ${id}\n\nThe local-development lifecycle entry is \`src/index.tsx\`. React page components live in component-only modules such as \`src/overview-page.tsx\` so Vite can apply React Fast Refresh. Production config calls the public \`cordisx/vite\` helper to write one immutable Vite ESM graph with \`module.js\`, content-addressed chunks, CSS, assets, and formal \`artifact.json\` under \`dist/runtime/\`. Declarations live separately under \`dist/types/\`. A portable package entry points at the adjacent \`dist/runtime/module.js\`; the Host validates and retains the indexed graph.\n\nThis plugin starts private and \`UNLICENSED\`. Its generated source is Marked Template Material under the CordisX Independent Plugin Exception; choose a license before distribution.\n`, { encoding: 'utf8', flag: 'wx' })
  await writeFile(path.join(destination, 'README.zh-Hans.md'), `# ${id}\n\n本地开发的生命周期入口为 \`src/index.tsx\`。React 页面组件位于 \`src/overview-page.tsx\` 等纯组件模块中，因此 Vite 可以应用 React Fast Refresh。生产配置调用公开的 \`cordisx/vite\` helper，在 \`dist/runtime/\` 下生成独立、不可变的 Vite ESM graph，包括 \`module.js\`、带内容摘要的 chunk、CSS、静态资源和正式的 \`artifact.json\`；类型声明单独写入 \`dist/types/\`。可移植 package 的入口指向相邻的 \`dist/runtime/module.js\`；Host 会验证并保留该索引 graph。\n\n此插件默认私有且使用 \`UNLICENSED\`。生成源码属于 CordisX 独立插件例外中的已标记模板材料；分发前请选择许可证。\n`, { encoding: 'utf8', flag: 'wx' })
}

function pluginPackage(workspaceName: string, id: string, cordisxVersion: string): string {
  return json({
    name: `${workspaceName}-${id}`.slice(0, 214), version: '0.1.0', private: true,
    license: 'UNLICENSED', type: 'module', files: ['dist', 'README.md', 'README.zh-Hans.md'],
    main: './dist/runtime/module.js', types: './dist/types/index.d.ts',
    exports: { '.': { types: './dist/types/index.d.ts', import: './dist/runtime/module.js', default: './dist/runtime/module.js' } },
    scripts: {
      build: 'vite build && tsc -p tsconfig.json --emitDeclarationOnly',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    },
    devDependencies: {
      '@deepseek-ai/cordis': '4.0.1', cordisx: cordisxVersion, typescript: '^5.9.2', vite: '8.2.2',
    },
  })
}

function pluginTsconfig(): string {
  return json({
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'dist/types', composite: true },
    include: ['src/**/*.ts', 'src/**/*.tsx'], exclude: ['dist', 'node_modules'],
  })
}

async function createSingle(
  target: string,
  directory: string,
  manager: PackageManager,
  templateRoot: string,
  cordisxVersion: string,
): Promise<void> {
  const state = await pathState(target)
  if (state === 'file') throw new Error(`target exists and is not a directory: ${target}`)
  if (state === 'nonempty') throw new Error(`target directory is not empty: ${target}`)
  let created = false
  try {
    if (state === 'missing') {
      await mkdir(target, { recursive: false })
      created = true
    }
    const name = packageName(directory)
    const id = derivedPluginId(name)
    await renderTemplate(templateRoot, target, {
      packageName: name, pluginId: id, cordisxVersion, packageManager: manager,
      sourceEntry: `src/${id}.tsx`, outDir: 'dist/runtime',
    })
    if (name !== id) await rename(path.join(target, 'src', `${name}.tsx`), path.join(target, 'src', `${id}.tsx`))
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    if (!created) await mkdir(target)
    throw error
  }
}

async function createWorkspace(
  target: string,
  directory: string,
  ids: readonly string[],
  manager: PackageManager,
  templateRoot: string,
  cordisxVersion: string,
): Promise<void> {
  const state = await pathState(target)
  if (state === 'file') throw new Error(`target exists and is not a directory: ${target}`)
  if (state === 'nonempty') throw new Error(`target directory is not empty: ${target}`)
  let created = false
  try {
    if (state === 'missing') {
      await mkdir(target, { recursive: false })
      created = true
    }
    const name = packageName(directory)
    await writeFile(path.join(target, 'package.json'), json({
      name, version: '0.1.0', private: true, license: 'UNLICENSED', type: 'module',
      workspaces: ['plugins/*'],
      scripts: {
        build: 'node scripts/build-plugins.mjs && tsc -b --emitDeclarationOnly --force',
        check: 'tsc -b && node scripts/build-plugins.mjs && tsc -b --emitDeclarationOnly --force && node --test test/plugins.mjs',
        dev: 'cordisx dev --config ./cordisx.config.json',
        'dev:dry-run': 'cordisx dev --config ./cordisx.config.json --dry-run',
        test: 'node --test test/plugins.mjs',
        typecheck: 'tsc -b',
      },
      devDependencies: { cordisx: cordisxVersion, typescript: '^5.9.2', vite: '8.2.2' },
      engines: { node: '>=22.19' },
    }), { encoding: 'utf8', flag: 'wx' })
    await writeFile(path.join(target, 'tsconfig.base.json'), json({ compilerOptions: commonCompilerOptions() }), { encoding: 'utf8', flag: 'wx' })
    await writeFile(path.join(target, 'tsconfig.json'), json({
      files: [], references: ids.map(id => ({ path: `./plugins/${id}` })),
    }), { encoding: 'utf8', flag: 'wx' })
    await writeFile(path.join(target, 'cordisx.config.json'), pluginConfig(ids), { encoding: 'utf8', flag: 'wx' })
    await mkdir(path.join(target, 'scripts'), { recursive: true })
    await writeFile(path.join(target, 'scripts', 'build-plugins.mjs'), projectBuildScript('cordisx.config.json'), { encoding: 'utf8', flag: 'wx' })
    await writeFile(path.join(target, '.gitignore'), 'node_modules/\ndist/\n*.tsbuildinfo\n', { encoding: 'utf8', flag: 'wx' })
    await writeFile(path.join(target, 'README.md'), `# ${name}\n\nA dedicated CordisX multi-plugin workspace. Each plugin builds into its own Vite ESM graph so chunks and assets never couple independently replaceable plugin generations.\n\n\`\`\`bash\n${manager} install\n${manager} run check\n${manager} run dev:dry-run\n${manager} run dev\n\`\`\`\n`, { encoding: 'utf8', flag: 'wx' })
    if (manager === 'pnpm') {
      await writeFile(path.join(target, 'pnpm-workspace.yaml'), "packages:\n  - 'plugins/*'\n", { encoding: 'utf8', flag: 'wx' })
    }
    for (const id of ids) {
      const pluginRoot = path.join(target, 'plugins', id)
      await renderPluginSource(templateRoot, pluginRoot, id)
      await writeFile(path.join(pluginRoot, 'package.json'), pluginPackage(name, id, cordisxVersion), { encoding: 'utf8', flag: 'wx' })
      await writeFile(path.join(pluginRoot, 'tsconfig.json'), pluginTsconfig(), { encoding: 'utf8', flag: 'wx' })
    }
    await mkdir(path.join(target, 'test'), { recursive: true })
    await writeFile(path.join(target, 'test', 'plugins.mjs'), manifestTest(ids, id => `../plugins/${id}/dist/runtime/module.js`), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    if (!created) await mkdir(target)
    throw error
  }
}

function packageManagerFromManifest(contents: string | undefined): PackageManager | undefined {
  if (contents === undefined) return undefined
  const manifest = JSON.parse(contents) as { packageManager?: unknown }
  if (typeof manifest.packageManager !== 'string') return undefined
  const name = manifest.packageManager.split('@')[0]
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : undefined
}

async function detectedPackageManager(projectRoot: string, manifest: string | undefined): Promise<PackageManager> {
  const declared = packageManagerFromManifest(manifest)
  if (declared !== undefined) return declared
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
  ] as const) {
    if (await readOptional(path.join(projectRoot, file)) !== undefined) return manager
  }
  return 'npm'
}

async function detectWorkspace(projectRoot: string): Promise<WorkspaceDetection | undefined> {
  for (const file of ['pnpm-workspace.yaml', 'pnpm-workspace.yml']) {
    const manifestPath = path.join(projectRoot, file)
    if (await readOptional(manifestPath) !== undefined) return { manager: 'pnpm', kind: 'pnpm-yaml', manifestPath }
  }
  const manifestPath = path.join(projectRoot, 'package.json')
  const contents = await readOptional(manifestPath)
  if (contents === undefined) return undefined
  const manifest = JSON.parse(contents) as { workspaces?: unknown }
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces !== null && typeof manifest.workspaces === 'object'
      ? (manifest.workspaces as { packages?: unknown }).packages
      : undefined
  if (!Array.isArray(workspaces)) return undefined
  const manager = await detectedPackageManager(projectRoot, contents)
  // pnpm intentionally ignores package.json#workspaces; only its YAML file is
  // evidence that the project is a pnpm workspace.
  if (manager === 'pnpm') return undefined
  return { manager, kind: 'package-json', manifestPath }
}

function addPnpmWorkspace(contents: string, entry: string): string {
  const normalized = entry.replaceAll('\\', '/')
  const verifyUpdate = (candidate: string): string => {
    const updated = parseDocument(candidate, { prettyErrors: true })
    if (updated.errors.length > 0) {
      throw new Error('cannot safely update pnpm-workspace.yaml: the updated document did not validate')
    }
    const updatedPackages = updated.get('packages', true)
    if (!isSeq(updatedPackages) || !updatedPackages.items.some(item => isScalar(item) && item.value === normalized)) {
      throw new Error('cannot safely update pnpm-workspace.yaml: the updated document did not validate')
    }
    return candidate
  }
  const document = parseDocument(contents, { keepSourceTokens: true, prettyErrors: true })
  if (document.errors.length > 0) {
    throw new Error(`cannot safely update pnpm-workspace.yaml: ${document.errors[0]!.message}`)
  }
  if (!isMap(document.contents)) {
    throw new Error('cannot safely update pnpm-workspace.yaml: the document root must be a mapping')
  }
  const packages = document.get('packages', true)
  if (packages === undefined && !document.contents.has('packages')) {
    const range = document.contents.range
    if (range === null || range === undefined) {
      throw new Error('cannot safely update pnpm-workspace.yaml: the root mapping has no editable source range')
    }
    const newline = contents.includes('\r\n') ? '\r\n' : '\n'
    const insertion = `${contents.slice(0, range[1]).endsWith('\n') ? '' : newline}packages:${newline}  - '${normalized.replaceAll("'", "''")}'${newline}`
    return verifyUpdate(`${contents.slice(0, range[1])}${insertion}${contents.slice(range[1])}`)
  }
  if (!isSeq(packages)) {
    throw new Error('cannot safely update pnpm-workspace.yaml: packages must be a sequence')
  }
  if (packages.anchor !== undefined || packages.tag !== undefined) {
    throw new Error('cannot safely update pnpm-workspace.yaml: anchored or tagged packages sequences are not supported')
  }
  const values = packages.items.map(item => {
    if (!isScalar(item) || typeof item.value !== 'string') {
      throw new Error('cannot safely update pnpm-workspace.yaml: every packages entry must be a string')
    }
    return item.value
  })
  if (values.includes(normalized)) return contents

  const range = packages.range
  if (range === null || range === undefined) {
    throw new Error('cannot safely update pnpm-workspace.yaml: packages has no editable source range')
  }
  const quoted = `'${normalized.replaceAll("'", "''")}'`
  const [start, end] = range
  if (packages.flow === true) {
    const closing = end - 1
    if (contents[closing] !== ']') {
      throw new Error('cannot safely update pnpm-workspace.yaml: packages flow sequence has no closing bracket')
    }
    const inner = contents.slice(start + 1, closing)
    const trailingWhitespace = inner.match(/\s*$/)?.[0] ?? ''
    const body = inner.slice(0, inner.length - trailingWhitespace.length)
    const separator = body.trim() === '' || body.trimEnd().endsWith(',') ? '' : ','
    const spacing = body === '' || /\s$/.test(body) ? '' : ' '
    return verifyUpdate(`${contents.slice(0, start + 1)}${body}${separator}${spacing}${quoted}${trailingWhitespace}${contents.slice(closing)}`)
  }

  const source = contents.slice(start, end)
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const lineStart = contents.lastIndexOf('\n', start - 1) + 1
  const indent = contents.slice(lineStart, start)
  if (!/^\s*$/.test(indent)) {
    throw new Error('cannot safely update pnpm-workspace.yaml: packages sequence indentation is ambiguous')
  }
  const insertion = source.endsWith('\n') ? `${indent}- ${quoted}${newline}` : `${newline}${indent}- ${quoted}`
  return verifyUpdate(`${contents.slice(0, end)}${insertion}${contents.slice(end)}`)
}

function addPackageWorkspace(contents: string, entry: string): string {
  const manifest = JSON.parse(contents) as Record<string, unknown>
  const current = manifest.workspaces
  if (Array.isArray(current)) {
    if (!current.includes(entry)) manifest.workspaces = [...current, entry]
  } else if (current !== null && typeof current === 'object' && Array.isArray((current as { packages?: unknown }).packages)) {
    const packages = (current as { packages: unknown[] }).packages
    if (!packages.includes(entry)) manifest.workspaces = { ...current, packages: [...packages, entry] }
  } else {
    throw new Error('project package.json has an unsupported workspaces declaration')
  }
  return json(manifest)
}

function embeddedPackage(projectName: string, cordisxVersion: string, packageManagerSpec?: string): string {
  return json({
    name: `${projectName}-cordisx-development`.slice(0, 214), private: true,
    license: 'UNLICENSED', type: 'module',
    ...(packageManagerSpec === undefined ? {} : { packageManager: packageManagerSpec }),
    scripts: {
      build: 'node scripts/build-plugins.mjs && tsc -p tsconfig.json --emitDeclarationOnly',
      check: 'tsc -p tsconfig.json --noEmit && node scripts/build-plugins.mjs && tsc -p tsconfig.json --emitDeclarationOnly && node --test test/*.mjs',
      dev: 'cordisx dev --config ./config.json',
      'dev:dry-run': 'cordisx dev --config ./config.json --dry-run',
      test: 'node --test test/*.mjs', typecheck: 'tsc -p tsconfig.json --noEmit',
    },
    devDependencies: {
      '@deepseek-ai/cordis': '4.0.1', cordisx: cordisxVersion, typescript: '^5.9.2', vite: '8.2.2',
    },
    engines: { node: '>=22.19' },
  })
}

function embeddedTsconfig(): string {
  return json({
    compilerOptions: { ...commonCompilerOptions(), rootDir: 'plugins', outDir: 'dist/types' },
    include: ['plugins/**/*.ts', 'plugins/**/*.tsx'], exclude: ['dist', 'node_modules'],
  })
}

function embeddedReadme(manager: PackageManager, integrated: boolean): string {
  const install = integrated
    ? `Run \`${manager} install\` from the containing workspace root.`
    : manager === 'pnpm'
      ? 'Run `pnpm install --ignore-workspace` in this directory.'
      : `Run \`${manager} install\` in this directory.`
  return `# Project CordisX development\n\nThis directory is an independent Node and TypeScript boundary for CordisX plugins embedded in the containing business project. Each configured plugin builds into its own Vite ESM graph under \`dist/runtime/<plugin-id>/\`, while declarations stay in \`dist/types/\`; production chunks and assets do not cross plugin generation boundaries.\n\n${install}\n\nThen run \`${manager} run check\`, \`${manager} run dev:dry-run\`, or \`${manager} run dev\` here.\n`
}

async function existingEmbeddedConfig(file: string): Promise<{ value: Record<string, unknown>, ids: string[] }> {
  const contents = await readOptional(file)
  if (contents === undefined) return { value: { version: 1, plugins: [] }, ids: [] }
  const value = JSON.parse(contents) as Record<string, unknown>
  if (value.version !== 1 || !Array.isArray(value.plugins)) throw new Error(`${file} is not a version-1 CordisX project config`)
  const ids = value.plugins.map((plugin, index) => {
    if (plugin === null || typeof plugin !== 'object' || typeof (plugin as { id?: unknown }).id !== 'string') {
      throw new Error(`${file} plugins[${index}] is invalid`)
    }
    return (plugin as { id: string }).id
  })
  return { value, ids }
}

async function createEmbedded(
  target: string,
  ids: readonly string[],
  requestedIntegration: IntegrationMode,
  requestedManager: PackageManager | undefined,
  templateRoot: string,
  cordisxVersion: string,
): Promise<{ manager: PackageManager, integrated: boolean }> {
  const state = await pathState(target)
  if (state === 'missing') throw new Error(`embedded project does not exist: ${target}`)
  if (state === 'file') throw new Error(`embedded target is not a directory: ${target}`)

  const projectManifest = await readOptional(path.join(target, 'package.json'))
  const workspace = await detectWorkspace(target)
  const integrated = requestedIntegration === 'workspace' || (requestedIntegration === 'auto' && workspace !== undefined)
  if (integrated && workspace === undefined) throw new Error('workspace integration requested, but the project has no supported workspace declaration')
  if (integrated && requestedManager !== undefined && requestedManager !== workspace!.manager) {
    throw new Error(`detected ${workspace!.manager} workspace does not match --package-manager ${requestedManager}`)
  }
  const manager = requestedManager ?? workspace?.manager ?? await detectedPackageManager(target, projectManifest)
  const declaredManagerSpec = projectManifest === undefined
    ? undefined
    : (JSON.parse(projectManifest) as { packageManager?: unknown }).packageManager
  const isolatedManagerSpec = !integrated
    && typeof declaredManagerSpec === 'string'
    && declaredManagerSpec.startsWith(`${manager}@`)
    ? declaredManagerSpec
    : undefined
  const cordisxRoot = path.join(target, '.cordisx')
  const cordisxRootWasMissing = await pathState(cordisxRoot) === 'missing'
  const configPath = path.join(cordisxRoot, 'config.json')
  const existing = await existingEmbeddedConfig(configPath)
  for (const id of ids) {
    if (existing.ids.includes(id)) throw new Error(`plugin already exists in .cordisx/config.json: ${id}`)
    if (await pathState(path.join(cordisxRoot, 'plugins', id)) !== 'missing') throw new Error(`plugin directory already exists: .cordisx/plugins/${id}`)
    if (await readOptional(path.join(cordisxRoot, 'test', `${id}.mjs`)) !== undefined) throw new Error(`plugin test already exists: .cordisx/test/${id}.mjs`)
  }

  const previousFiles = new Map<string, string | undefined>()
  const pluginRoots = ids.map(id => path.join(cordisxRoot, 'plugins', id))
  const remember = async (file: string): Promise<void> => {
    if (!previousFiles.has(file)) previousFiles.set(file, await readOptional(file))
  }
  const put = async (file: string, contents: string, onlyWhenMissing = false): Promise<void> => {
    await remember(file)
    if (onlyWhenMissing && previousFiles.get(file) !== undefined) return
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents, 'utf8')
  }

  try {
    const nextPlugins = [
      ...(existing.value.plugins as unknown[]),
      ...ids.map(id => ({ id, entry: `./plugins/${id}/src/index.tsx`, enabled: true, config: {} })),
    ]
    await put(configPath, json({ ...existing.value, plugins: nextPlugins }))
    await put(
      path.join(cordisxRoot, 'package.json'),
      embeddedPackage(packageName(target), cordisxVersion, isolatedManagerSpec),
      true,
    )
    await put(path.join(cordisxRoot, 'tsconfig.json'), embeddedTsconfig(), true)
    await put(path.join(cordisxRoot, 'scripts', 'build-plugins.mjs'), projectBuildScript('config.json'), true)
    await put(path.join(cordisxRoot, '.gitignore'), 'node_modules/\ndist/\ncache/\n*.tsbuildinfo\n', true)
    await put(path.join(cordisxRoot, 'README.md'), embeddedReadme(manager, integrated), true)
    if (!integrated && manager === 'yarn') await put(path.join(cordisxRoot, 'yarn.lock'), '', true)
    for (const id of ids) await renderPluginSource(templateRoot, path.join(cordisxRoot, 'plugins', id), id, `../../dist/runtime/${id}`)
    for (const id of ids) {
      await put(path.join(cordisxRoot, 'test', `${id}.mjs`), manifestTest(
        [id],
        pluginId => `../dist/runtime/${pluginId}/module.js`,
      ))
    }
    if (integrated) {
      const workspaceEntry = path.relative(target, cordisxRoot).replaceAll('\\', '/') || '.cordisx'
      await remember(workspace!.manifestPath)
      const contents = previousFiles.get(workspace!.manifestPath)!
      await writeFile(workspace!.manifestPath, workspace!.kind === 'pnpm-yaml'
        ? addPnpmWorkspace(contents, workspaceEntry)
        : addPackageWorkspace(contents, workspaceEntry), 'utf8')
    }
  } catch (error) {
    for (const pluginRoot of pluginRoots) await rm(pluginRoot, { recursive: true, force: true })
    for (const [file, previous] of [...previousFiles].reverse()) {
      if (previous === undefined) await rm(file, { force: true })
      else await writeFile(file, previous, 'utf8')
    }
    if (cordisxRootWasMissing) await rm(cordisxRoot, { recursive: true, force: true })
    throw error
  }
  return { manager, integrated }
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArguments(argv)
  if (parsed === 'help') {
    console.log(HELP)
    return
  }
  const target = path.resolve(process.cwd(), parsed.directory)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const templateRoot = path.join(packageRoot, 'template')
  const creatorManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as CreatorManifest
  if (typeof creatorManifest.version !== 'string' || creatorManifest.version.length === 0) throw new Error('create-cordisx-plugin package version is invalid')

  if (parsed.mode === 'single') {
    const manager = parsed.packageManager ?? 'npm'
    await createSingle(target, parsed.directory, manager, templateRoot, creatorManifest.version)
    console.log(`Created CordisX plugin in ${target}`)
    console.log(`\nNext steps:\n  cd ${parsed.directory}\n  ${manager} install\n  ${manager} run check\n  ${manager} run dev:dry-run`)
    return
  }
  if (parsed.mode === 'workspace') {
    const manager = parsed.packageManager ?? 'npm'
    await createWorkspace(target, parsed.directory, parsed.plugins, manager, templateRoot, creatorManifest.version)
    console.log(`Created CordisX plugin workspace in ${target}`)
    console.log(`\nNext steps:\n  cd ${parsed.directory}\n  ${manager} install\n  ${manager} run check\n  ${manager} run dev:dry-run`)
    return
  }
  const result = await createEmbedded(target, parsed.plugins, parsed.integration, parsed.packageManager, templateRoot, creatorManifest.version)
  console.log(`Added CordisX plugin${parsed.plugins.length === 1 ? '' : 's'} to ${path.join(target, '.cordisx')}`)
  console.log(`Environment: ${result.integrated ? `${result.manager} workspace` : `isolated ${result.manager}`}`)
  if (result.integrated) {
    console.log(`\nNext steps:\n  cd ${parsed.directory}\n  ${result.manager} install\n  cd .cordisx\n  ${result.manager} run check\n  ${result.manager} run dev:dry-run`)
  } else {
    const install = result.manager === 'pnpm' ? 'pnpm install --ignore-workspace' : `${result.manager} install`
    console.log(`\nNext steps:\n  cd ${path.join(parsed.directory, '.cordisx')}\n  ${install}\n  ${result.manager} run check\n  ${result.manager} run dev:dry-run`)
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[create-cordisx-plugin] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
