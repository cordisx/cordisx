import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const destinationDirectory = fileURLToPath(new URL('../dist/', import.meta.url))

await mkdir(destinationDirectory, { recursive: true })
for (const file of ['README.md', 'README.zh-Hans.md']) {
  const source = fileURLToPath(new URL(`../${file}`, import.meta.url))
  const destination = fileURLToPath(new URL(`../dist/${file}`, import.meta.url))
  await copyFile(source, destination)
}
