import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { initializeSqliteSchema } from '../storage/sqlite-schema.js'

const INBOX_SCHEMA_VERSION = 1
const INITIAL_SCHEMA = readFileSync(new URL('../../src/inbox/migrations/001-inbox-schema.up.sql', import.meta.url), 'utf8')

/** SQLite connection owner for the durable channel inbox. Transactions stay short and synchronous. */
export class InboxSqliteProvider {
  private closed = false

  private constructor(readonly database: DatabaseSync) {}

  static async open(path: string): Promise<InboxSqliteProvider> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
      initializeSqliteSchema(database, INBOX_SCHEMA_VERSION, () => database.exec(INITIAL_SCHEMA))
      return new InboxSqliteProvider(database)
    } catch (error) {
      database.close()
      throw error
    }
  }

  transaction<T>(action: (database: DatabaseSync) => T): T {
    this.assertOpen()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = action(this.database)
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
  }

  read<T>(action: (database: DatabaseSync) => T): T {
    this.assertOpen()
    return action(this.database)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Durable Inbox SQLite provider is closed')
  }
}
