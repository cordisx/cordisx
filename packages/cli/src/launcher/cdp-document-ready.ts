import { setTimeout as delay } from 'node:timers/promises'

interface DocumentSession {
  send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
}

/** Do not interrupt Electron's initial loadURL promise with our bootstrap reload. */
export async function waitForInitialDocument(
  session: DocumentSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const response = await session.send('Runtime.evaluate', {
      expression: 'document.readyState === "complete" && location.href !== "about:blank"',
      returnByValue: true,
    }, Math.max(1, deadline - Date.now()))
    if ((response.result as { value?: unknown } | undefined)?.value === true) return
    await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal })
  }
  throw new Error('Initial Host document did not finish loading before bootstrap reload')
}
