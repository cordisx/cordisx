import type { GameUiBundleV1 } from '@cordisx/protocol/isolated-game-ui/v1'
import { gameUiBootstrap } from './sdk.js'
const encoder = new TextEncoder()
export async function htmlDocument(value: GameUiBundleV1, token: string): Promise<string> {
  if (!value || value.format !== 'html-v1' || value.bridgeVersion !== 1 || !value.assets) throw Error('invalid-bundle')
  if (Object.keys(value).some(key => !['format', 'bridgeVersion', 'entry', 'assets'].includes(key))) {
    throw Error('invalid-bundle')
  }
  const assets = Object.entries(value.assets)
  if (!assets.length || assets.length > 32) throw Error('invalid-bundle')
  let total = 0
  const urls = new Map<string, string>()
  for (const [path, asset] of assets) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/.test(path)) throw Error('invalid-bundle')
    if (!asset || Object.keys(asset).some(k => !['mediaType', 'content', 'sha256'].includes(k))) {
      throw Error('invalid-bundle')
    }
    if (
      !['text/html', 'text/css', 'text/javascript', 'image/svg+xml'].includes(asset.mediaType)
      || typeof asset.content !== 'string'
    ) throw Error('invalid-bundle')
    const bytes = encoder.encode(asset.content)
    total += bytes.length
    if (bytes.length > 262144 || total > 1048576) throw Error('invalid-bundle')
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x =>
      x.toString(16).padStart(2, '0')
    ).join('')
    if (hash !== asset.sha256) throw Error('invalid-bundle')
    urls.set(path, `data:${asset.mediaType};base64,${btoa(Array.from(bytes, x => String.fromCharCode(x)).join(''))}`)
  }
  if (value.assets[value.entry]?.mediaType !== 'text/html') throw Error('invalid-bundle')
  // No author HTML is parsed in the privileged document. Resource bytes remain inside the child.
  const entry = value.assets[value.entry]!.content.replace(/game-asset:([a-zA-Z0-9_/.\-]+)/g, (_, path: string) => {
    if (!urls.has(path)) throw Error('invalid-bundle')
    return urls.get(path)!
  })
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><script>(${gameUiBootstrap.toString()})(${
    JSON.stringify(token)
  })</script>${entry}`
}
