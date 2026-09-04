import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(packageRoot, 'dist', 'cli.js')

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'create-cordisx-plugin-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  return root
}

async function run(cwd, ...args) {
  return await execute(process.execPath, [cli, ...args], { cwd })
}

async function text(file) { return await readFile(file, 'utf8') }
async function json(file) { return JSON.parse(await text(file)) }

async function linkRepositoryDependencies(target) {
  const repositoryRoot = path.resolve(packageRoot, '../..')
  await mkdir(path.join(target, 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(path.join(repositoryRoot, 'packages', 'cli'), path.join(target, 'node_modules', 'cordisx'), 'dir')
  await symlink(path.join(repositoryRoot, 'node_modules', 'typescript'), path.join(target, 'node_modules', 'typescript'), 'dir')
  await symlink(
    path.join(repositoryRoot, 'node_modules', '@deepseek-ai', 'cordis'),
    path.join(target, 'node_modules', '@deepseek-ai', 'cordis'),
    'dir',
  )
  return path.join(target, 'node_modules', 'typescript', 'bin', 'tsc')
}

test('the legacy positional invocation still creates one standalone plugin', async t => {
  const root = await fixture(t)
  const result = await run(root, 'my-plugin')
  const target = path.join(root, 'my-plugin')
  const manifest = await json(path.join(target, 'package.json'))

  assert.match(result.stdout, /Created CordisX plugin/)
  assert.equal(manifest.name, 'my-plugin')
  assert.equal(manifest.scripts.dev, 'cordisx dev ./src/my-plugin.tsx')
  assert.doesNotMatch(manifest.scripts.check, /npm run/)
  assert.match(await text(path.join(target, 'src', 'my-plugin.tsx')), /id: 'my-plugin'/)
  assert.match(await text(path.join(target, 'src', 'my-plugin.tsx')), /defineReactPage<Messages>\(OverviewPage\)/)
  assert.match(await text(path.join(target, 'src', 'overview-page.tsx')), /export function OverviewPage/)
  assert.equal(await text(path.join(target, '.gitignore')), 'dist/\nnode_modules/\n')
})

test('the generated component is accepted as a Vite React refresh boundary', async t => {
  const root = await fixture(t)
  await run(root, 'refreshable-plugin')
  const target = await realpath(path.join(root, 'refreshable-plugin'))
  const repositoryRoot = path.resolve(packageRoot, '../..')
  const requireFromCli = createRequire(path.join(repositoryRoot, 'packages', 'cli', 'package.json'))
  const { createServer } = await import(pathToFileURL(requireFromCli.resolve('vite')).href)
  const react = (await import(pathToFileURL(requireFromCli.resolve('@vitejs/plugin-react')).href)).default
  const stub = path.join(target, '.cordisx-refresh-test-stub.js')
  await writeFile(stub, 'export const noop = undefined\n')
  const aliases = ['cordisx/react/jsx-dev-runtime', 'cordisx/react', 'cordisx/ui', 'cordisx/contracts']
    .map(find => ({ find, replacement: stub }))
  const server = await createServer({
    root: target,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: aliases },
    plugins: [react()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })
  t.after(async () => await server.close())

  const transformed = await server.transformRequest('/src/overview-page.tsx')
  assert.match(transformed.code, /\$RefreshReg\$/)
  assert.match(transformed.code, /import\.meta\.hot\.accept/)
  assert.match(transformed.code, /validateRefreshBoundaryAndEnqueueUpdate/)
})

test('workspace mode creates independently addressable plugin packages and one config', async t => {
  const root = await fixture(t)
  await run(root, '--mode', 'workspace', '--package-manager', 'pnpm', '--plugin', 'chatroom', '--plugin=calendar', 'suite')
  const target = path.join(root, 'suite')
  const config = await json(path.join(target, 'cordisx.config.json'))
  const project = await json(path.join(target, 'package.json'))
  const chatroom = await json(path.join(target, 'plugins', 'chatroom', 'package.json'))

  assert.deepEqual(config.plugins.map(plugin => [plugin.id, plugin.entry]), [
    ['chatroom', './plugins/chatroom/src/index.tsx'],
    ['calendar', './plugins/calendar/src/index.tsx'],
  ])
  assert.deepEqual(project.workspaces, ['plugins/*'])
  assert.equal(project.scripts.dev, 'cordisx dev --config ./cordisx.config.json')
  assert.equal(chatroom.main, './dist/index.js')
  assert.match(await text(path.join(target, 'plugins', 'calendar', 'src', 'index.tsx')), /id: 'calendar'/)
  assert.match(await text(path.join(target, 'plugins', 'calendar', 'src', 'overview-page.tsx')), /export function OverviewPage/)
  assert.match(await text(path.join(target, 'pnpm-workspace.yaml')), /plugins\/\*/)
  assert.deepEqual((await json(path.join(target, 'tsconfig.json'))).references, [
    { path: './plugins/chatroom' }, { path: './plugins/calendar' },
  ])

  const tsc = await linkRepositoryDependencies(target)
  await execute(process.execPath, [tsc, '-b'], { cwd: target })
  await execute(process.execPath, ['--test', 'test/plugins.mjs'], { cwd: target })
})

test('embedded isolated mode leaves the business project untouched', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'business')
  await mkdir(path.join(project, 'src'), { recursive: true })
  const businessPackage = '{\n  "name": "business",\n  "scripts": { "start": "node src/index.js" }\n}\n'
  await writeFile(path.join(project, 'package.json'), businessPackage)
  await writeFile(path.join(project, 'src', 'index.js'), 'console.log("business")\n')

  const result = await run(root, '--mode', 'embedded', '--integration', 'isolated', '--plugin', 'assistant', project)
  const cordisx = path.join(project, '.cordisx')
  const config = await json(path.join(cordisx, 'config.json'))

  assert.match(result.stdout, /isolated npm/)
  assert.equal(await text(path.join(project, 'package.json')), businessPackage)
  assert.deepEqual(config.plugins[0], {
    id: 'assistant', entry: './plugins/assistant/src/index.tsx', enabled: true, config: {},
  })
  assert.equal((await json(path.join(cordisx, 'tsconfig.json'))).compilerOptions.rootDir, 'plugins')
  assert.equal((await json(path.join(cordisx, 'package.json'))).private, true)
  assert.match(await text(path.join(cordisx, '.gitignore')), /node_modules\//)
  assert.match(await text(path.join(cordisx, 'plugins', 'assistant', 'src', 'index.tsx')), /id: 'assistant'/)

  const tsc = await linkRepositoryDependencies(cordisx)
  await execute(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: cordisx })
  await execute(process.execPath, ['--test', 'test/assistant.mjs'], { cwd: cordisx })
})

