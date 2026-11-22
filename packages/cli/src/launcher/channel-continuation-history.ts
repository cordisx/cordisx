import { codexTranscriptPage } from './agent-bridge-codex-history.js'
import { continuationTurnHistoryPage, isTurnHistoryCursor } from './channel-continuation-turn-history.js'

/** Preserve the legacy bounded history fallback and redact live Channel capabilities. */
export async function channelContinuationHistory(
  native: Parameters<typeof codexTranscriptPage>[0],
  threadId: string,
  options: { readonly limit?: number; readonly cursor?: unknown },
  tokens: ReadonlySet<string>,
) {
  let page: Awaited<ReturnType<typeof continuationTurnHistoryPage>> | Awaited<ReturnType<typeof codexTranscriptPage>>
  if (isTurnHistoryCursor(options.cursor)) page = await continuationTurnHistoryPage(native, threadId, options)
  else {
    try {
      page = await codexTranscriptPage(native, threadId, options)
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { rpcCode?: unknown }).rpcCode : undefined
      if (options.cursor !== undefined || code !== -32601) throw error
      page = await continuationTurnHistoryPage(native, threadId, options)
    }
  }
  return {
    ...page,
    entries: page.entries.map(entry => ({
      ...entry,
      text: [...tokens].reduce((value, token) => value.replaceAll(token, '[context redacted]'), entry.text),
    })),
  }
}
