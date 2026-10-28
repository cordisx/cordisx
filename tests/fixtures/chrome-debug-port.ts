import type { ChildProcess } from 'node:child_process'

/** Chrome creates DevToolsActivePort before its contents are necessarily complete. */
export async function waitForChromeDebugPort(
  process: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  readActivePort: () => Promise<string>,
  diagnostics: () => string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(
        `Chrome exited before CDP was ready (code=${process.exitCode}, signal=${process.signalCode}): ${diagnostics()}`,
      )
    }
    let contents: string | undefined
    try {
      contents = await readActivePort()
    } catch {
      // Chrome has not created its launch-owned port file yet.
    }
    if (contents !== undefined) {
      const [line, browserPath] = contents.split('\n')
      const port = Number(line)
      if (
        /^\d+$/u.test(line ?? '') && Number.isInteger(port) && port > 0 && port <= 65535
        && browserPath?.startsWith('/devtools/browser/')
      ) return port
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Chrome CDP port was not ready within ${timeoutMs}ms: ${diagnostics()}`)
}
