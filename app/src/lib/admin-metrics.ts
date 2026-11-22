import { env } from '../config/env.js'
import { prisma } from './prisma.js'
import { storage } from './storage.js'

const uploadActions = ['upload', 'version_upload']
const outboundActions = [
	'download',
	'version_download',
	'share_download',
	'share_view',
	'admin_file_download',
]

type DailyTransfers = {
	day: string
	uploads: number
	downloads: number
	upload_bytes: string
	download_bytes: string
}

export async function adminMetrics(days: 7 | 30) {
	const today = new Date().toISOString().slice(0, 10)
	const since = new Date(`${today}T00:00:00.000Z`)
	since.setUTCDate(since.getUTCDate() - days + 1)
	const [
		totalUsers,
		admins,
		blocked,
		files,
		trashed,
		versions,
		trashBytes,
		avatars,
		reserved,
		capacity,
		transfers,
	] = await Promise.all([
		prisma.user.count(),
		prisma.user.count({
			where: {
				OR: [
					{ userRole: 'admin' },
					{ userRole: { startsWith: 'admin,' } },
					{ userRole: { endsWith: ',admin' } },
					{ userRole: { contains: ',admin,' } },
				],
			},
		}),
		prisma.user.count({ where: { banned: true } }),
		prisma.file.count({ where: { status: 'ready', isDeleted: false } }),
		prisma.file.count({ where: { status: 'ready', isDeleted: true } }),
		prisma.fileVersion.aggregate({ _sum: { sizeBytes: true } }),
		prisma.fileVersion.aggregate({
			where: { file: { isDeleted: true } },
			_sum: { sizeBytes: true },
		}),
		prisma.avatar.aggregate({ _sum: { sizeBytes: true } }),
		prisma.uploadReservation.aggregate({ _sum: { sizeBytes: true } }),
		storage.capacity(),
		prisma.$queryRaw<DailyTransfers[]>`
				SELECT to_char(createdat, 'YYYY-MM-DD') AS day,
					(count(*) FILTER (WHERE action = ANY(${uploadActions}::text[])))::int AS uploads,
					(count(*) FILTER (WHERE action = ANY(${outboundActions}::text[])))::int AS downloads,
					coalesce(sum(bytes) FILTER (WHERE action = ANY(${uploadActions}::text[])), 0)::text AS upload_bytes,
					coalesce(sum(bytes) FILTER (WHERE action = ANY(${outboundActions}::text[])), 0)::text AS download_bytes
				FROM silverbox_api.audit_logs
				WHERE createdat >= ${since} AND bytes IS NOT NULL
				GROUP BY 1
			`,
	])
	const byDay = new Map(transfers.map((entry) => [entry.day, entry]))
	const traffic = Array.from({ length: days }, (_, offset) => {
		const date = new Date(since)
		date.setUTCDate(date.getUTCDate() + offset)
		const day = date.toISOString().slice(0, 10)
		const entry = byDay.get(day)
		return {
			day,
			uploads: entry?.uploads ?? 0,
			downloads: entry?.downloads ?? 0,
			uploadBytes: entry?.upload_bytes ?? '0',
			downloadBytes: entry?.download_bytes ?? '0',
		}
	})
	const used = (versions._sum.sizeBytes ?? 0n) + (avatars._sum.sizeBytes ?? 0n)
	const reservedBytes = reserved._sum.sizeBytes ?? 0n
	return {
		users: { total: totalUsers, admins, blocked },
		files: { active: files, trash: trashed },
		storage: {
			usedBytes: used.toString(),
			trashBytes: (trashBytes._sum.sizeBytes ?? 0n).toString(),
			reservedBytes: reservedBytes.toString(),
			limitBytes: env.STORAGE_MAX_BYTES.toString(),
			availableBytes: (env.STORAGE_MAX_BYTES - used - reservedBytes).toString(),
			diskAvailableBytes: capacity.availableBytes.toString(),
			diskTotalBytes: capacity.totalBytes.toString(),
		},
		traffic,
	}
}
