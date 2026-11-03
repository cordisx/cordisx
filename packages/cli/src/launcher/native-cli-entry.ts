import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Tool kernels filter environment variables; the entry must retain its exact signed Node executable. */
export async function createNativeCliEntry(node: string, intermediary: string): Promise<{
  readonly executable: string
  close(): Promise<void>
}> {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'cx-native-cli-'))
  const executable = path.join(directory, 'codex')
  try {
    await writeFile(executable, `#!/bin/sh\nexec ${quote(node)} ${quote(intermediary)} "$@"\n`, { mode: 0o700 })
    await chmod(executable, 0o700)
    return { executable, close: async () => await rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