test('embedded auto mode joins pnpm and supports non-destructive incremental plugin additions', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'workspace')
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), '{"name":"workspace","private":true,"packageManager":"pnpm@10.0.0"}\n')
  await writeFile(path.join(project, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\ncatalog:\n  typescript: ^5.9.2\n")

  await run(root, '--mode=embedded', '--plugin=alpha', project)
  const cordisxPackagePath = path.join(project, '.cordisx', 'package.json')
  const customizedPackage = { ...(await json(cordisxPackagePath)), custom: { preserved: true } }
  await writeFile(cordisxPackagePath, `${JSON.stringify(customizedPackage, null, 2)}\n`)
  const configPath = path.join(project, '.cordisx', 'config.json')
  const customizedConfig = { ...(await json(configPath)), custom: { preserved: true } }
  await writeFile(configPath, `${JSON.stringify(customizedConfig, null, 2)}\n`)
  await run(root, '--mode', 'embedded', '--plugin', 'beta', project)

  const workspace = await text(path.join(project, 'pnpm-workspace.yaml'))
  const config = await json(configPath)
  assert.equal(workspace.match(/\.cordisx/g)?.length, 1)
  assert.match(workspace, /catalog:/)
  assert.deepEqual(config.plugins.map(plugin => plugin.id), ['alpha', 'beta'])
  assert.equal(config.plugins[1].entry, './plugins/beta/src/index.tsx')
  assert.deepEqual(config.custom, { preserved: true })
  assert.deepEqual(await json(cordisxPackagePath), customizedPackage)
  assert.match(await text(path.join(project, '.cordisx', 'test', 'alpha.mjs')), /dist\/alpha\/src\/index\.js/)
  assert.match(await text(path.join(project, '.cordisx', 'test', 'beta.mjs')), /dist\/beta\/src\/index\.js/)
})

