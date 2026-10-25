import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import pg from 'pg'
import { env } from '../config/env.js'

export async function acquireStorageLock(
	onLost: (error: Error) => void,
): Promise<() => Promise<void>> {
	const root = await realpath(env.STORAGE_ROOT)
	const digest = createHash('sha256').update(root).digest()
	const keys = [digest.readInt32BE(0), digest.readInt32BE(4)]
	const client = new pg.Client({
		connectionString: env.DATABASE_URL,
		application_name: 'silverbox-storage-lock',
		connectionTimeoutMillis: 5000,
		query_timeout: 5000,
		keepAlive: true,
	})
	let closing = false
	client.on('error', (error) => {
		if (!closing) onLost(error)
	})
	await client.connect()
	try {
		const result = await client.query<{ locked: boolean }>(
			'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
			keys,
		)
		if (!result.rows[0]?.locked)
			throw new Error('Storage is already owned by another API instance')
	} catch (error) {
		closing = true
		await client.end()
		throw error
	}
	const heartbeat = setInterval(() => {
		void client.query('SELECT 1').catch((error: Error) => {
			if (!closing) onLost(error)
		})
	}, 5000)
	heartbeat.unref()
	return async () => {
		closing = true
		clearInterval(heartbeat)
		await client.end()
	}
}
