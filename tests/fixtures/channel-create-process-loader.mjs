import { realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// This preload is used only by the isolated production-composition test. It
// substitutes credential validation and transport while keeping the packaged
// service owner, Manager, credential journal, and adapter lifecycle intact.
const root = realpathSync(process.env.CORDISX_CHANNEL_CREATE_FIXTURE_ROOT ?? '')
if (
  !/^\/(?:private\/)?tmp\/cx-production-channel-[A-Za-z0-9]+$/u.test(root)
  || realpathSync(process.env.CORDISX_HOME ?? '') !== path.join(root, 'h')
) throw new Error('Invalid isolated Channel fixture home')
const pkg = realpathSync(process.env.CORDISX_CHANNEL_CREATE_PACKAGE ?? '')
const moduleUrl = file => pathToFileURL(path.join(pkg, 'dist', 'src', file)).href
const composition = moduleUrl('cli/manager-channel-credentials-composition.js')
const adapter = moduleUrl('launcher/feishu-adapter.js')
const bundledChannel = moduleUrl('launcher/configured-bundled-channel.js')
const transport = new URL('./channel-create-process-transport.mjs', import.meta.url).href

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Channel fixture seam changed')
  return source.replace(before, after)
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (
      url !== composition && url !== adapter
      && !(url === bundledChannel && process.env.CORDISX_CHANNEL_CREATE_MISSING_BUNDLE === '1')
    ) return loaded
    let source = Buffer.from(loaded.source).toString('utf8')
    if (url === bundledChannel) {
      source = replaceOnce(
        source,
        "readFile(path.join(parent, 'channel-archive.json'))",
        'Promise.reject(new Error("synthetic missing Channel archive"))',
      )
    } else if (url === composition) {
      source = replaceOnce(
        source,
        'new LauncherSecretStore({ homeDir })',
        'new LauncherSecretStore({ homeDir, platform: "linux" })',
      )
      source = replaceOnce(
        source,
        'return new ManagerChannelCredentials({',
        `return new ManagerChannelCredentials({
        validateCredentials: async ({ adapterId, accountId, secret }) => {
          if (adapterId !== "feishu" || accountId !== "cli_created_fixture" || secret !== "synthetic-create-secret") {
            throw new Error("CREDENTIAL_VALIDATION_FAILED");
          }
        },
        discoverTenant: async ({ adapterId, accountId, secret }) => {
          if (adapterId !== "feishu" || ![
            ["cli_created_fixture", "synthetic-create-secret"],
            ["cli_pending_fixture", "synthetic-pending-secret"],
          ].some(([account, value]) => account === accountId && value === secret)) {
            throw new Error("TENANT_DISCOVERY_FAILED");
          }
          if (process.env.CORDISX_CHANNEL_CREATE_DISCOVER_TENANT === "match") return "fixture-tenant";
          throw new Error("TENANT_DISCOVERY_FAILED");
        },`,
      )
    } else {
      source = `import { createSyntheticChannel } from ${JSON.stringify(transport)};\n` + replaceOnce(
        source,
        '.map(connection => createFeishuAdapterDefinition({',
        '.map(connection => createFeishuAdapterDefinition({ createChannel: createSyntheticChannel,',
      )
    }
    return { ...loaded, source }
  },
})
