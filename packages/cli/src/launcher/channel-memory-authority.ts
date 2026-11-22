import type { MemoryAccount, MemoryConversation } from './channel-memory-policy.js'
import { memoryKey } from './channel-memory-policy.js'
import { MemoryFiles } from './channel-memory-files.js'

interface AuthorityState {
  schemaVersion: 1
  revision: number
  administrators: Record<string, string[]>
}
export class ChannelMemoryAuthority {
  private readonly files: MemoryFiles
  constructor(root: string) {
    this.files = new MemoryFiles(root)
  }
  private async state(): Promise<AuthorityState> {
    try {
      const state = await this.files.read('state.json') as AuthorityState
      if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !state.administrators) {
        throw new Error('MEMORY_AUTHORITY_INVALID')
      }
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, revision: 0, administrators: {} }
    }
  }
  async configure(account: MemoryAccount, scopes: MemoryConversation[], expectedRevision: number): Promise<number> {
    return this.files.locked(async () => {
      const state = await this.state()
      if (state.revision !== expectedRevision) throw new Error('MEMORY_REVISION_CONFLICT')
      state.administrators[memoryKey(account)] = scopes.map(scope =>
        memoryKey({
          adapterId: scope.adapterId,
          accountId: scope.accountId,
          tenantId: scope.tenantId,
          conversationId: scope.conversationId,
        })
      )
      state.revision += 1
      await this.files.write('state.json', state)
      return state.revision
    })
  }
  async scopes(account: MemoryAccount): Promise<string[]> {
    await this.files.prepare()
    return (await this.state()).administrators[memoryKey(account)] ?? []
  }
}
