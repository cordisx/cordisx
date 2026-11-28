import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { c as createTar } from 'tar'

/** A real configured archive whose plugin contributes one existing Manager page. */
export async function configuredManagerPlugin(
  root: string,
  id = 'configured-demo',
  options: { invalidPage?: boolean; configSchema?: boolean } = {},
) {
  const directory = path.join(root, `${id}-package`)
  await mkdir(directory)
  const runtimeSchema =
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v16.schema.json'
  const runtime = JSON.stringify({ $schema: runtimeSchema, schemaVersion: 16, id, capabilities: [], services: [] })
  const source = `https://example.test/${id}`
  const descriptor = {
    $schema: runtimeSchema.replace('plugin-manifest', 'plugin-package'),
    schemaVersion: 16,
    id,
    version: '1.0.0',
    canonicalSource: source,
    entry: './index.mjs',
    dependencies: [],
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [runtimeSchema] },
    runtimeManifest: {
      path: './runtime.json',
      schema: runtimeSchema,
      digest: `sha256:${createHash('sha256').update(runtime).digest('hex')}`,
    },
  }
  const configSchema = options.configSchema
    ? [
      "const descriptor = { type: 'object', dict: { label: { type: 'string' },",
      "  token: { type: 'string', meta: { role: 'secret' } } } }",
      "export const Config = { ...descriptor, '~standard': { version: 1, vendor: 'schemastery',",
      '  validate: value => ({ value }) }, toJSON: () => descriptor }',
      "export const configApplies = 'live'",
    ].join('\n')
    : ''
  const module = `
export const name = ${JSON.stringify(id)};
export const inject = ['slots', 'pages', 'routes'];
${configSchema}
export function apply(ctx, config) {
  const title = { key: 'fixture.title', fallback: 'Configured fixture' };
  ctx.pages.register({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v3.schema.json',
    schemaVersion: 3, id: 'page', title,
    ${
    options.invalidPage ? '' : "description: { key: 'fixture.page.description', fallback: 'Configured fixture page' },"
  }
    icon: 'host:settings', chrome: 'standard'
  }, ({ container }) => {
    container.textContent = ${
    options.configSchema ? "'Configured fixture page: ' + config.label" : "'Configured fixture page'"
  };
    return () => { container.textContent = ''; };
  });
  ctx.routes.register({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v2.schema.json',
    schemaVersion: 2, id: 'page', path: '/manager/extensions/${id}', outlet: 'manager.content', page: 'page', title,
    description: { key: 'fixture.route.description', fallback: 'Open the configured fixture' }
  });
  ctx.slots.register({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v11.schema.json',
    schemaVersion: 11, name: 'manager.settings.navigation-items', id: 'navigation', group: 'after-settings', order: 160
  },
    { route: { id: 'page' } });
}
`
  await Promise.all([
    writeFile(path.join(directory, 'package.json'), '{"type":"module"}'),
    writeFile(path.join(directory, 'index.mjs'), module),
    writeFile(path.join(directory, 'runtime.json'), runtime),
    writeFile(path.join(directory, 'cordisx-package.json'), JSON.stringify(descriptor)),
  ])
  const archive = path.join(root, `${id}.tgz`)
  await createTar({ cwd: directory, file: archive, gzip: true }, [
    'package.json',
    'index.mjs',
    'runtime.json',
    'cordisx-package.json',
  ])
  return { archive, source }
}
