import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'

/** A native tool can filter launcher env; resolve only its own packaged App installation. */
export function nativeCliPath(environment = process.env, nodeExecutable = process.execPath) {
  const configured = environment.CORDISX_NATIVE_REAL_CODEX_PATH
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) throw new Error('Native CLI path is not configured')
    return configured
  }
  const node = realpathSync(nodeExecutable)
  const suffix = `${path.sep}cua_node${path.sep}bin${path.sep}node`
  if (!node.endsWith(suffix)) throw new Error('Native CLI path is not configured')
  const resources = node.slice(0, -suffix.length)
  if (!resources.endsWith(`${path.sep}Contents${path.sep}Resources`)) {
    throw new Error('Native CLI path is not configured')
  }
  const executable = path.join(resources, 'codex-cli', 'bin', 'codex')
  accessSync(executable, constants.X_OK)
  if (!realpathSync(executable).startsWith(resources + path.sep)) {
    throw new Error('Native CLI left its App installation')
  }
  return executable
}
