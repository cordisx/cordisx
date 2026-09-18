import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

export interface CordisXManagementConfirmationRuntime {
  readonly stdin?: Readable & { readonly isTTY?: boolean }
  readonly stderr?: Writable
  readonly confirm?: (prompt: string) => boolean | Promise<boolean>
}

export async function confirmManagementMutation(
  prompt: string,
  runtime: CordisXManagementConfirmationRuntime,
): Promise<boolean> {
  if (runtime.confirm !== undefined) return await runtime.confirm(prompt)
  const input = runtime.stdin ?? process.stdin
  const output = runtime.stderr ?? process.stderr
  if (input.isTTY !== true) {
    throw new Error('management confirmation requires an interactive terminal; use --yes to confirm the change')
  }
  const reader = createInterface({ input, output })
  try {
    const answer = (await reader.question(`${prompt} [y/N] `)).trim().toLocaleLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    reader.close()
  }
}