test('embedded auto mode adds the package to npm-style workspace declarations', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'npm-workspace')
  await mkdir(project)
  await writeFile(path.join(project, 'package-lock.json'), '{}\n')
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'npm-workspace', private: true, workspaces: { packages: ['packages/*'], nohoist: ['legacy'] },
  }, null, 2))

  await run(root, '--mode', 'embedded', '--plugin', 'operations', project)
  const manifest = await json(path.join(project, 'package.json'))
  assert.deepEqual(manifest.workspaces.packages, ['packages/*', '.cordisx'])
  assert.deepEqual(manifest.workspaces.nohoist, ['legacy'])
})

test('package.json workspaces do not masquerade as a pnpm workspace', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'pnpm-without-workspace-yaml')
  await mkdir(project)
  const businessPackage = JSON.stringify({
    name: 'pnpm-project', packageManager: 'pnpm@11.21.0', workspaces: ['packages/*'],
  }, null, 2)
  await writeFile(path.join(project, 'package.json'), businessPackage)

  const result = await run(root, '--mode', 'embedded', '--plugin', 'operations', project)
  assert.match(result.stdout, /Environment: isolated pnpm/)
  assert.equal(await text(path.join(project, 'package.json')), businessPackage)
  await assert.rejects(
    run(root, '--mode', 'embedded', '--integration', 'workspace', '--plugin', 'second', project),
    /no supported workspace declaration/,
  )
})

test('pnpm flow-style workspace lists with quoted keys and comments accept the embedded package', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'pnpm-flow-workspace')
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), '{"name":"pnpm-flow","packageManager":"pnpm@11.21.0"}\n')
  const workspace = "\"packages\": ['packages/*'] # business packages\ncatalog:\n  typescript: ^5.9.2\n"
  await writeFile(path.join(project, 'pnpm-workspace.yaml'), workspace)

  await run(root, '--mode', 'embedded', '--plugin', 'operations', project)
  assert.equal(await text(path.join(project, 'pnpm-workspace.yaml')), "\"packages\": ['packages/*', '.cordisx'] # business packages\ncatalog:\n  typescript: ^5.9.2\n")
  assert.equal((await json(path.join(project, '.cordisx', 'config.json'))).plugins[0].id, 'operations')
})

test('pnpm block workspace lists preserve quoted keys, indentation, and comments', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'pnpm-block-workspace')
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), '{"name":"pnpm-block","packageManager":"pnpm@11.21.0"}\n')
  const workspace = "'packages': # paths owned by the business project\n    - \"packages/*\" # keep this comment\ncatalogMode: strict\n"
  await writeFile(path.join(project, 'pnpm-workspace.yaml'), workspace)

  await run(root, '--mode', 'embedded', '--plugin', 'operations', project)
  assert.equal(await text(path.join(project, 'pnpm-workspace.yaml')), "'packages': # paths owned by the business project\n    - \"packages/*\" # keep this comment\n    - '.cordisx'\ncatalogMode: strict\n")
})

test('pnpm workspace files without packages retain their existing mapping and comments', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'pnpm-catalog-workspace')
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), '{"name":"pnpm-catalog","packageManager":"pnpm@11.21.0"}\n')
  const workspace = "catalog:\n  typescript: ^5.9.2\n# keep the project catalog comment\n"
  await writeFile(path.join(project, 'pnpm-workspace.yaml'), workspace)

  await run(root, '--mode', 'embedded', '--plugin', 'operations', project)
  assert.equal(await text(path.join(project, 'pnpm-workspace.yaml')), "catalog:\n  typescript: ^5.9.2\npackages:\n  - '.cordisx'\n# keep the project catalog comment\n")
})

