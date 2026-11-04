import { CursorRepository } from './cursor-repository.js'
import { InboxSqliteProvider } from './provider.js'
import { InboxRepository } from './repository.js'

/** Facade shared by channel pollers; it never starts an Agent or sends a reply. */
export class DurableInbox {
  readonly cursors: CursorRepository
  readonly events: InboxRepository

  private constructor(private readonly provider: InboxSqliteProvider) {
    this.cursors = new CursorRepository(provider)
    this.events = new InboxRepository(provider)
  }

  static async open(path: string): Promise<DurableInbox> {
    return new DurableInbox(await InboxSqliteProvider.open(path))
  }

  close(): void { this.provider.close() }
}
