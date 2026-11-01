import { fileURLToPath } from 'node:url'

/**
 * Node arguments that start the detached supervisor with the same CLI entry
 * as this process. A packaged build keeps the plain `cli.js` launch; a source
 * checkout run through a loader such as `tsx` needs `cli.ts` and the parent's
 * loader flags, or the child exits before it can report readiness.
 */
export function supervisorEntryArgs(
  moduleUrl: string = import.meta.url,
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const fromSource = new URL(moduleUrl).pathname.endsWith('.ts')
  const entry = fileURLToPath(new URL(fromSource ? '../cli.ts' : '../cli.js', moduleUrl))
  return fromSource ? [...execArgv, entry] : [entry]
}
