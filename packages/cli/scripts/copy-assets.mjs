import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../assets', import.meta.url))
const destination = fileURLToPath(new URL('../dist/assets', import.meta.url))
const cliProxyReadmeSource = fileURLToPath(new URL('../src/plugins/cli-proxy-api/README.md', import.meta.url))
const cliProxyReadmeDestination = fileURLToPath(new URL('../dist/src/plugins/cli-proxy-api/README.md', import.meta.url))

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true, force: true })
await mkdir(path.dirname(cliProxyReadmeDestination), { recursive: true })
await cp(cliProxyReadmeSource, cliProxyReadmeDestination, { force: true })
