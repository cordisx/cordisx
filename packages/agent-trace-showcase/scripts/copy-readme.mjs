import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../README.md', import.meta.url))
const destinationDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
const destination = fileURLToPath(new URL('../dist/README.md', import.meta.url))

await mkdir(destinationDirectory, { recursive: true })
await copyFile(source, destination)
