import { chmod, readdir } from 'node:fs/promises'
import path from 'node:path'

export async function makeDirectoriesWritable(directory) {
  const entries = await chmod(directory, 0o700)
    .then(() => readdir(directory, { withFileTypes: true }))
    .catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  await Promise.all(
    entries.filter(entry => entry.isDirectory()).map(entry =>
      makeDirectoriesWritable(path.join(directory, entry.name))
    ),
  )
}
