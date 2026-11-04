import { parentPort, workerData } from 'node:worker_threads'
import { InboxSqliteProvider } from '../../lib/inbox/provider.js'
import { InboxRepository } from '../../lib/inbox/repository.js'

parentPort.once('message', async () => {
  const provider = await InboxSqliteProvider.open(workerData.path)
  try {
    const inbox = new InboxRepository(provider)
    const claim = inbox.claimNext(`worker-${process.pid}-${Math.random()}`, 500, 10_000)
    parentPort.postMessage(claim ?? null)
  } finally {
    provider.close()
  }
})
