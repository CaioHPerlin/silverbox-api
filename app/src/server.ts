import { createApp } from './app.js'
import { env } from './config/env.js'
import { prisma } from './lib/prisma.js'
import { storage } from './lib/storage.js'
import { reconcileStorage } from './lib/file-service.js'
import { acquireStorageLock } from './lib/storage-lock.js'

async function bootstrap(): Promise<void> {
	await storage.init()
	const releaseStorageLock = await acquireStorageLock((error) => {
		console.error('[STORAGE] Exclusive lock lost:', error)
		process.exit(1)
	})
	await reconcileStorage(true)
	const reconciliation = setInterval(() => {
		void reconcileStorage().catch((error: unknown) =>
			console.error('[STORAGE] Reconciliation failed:', error),
		)
	}, 60_000)
	reconciliation.unref()
	const app = createApp()

	const server = app.listen(env.PORT, () => {
		console.info(`[SERVER] Listening on http://localhost:${env.PORT}`)
	})

	function shutdown(signal: NodeJS.Signals): void {
		clearInterval(reconciliation)
		console.info(`[SERVER] Received ${signal}. Shutting down...`)

		server.close((error) => {
			if (error) {
				console.error('[SERVER] Shutdown failed:', error)
				process.exit(1)
			}

			void prisma
				.$disconnect()
				.finally(() => releaseStorageLock().finally(() => process.exit(0)))
		})
	}
	process.once('SIGTERM', () => shutdown('SIGTERM'))
	process.once('SIGINT', () => shutdown('SIGINT'))
}

void bootstrap().catch((error: unknown) => {
	console.error('[SERVER] Startup failed:', error)
	process.exit(1)
})
