import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { initializeSqliteSchema } from '../storage/sqlite-schema.js'

const INBOX_SCHEMA_VERSION = 3
const INITIAL_SCHEMA = readFileSync(new URL('../../src/inbox/migrations/001-inbox-schema.up.sql', import.meta.url), 'utf8')
const ACK_SCHEMA = readFileSync(new URL('../../src/inbox/migrations/002-inbox-ack.up.sql', import.meta.url), 'utf8')
const CURSOR_SCOPES_SCHEMA = readFileSync(new URL('../../src/inbox/migrations/003-cursor-scopes.up.sql', import.meta.url), 'utf8')

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
      const currentVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (currentVersion > INBOX_SCHEMA_VERSION) throw new Error(`Inbox 数据库版本 ${currentVersion} 高于当前支持版本 ${INBOX_SCHEMA_VERSION}`)
      if (currentVersion < 1) initializeSqliteSchema(database, 1, () => database.exec(INITIAL_SCHEMA))
      const migratedVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (migratedVersion < 2) initializeSqliteSchema(database, 2, () => database.exec(ACK_SCHEMA))
      const cursorVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0)
      if (cursorVersion < 3) initializeSqliteSchema(database, 3, () => database.exec(CURSOR_SCOPES_SCHEMA))
      // 发送中记录超过两分钟说明上次进程中断；标为结果不明，绝不自动重发。
      database.prepare("UPDATE inbox_acknowledgements SET status='unknown', last_error='进程重启时发送结果未确认', updated_at=? WHERE status='sending' AND updated_at<?")
        .run(Date.now(), Date.now() - 120_000)
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
