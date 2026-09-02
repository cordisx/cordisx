import path from 'node:path'
import { defaultUiPlaygroundConfig } from './defaults.js'
import { startVitePlayground } from './vite/server.js'

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
  console.log('Default fixture: cordisx.config.playground.json (Comprehensive UI demos).')
  console.log('Use --config to load another real local plugin composition.')
  console.log('Set CORDISX_PLAYGROUND_HOME to reuse one explicit external isolated Playground home.')
  process.exit(0)
}
const rawPort = value(args, '--port')
const port = rawPort === undefined ? undefined : Number(rawPort)
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port must be an integer from 0 to 65535')
const configPath = path.resolve(value(args, '--config') ?? defaultUiPlaygroundConfig)
const externalHome = process.env.CORDISX_PLAYGROUND_HOME
const playground = await startVitePlayground({
  configPath,
  ...(externalHome === undefined ? {} : { homeDir: externalHome }),
  ...(port === undefined ? {} : { port }),
})
console.log(`[cordisx] UI Playground: ${playground.url}`)
console.log(`[cordisx] isolated CORDISX_HOME: ${playground.homeDir}`)
const stop = async () => { await playground.close(); process.exit(0) }
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
