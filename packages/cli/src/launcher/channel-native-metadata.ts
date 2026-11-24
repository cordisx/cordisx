import { codexThreadMetadata } from './agent-bridge-codex-history.js'
type Reader = Parameters<typeof codexThreadMetadata>[0]

export async function channelNativeLabel(reader: Reader, sessionId: string) {
  const metadata = await codexThreadMetadata(reader, sessionId)
  return typeof metadata?.name === 'string' ? metadata.name : 'Codex 对话'
}
export async function channelNativeExists(reader: Reader, sessionId: string): Promise<boolean> {
  try {
    return (await codexThreadMetadata(reader, sessionId))?.id === sessionId
  } catch {
    return false
  }
}
