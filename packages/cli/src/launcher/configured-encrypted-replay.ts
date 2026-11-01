import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'

export function configuredEncryptedReplay(codexHome: string, route: (url: string) => string) {
  return async (providerId?: string): Promise<Readonly<Record<string, unknown>>> => {
    const filename = path.join(codexHome, 'config.toml')
    try {
      if ((await stat(filename)).size > 4 * 1024 * 1024) throw new Error('Provider configuration unavailable')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const config = parse(await readFile(filename, 'utf8'))
    const selected = providerId ?? config.model_provider
    if (typeof selected !== 'string' || selected === 'openai') return {}
    const providers = config.model_providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {}
    const provider = (providers as Record<string, unknown>)[selected]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return {}
    const definition = provider as Record<string, unknown>
    if (definition.wire_api !== undefined && definition.wire_api !== 'responses') return {}
    if (typeof definition.base_url !== 'string') return {}
    return { [`model_providers.${selected}.base_url`]: route(definition.base_url) }
  }
}