for (const [name, workspace] of [
  ['invalid syntax', "packages: ['packages/*'\n"],
  ['an anchored packages sequence', "packages: &shared\n  - 'packages/*'\nmirrored: *shared\n"],
]) {
  test(`pnpm workspace integration fails closed for ${name}`, async t => {
    const root = await fixture(t)
    const project = path.join(root, `pnpm-unsafe-${name.replaceAll(' ', '-')}`)
    await mkdir(project)
    await writeFile(path.join(project, 'package.json'), '{"name":"pnpm-unsafe","packageManager":"pnpm@11.21.0"}\n')
    const workspacePath = path.join(project, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, workspace)

    await assert.rejects(
      run(root, '--mode', 'embedded', '--plugin', 'operations', project),
      /cannot safely update pnpm-workspace\.yaml/,
    )
    assert.equal(await text(workspacePath), workspace)
    await assert.rejects(stat(path.join(project, '.cordisx')), error => error?.code === 'ENOENT')
  })
}

for (const manager of ['yarn', 'bun']) {
  test(`embedded auto mode recognizes ${manager} package workspaces`, async t => {
    const root = await fixture(t)
    const project = path.join(root, `${manager}-workspace`)
    await mkdir(project)
    await writeFile(path.join(project, 'package.json'), JSON.stringify({
      name: `${manager}-workspace`,
      private: true,
      packageManager: `${manager}@${manager === 'yarn' ? '4.9.2' : '1.3.11'}`,
      workspaces: ['packages/*'],
    }, null, 2))

    const result = await run(root, '--mode', 'embedded', '--plugin', 'operations', project)
    assert.match(result.stdout, new RegExp(`Environment: ${manager} workspace`))
    assert.deepEqual((await json(path.join(project, 'package.json'))).workspaces, ['packages/*', '.cordisx'])
    assert.match(await text(path.join(project, '.cordisx', 'README.md')), new RegExp(`${manager} install`))
  })
}

for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
  test(`embedded isolated mode records ${manager} commands without joining a parent workspace`, async t => {
    const root = await fixture(t)
    const project = path.join(root, `${manager}-business`)
    await mkdir(project)
    const original = JSON.stringify({ name: `${manager}-business`, workspaces: ['packages/*'] }, null, 2)
    await writeFile(path.join(project, 'package.json'), original)

    const result = await run(root, '--mode', 'embedded', '--integration', 'isolated', '--package-manager', manager, '--plugin', 'local', project)
    assert.match(result.stdout, new RegExp(`Environment: isolated ${manager}`))
    assert.equal(await text(path.join(project, 'package.json')), original)
    const readme = await text(path.join(project, '.cordisx', 'README.md'))
    assert.match(readme, manager === 'pnpm' ? /pnpm install --ignore-workspace/ : new RegExp(`${manager} install`))
    if (manager === 'yarn') assert.equal(await text(path.join(project, '.cordisx', 'yarn.lock')), '')
  })
}

test('isolated Yarn Berry projects retain their package-manager boundary', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'berry-business')
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'berry-business', packageManager: 'yarn@4.9.2',
  }))

  await run(root, '--mode', 'embedded', '--plugin', 'local', project)
  assert.equal((await json(path.join(project, '.cordisx', 'package.json'))).packageManager, 'yarn@4.9.2')
  assert.equal(await text(path.join(project, '.cordisx', 'yarn.lock')), '')
})

test('embedded mode refuses collisions without changing existing files', async t => {
  const root = await fixture(t)
  const project = path.join(root, 'business')
  await mkdir(project)
  await writeFile(path.join(project, 'package.json'), '{"name":"business"}\n')
  await run(root, '--mode', 'embedded', '--integration', 'isolated', '--plugin', 'alpha', project)
  const configPath = path.join(project, '.cordisx', 'config.json')
  const sourcePath = path.join(project, '.cordisx', 'plugins', 'alpha', 'src', 'index.tsx')
  const beforeConfig = await text(configPath)
  await writeFile(sourcePath, '// customized\n')

  await assert.rejects(run(root, '--mode', 'embedded', '--integration', 'isolated', '--plugin', 'alpha', project), /plugin already exists/)
  assert.equal(await text(configPath), beforeConfig)
  assert.equal(await text(sourcePath), '// customized\n')

  const reservedTest = path.join(project, '.cordisx', 'test', 'beta.mjs')
  await writeFile(reservedTest, '// user-owned test\n')
  await assert.rejects(run(root, '--mode', 'embedded', '--integration', 'isolated', '--plugin', 'beta', project), /plugin test already exists/)
  assert.equal(await text(configPath), beforeConfig)
  assert.equal(await text(reservedTest), '// user-owned test\n')
})
