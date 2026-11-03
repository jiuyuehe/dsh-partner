import {randomUUID} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'
import {personaHash} from './domain.js'
import type {PersonaCorrection, PersonaJob, PersonaParagraph, PersonaSource, PersonaView} from './types.js'

const UPDATE_INTERVAL = 10 * 60_000
export function initializePersona(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS persona_state (
    scope_id TEXT PRIMARY KEY, source_hash TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, requested INTEGER NOT NULL DEFAULT 0,
    corrections TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
  ); CREATE TABLE IF NOT EXISTS persona_versions (
    id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS persona_versions_scope ON persona_versions(scope_id, id);`)
}

/** Bounded user evidence only: never derive a user profile from assistant prose. */
export function personaSources(db: DatabaseSync, companionId: string, scopeId: string, now = Date.now()): PersonaSource[] {
  const sources: PersonaSource[] = []
  const memories = db.prepare(`SELECT * FROM memories WHERE companion_id=? AND scope_id=? AND status='active'
    AND kind IN ('profile','preference','relationship') AND (expires_at IS NULL OR expires_at>?)
    ORDER BY locked DESC, updated_at DESC, id LIMIT 24`).all(companionId, scopeId, now)
  for (const row of memories) {
    const evidence = (JSON.parse(String(row.evidence_json)) as Array<{turnId: string; excerpt: string}>).slice(-2)
    if (!evidence.length) continue
    const text = `${String(row.subject)}：${String(row.content)}\n用户依据：${evidence.map(item => item.excerpt).join('；')}`.slice(0, 350)
    sources.push({id:`memory:${String(row.id)}`,kind:'memory',text,at:Number(row.updated_at),expressionEligible:false,
      signature:personaHash([row.content,row.subject,row.locked,row.evidence_json]),turnIds:evidence.map(item=>item.turnId)})
  }
  const turns = db.prepare(`SELECT id, at, substr(json_extract(turn_json,'$.user'),1,450) AS user, json_extract(turn_json,'$.identityRelation.matched') AS matched FROM memory_jobs
    WHERE scope_id=? AND length(trim(json_extract(turn_json,'$.user')))>=4 ORDER BY at DESC, id DESC LIMIT 20`).all(scopeId)
  for (const row of turns) {
    const text = String(row.user)
    sources.push({id:`turn:${String(row.id)}`,kind:'turn',text,at:Number(row.at),expressionEligible:row.matched === null || Number(row.matched)===1,signature:personaHash([text,row.matched === null || Number(row.matched)===1]),turnIds:[String(row.id)]})
  }
  // Preserve still-valid older evidence; a moving recent-message window is not forgetting.
  const saved: PersonaParagraph[] = JSON.parse(String(rowFor(db, scopeId)?.payload ?? '[]'))
  const ids = new Set(sources.map(source => source.id))
  for (const source of saved.flatMap(item => item.evidence)) {
    if (!ids.has(source.id) && evidenceCurrent(db, companionId, scopeId, source, now)) {
      sources.push(source); ids.add(source.id)
    }
  }
  return sources
}

function evidenceCurrent(db: DatabaseSync, companionId: string, scopeId: string, source: PersonaSource, now: number): boolean {
  if (source.kind === 'memory') {
    const row = db.prepare("SELECT * FROM memories WHERE id=? AND companion_id=? AND scope_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)")
      .get(source.id.slice('memory:'.length), companionId, scopeId, now)
    return !!row && personaHash([row.content,row.subject,row.locked,row.evidence_json]) === source.signature
  }
  const row = db.prepare("SELECT substr(json_extract(turn_json,'$.user'),1,450) AS user, json_extract(turn_json,'$.identityRelation.matched') AS matched FROM memory_jobs WHERE id=? AND scope_id=?")
    .get(source.id.slice('turn:'.length), scopeId)
  return !!row && personaHash([String(row.user),row.matched === null || Number(row.matched)===1]) === source.signature
}

function rowFor(db: DatabaseSync, scopeId: string) {
  return db.prepare('SELECT * FROM persona_state WHERE scope_id=?').get(scopeId)
}
// Regenerate once when the synthesis contract changes, even without new conversation.
const sourceHash = (sources: PersonaSource[]): string => personaHash(['person-centered-v3-expression', sources.map(item=>[item.id,item.signature])])

export function readPersona(db: DatabaseSync, companionId: string, scopeId: string, now=Date.now(), sources=personaSources(db,companionId,scopeId,now)): PersonaView {
  const row = rowFor(db,scopeId)
  const hash = sourceHash(sources)
  const saved: PersonaParagraph[] = JSON.parse(String(row?.payload ?? '[]'))
  const corrections: PersonaCorrection[] = JSON.parse(String(row?.corrections ?? '[]'))
  const current = new Map(sources.map(source=>[source.id,source.signature]))
  // Deleted, corrected or expired evidence stops being injected immediately.
  const paragraphs = saved.filter(item=>!corrections.some(c=>c.id===item.id)
    && item.evidence.every(source=>current.get(source.id)===source.signature))
  const stale = row?.source_hash !== hash || paragraphs.length !== saved.length
  const enough = sources.some(item=>item.kind==='memory') || sources.length>=3
  const status: PersonaView['status'] = Number(row?.lease_until)>now ? 'processing'
    : Number(row?.attempts)>0 ? 'retrying' : !enough ? 'waiting'
    : stale || Boolean(row?.requested) ? 'pending' : 'ready'
  return {status,paragraphs,stale,version:personaHash([row?.revision??0,paragraphs]),
    ...(Number(row?.updated_at)>0?{updatedAt:Number(row?.updated_at)}:{}),
    ...(Number(row?.next_at)>0?{nextAt:Number(row?.next_at)}:{}),
    ...(row?.error?{error:String(row.error)}:{})}
}

export function claimPersona(db: DatabaseSync, companionId: string, scopeId: string, now=Date.now()): PersonaJob | undefined {
  db.exec('BEGIN IMMEDIATE')
  try {
    const job = claimWithinTransaction(db, companionId, scopeId, now)
    db.exec('COMMIT')
    return job
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

function claimWithinTransaction(db: DatabaseSync, companionId: string, scopeId: string, now: number): PersonaJob | undefined {
  const sources=personaSources(db,companionId,scopeId,now)
  if (!sources.some(item=>item.kind==='memory') && sources.length<3) return undefined
  db.prepare('INSERT OR IGNORE INTO persona_state(scope_id) VALUES (?)').run(scopeId)
  const row=rowFor(db,scopeId)!
  const hash=sourceHash(sources)
  if (Number(row.lease_until)>now || Number(row.next_at)>now || (row.source_hash===hash && !row.requested)) return undefined
  const token=randomUUID()
  db.prepare('UPDATE persona_state SET lease_token=?,lease_until=? WHERE scope_id=?').run(token,now+3*60_000,scopeId)
  return {companionId,scopeId,token,sourceHash:hash,sources,previous:readPersona(db,companionId,scopeId,now,sources).paragraphs,
    corrections:JSON.parse(String(row.corrections))}
}

export function finishPersona(db: DatabaseSync, job: PersonaJob, paragraphs: PersonaParagraph[], now=Date.now()): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const row=rowFor(db,job.scopeId)
    if (row?.lease_token!==job.token) throw new Error('画像任务已失效，将以最新请求为准')
    const latest=personaSources(db,job.companionId,job.scopeId,now)
    const current=new Map(latest.map(source=>[source.id,source.signature]))
    if (paragraphs.some(item=>item.evidence.some(source=>current.get(source.id)!==source.signature))) throw new Error('画像依据已更新，将自动重试')
    if (Number(row.updated_at)>0) db.prepare('INSERT INTO persona_versions(scope_id,payload,updated_at) VALUES (?,?,?)').run(job.scopeId,String(row.payload),Number(row.updated_at))
    db.prepare(`DELETE FROM persona_versions WHERE scope_id=? AND id NOT IN
      (SELECT id FROM persona_versions WHERE scope_id=? ORDER BY id DESC LIMIT 5)`).run(job.scopeId,job.scopeId)
    db.prepare(`UPDATE persona_state SET payload=?,source_hash=?,updated_at=?,next_at=?,attempts=0,error='',
      lease_token=NULL,lease_until=0,requested=0,revision=revision+1 WHERE scope_id=?`).run(JSON.stringify(paragraphs),job.sourceHash,now,now+UPDATE_INTERVAL,job.scopeId)
    db.exec('COMMIT')
  } catch(error) {db.exec('ROLLBACK');throw error}
}

export function failPersona(db: DatabaseSync, job: PersonaJob, error: string, now=Date.now()): void {
  const row=rowFor(db,job.scopeId)
  if (row?.lease_token!==job.token) return
  const attempts=Number(row.attempts)+1
  db.prepare(`UPDATE persona_state SET attempts=?,next_at=?,error=?,lease_token=NULL,lease_until=0 WHERE scope_id=? AND lease_token=?`)
    .run(attempts,now+Math.min(3600000,30000*2**Math.min(attempts-1,7)),error.slice(0,500),job.scopeId,job.token)
}

export function requestPersona(db: DatabaseSync, scopeId: string, version: string, companionId: string, paragraphId?: string, correction=''): void {
  const view=readPersona(db,companionId,scopeId)
  if (view.version!==version) throw new Error('画像已更新，请刷新后重试')
  db.prepare('INSERT OR IGNORE INTO persona_state(scope_id) VALUES (?)').run(scopeId)
  const corrections: PersonaCorrection[]=JSON.parse(String(rowFor(db,scopeId)!.corrections))
  if (paragraphId) {
    const item=view.paragraphs.find(item=>item.id===paragraphId)
    if (!item) throw new Error('该画像段落已不存在')
    if (corrections.length>=30) throw new Error('纠正记录已达30条，请先整理已有记忆，避免丢失已确认的纠正')
    corrections.push({id:item.id,text:item.text,correction:correction.trim().slice(0,500)||'用户明确否认此结论，不得继续使用或换措辞重复。',at:Date.now()})
  }
  db.prepare(`UPDATE persona_state SET requested=1,next_at=0,attempts=0,error='',corrections=?,revision=revision+1,
    lease_token=NULL,lease_until=0 WHERE scope_id=?`).run(JSON.stringify(corrections),scopeId)
}
