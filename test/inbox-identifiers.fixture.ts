import { asJobId, asRunId, asSessionId, asSubagentId } from '../src/inbox/ids.js'
import type { JobId, RunId, SessionId, SubagentId } from '../src/inbox/ids.js'

const session: SessionId = asSessionId('session-1')
const run: RunId = asRunId('run-1')
const subagent: SubagentId = asSubagentId('subagent-1')
const job: JobId = asJobId('job-1')
void [session, run, subagent, job]

function expectsSession(_id: SessionId): void {}
function expectsRun(_id: RunId): void {}
function expectsSubagent(_id: SubagentId): void {}
function expectsJob(_id: JobId): void {}

expectsSession(session)
expectsRun(run)
expectsSubagent(subagent)
expectsJob(job)
// @ts-expect-error DSH run IDs are not session IDs.
expectsSession(run)
// @ts-expect-error DSH subagent IDs are not background job IDs.
expectsJob(subagent)
// @ts-expect-error Partner run IDs are not DSH job IDs.
expectsRun(job)
