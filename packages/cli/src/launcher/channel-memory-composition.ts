import path from 'node:path'
import { ChannelMemoryStore } from './channel-memory-store.js'
import { ChannelMemoryAuthority } from './channel-memory-authority.js'
import { ChannelMemoryPersonas } from './channel-memory-personas.js'

export function createChannelMemory(file: string) {
  const directory = path.dirname(file)
  return {
    memory: new ChannelMemoryStore(path.join(directory, 'memory')),
    memoryAuthority: new ChannelMemoryAuthority(path.join(directory, 'memory-authority')),
    personas: new ChannelMemoryPersonas(path.join(directory, 'personas')),
  }
}
