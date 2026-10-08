import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { Prisma, File, FileVersion } from '@prisma/client'
import { prisma } from './prisma.js'
import { storage } from './storage.js'

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message)
	}
}

type Transaction = Prisma.TransactionClient

export function fileJson(file: File) {
	return {
		id: file.id,
		folderId: file.folderId,
		originalName: file.originalName,
		sizeBytes: Number(file.sizeBytes),
		mimeType: file.mimeType,
		checksum: file.checksum,
		isDeleted: file.isDeleted,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
	}
}

export function versionJson(version: FileVersion) {
	return {
		id: version.id,
		versionNumber: version.versionNumber,
		sizeBytes: Number(version.sizeBytes),
		checksum: version.checksum,
		mimeType: version.mimeType,
		createdAt: version.createdAt,
	}
}

export async function audit(
	tx: Transaction,
	userId: number,
	action: string,
	ipAddress: string,
	details?: string,
): Promise<void> {
	await tx.auditLog.create({ data: { userId, action, ipAddress, details } })
}

export async function usage(userId: number, tx: Transaction | typeof prisma = prisma) {
	const [user, versions, reservations] = await Promise.all([
		tx.user.findUnique({ where: { id: userId }, select: { quotaLimitBytes: true } }),
		tx.fileVersion.aggregate({ where: { file: { userId } }, _sum: { sizeBytes: true } }),
		tx.uploadReservation.aggregate({ where: { userId }, _sum: { sizeBytes: true } }),
	])
	if (!user) throw new HttpError(401, 'User not found')
	const used = versions._sum.sizeBytes ?? 0n
	const reserved = reservations._sum.sizeBytes ?? 0n
	return {
		used,
		reserved,
		limit: user.quotaLimitBytes,
		available: user.quotaLimitBytes - used - reserved,
	}
}

export async function lockUser(tx: Transaction, userId: number): Promise<void> {
	const rows = await tx.$queryRaw<
		Array<{ id: number }>
	>`SELECT id FROM silverbox_api.users WHERE id = ${userId} FOR UPDATE`
	if (rows.length === 0) throw new HttpError(401, 'User not found')
}

async function reserve(userId: number, sizeBytes: bigint) {
	const id = randomUUID()
	const storageKey = `objects/${userId}/${randomUUID()}`
	await prisma.$transaction(async (tx) => {
		await lockUser(tx, userId)
		const current = await usage(userId, tx)
		if (sizeBytes > current.available) throw new HttpError(413, 'Storage quota exceeded')
		await tx.uploadReservation.create({
			data: {
				id,
				userId,
				storageKey,
				sizeBytes,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
			},
		})
	})
	return { id, storageKey, stagedKey: `staging/${id}` }
}

export async function withStoredBytes<T>(
	input: Readable | { copyFrom: string; checksum: string },
	userId: number,
	sizeBytes: bigint,
	commit: (tx: Transaction, key: string, checksum: string) => Promise<T>,
): Promise<T> {
	const reservation = await reserve(userId, sizeBytes)
	let checksum: string
	try {
		if ('copyFrom' in input) {
			await storage.copy(input.copyFrom, reservation.storageKey)
			checksum = input.checksum
		} else {
			checksum = await storage.write(input, reservation.stagedKey, sizeBytes)
			await storage.commit(reservation.stagedKey, reservation.storageKey)
		}
		return await prisma.$transaction(async (tx) => {
			await lockUser(tx, userId)
			const value = await commit(tx, reservation.storageKey, checksum)
			await tx.uploadReservation.delete({ where: { id: reservation.id } })
			return value
		})
	} catch (error) {
		try {
			await storage.delete(reservation.stagedKey)
			await storage.delete(reservation.storageKey)
			await prisma.uploadReservation.deleteMany({ where: { id: reservation.id } })
		} catch (cleanupError) {
			console.error('[STORAGE] Cleanup failed; reconciliation will retry:', cleanupError)
		}
		if (
			error instanceof Error &&
			/^Upload (exceeds declared size|size differs from declared size)$/.test(error.message)
		) {
			throw new HttpError(400, error.message)
		}
		throw error
	}
}

export async function ownedFile(userId: number, id: number, includeDeleted = false) {
	const file = await prisma.file.findFirst({
		where: { id, userId, status: 'ready', ...(includeDeleted ? {} : { isDeleted: false }) },
	})
	if (!file) throw new HttpError(404, 'File not found')
	return file
}

export async function checkFolder(userId: number, folderId: number | null): Promise<void> {
	if (folderId === null) return
	const folder = await prisma.folder.findFirst({ where: { id: folderId, userId } })
	if (!folder) throw new HttpError(404, 'Folder not found')
}

export async function purgeFile(fileId: number): Promise<void> {
	const file = await prisma.file.findUnique({ where: { id: fileId }, include: { versions: true } })
	if (!file || file.status !== 'deleting') return
	for (const version of file.versions) await storage.delete(version.storageKey)
	await storage.delete(file.storageKey)
	await prisma.$transaction(async (tx) => {
		await lockUser(tx, file.userId)
		await tx.file.deleteMany({ where: { id: file.id, status: 'deleting' } })
	})
}

export async function reconcileStorage(clearAllReservations = false): Promise<void> {
	const expired = await prisma.uploadReservation.findMany({
		where: clearAllReservations ? {} : { expiresAt: { lt: new Date() } },
	})
	for (const reservation of expired) {
		try {
			await storage.delete(`staging/${reservation.id}`)
			await storage.delete(reservation.storageKey)
			await prisma.uploadReservation.deleteMany({ where: { id: reservation.id } })
		} catch (error) {
			console.error('[STORAGE] Reservation reconciliation failed:', error)
		}
	}
	const deleting = await prisma.file.findMany({
		where: { status: 'deleting' },
		select: { id: true },
	})
	for (const file of deleting) {
		try {
			await purgeFile(file.id)
		} catch (error) {
			console.error('[STORAGE] Deletion reconciliation failed:', error)
		}
	}
}
