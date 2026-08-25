import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startUiPlayground } from './server.js'

function value(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option)
  if (index < 0) return undefined
  const result = args[index + 1]
  if (result === undefined || result.startsWith('-')) throw new Error(`${option} requires a value`)
  return result
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run dev:ui -- [--config cordisx.config.json] [--port 43124]')
  process.exit(0)
}
const rawPort = value(args, '--port')
const port = rawPort === undefined ? undefined : Number(rawPort)
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port must be an integer from 0 to 65535')
const defaultConfig = fileURLToPath(new URL('../../../../cordisx.config.example.json', import.meta.url))
const configPath = path.resolve(value(args, '--config') ?? defaultConfig)
const playground = await startUiPlayground({ configPath, ...(port === undefined ? {} : { port }) })
console.log(`[cordisx] UI Playground: ${playground.url}`)
console.log(`[cordisx] isolated CORDISX_HOME: ${playground.homeDir}`)
const stop = async () => { await playground.close(); process.exit(0) }
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
