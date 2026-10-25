import { createHash, randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { fromNodeHeaders } from 'better-auth/node'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { auth } from '../lib/auth.js'
import { prisma } from '../lib/prisma.js'
import { storage } from '../lib/storage.js'
import {
	audit,
	checkFolder,
	fileJson,
	HttpError,
	lockUser,
	ownedFile,
	purgeFile,
	usage,
	versionJson,
	withStoredBytes,
} from '../lib/file-service.js'
import { env } from '../config/env.js'

export const foldersRouter = Router()
export const filesRouter = Router()
export const sharesRouter = Router()
export const storageRouter = Router()

type Handler = (req: Request, res: Response) => Promise<void>
const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
	void handler(req, res).catch(next)
}

const nameSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.refine((value) => !/[\\/\0\r\n]/.test(value), 'Invalid name')
const folderSchema = z
	.object({
		name: nameSchema,
		parentFolderId: z.number().int().positive().nullable().default(null),
	})
	.strict()
const fileChangeSchema = z
	.object({
		originalName: nameSchema.optional(),
		folderId: z.number().int().positive().nullable().optional(),
	})
	.strict()
const folderChangeSchema = z
	.object({
		name: nameSchema.optional(),
		parentFolderId: z.number().int().positive().nullable().optional(),
	})
	.strict()

function id(value: string | string[] | undefined): number {
	const result = Number(value)
	if (!value || Array.isArray(value) || !Number.isSafeInteger(result) || result <= 0)
		throw new HttpError(400, 'Invalid id')
	return result
}

async function userId(req: Request): Promise<number> {
	const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
	if (!session) throw new HttpError(401, 'Unauthorized')
	return id(session.user.id)
}

function requestIp(req: Request): string {
	return req.ip ?? 'unknown'
}

function uploadHeaders(req: Request) {
	if (req.headers['content-type'] !== 'application/octet-stream')
		throw new HttpError(415, 'Content-Type must be application/octet-stream')
	const rawSize = req.headers['x-file-size']
	if (typeof rawSize !== 'string' || !/^\d+$/.test(rawSize))
		throw new HttpError(400, 'X-File-Size must be the exact byte count')
	const size = BigInt(rawSize)
	if (size > BigInt(env.MAX_UPLOAD_BYTES)) throw new HttpError(413, 'File exceeds upload limit')
	const encodedName = z.string().max(1024).parse(req.headers['x-file-name'])
	let decodedName: string
	try {
		decodedName = decodeURIComponent(encodedName)
	} catch {
		throw new HttpError(400, 'X-File-Name must be URI encoded')
	}
	const name = nameSchema.parse(decodedName)
	const mimeType = z
		.string()
		.max(255)
		.regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/, 'Invalid MIME type')
		.default('application/octet-stream')
		.parse(req.headers['x-file-mime'])
	return { size, name, mimeType }
}

async function sendDownload(
	res: Response,
	storageKey: string,
	name: string,
	mimeType: string,
	size: bigint,
): Promise<void> {
	if (!(await storage.exists(storageKey))) throw new HttpError(503, 'Stored file is unavailable')
	res.setHeader('Content-Type', mimeType)
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('Content-Length', size.toString())
	res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
	try {
		await pipeline(await storage.read(storageKey), res)
	} catch (error) {
		if (res.headersSent) res.destroy(error as Error)
		else throw error
	}
}

foldersRouter.get(
	'/',
	route(async (req, res) => {
		const owner = await userId(req)
		const parentFolderId =
			req.query.parentFolderId === undefined ? null : id(String(req.query.parentFolderId))
		await checkFolder(owner, parentFolderId)
		const folders = await prisma.folder.findMany({
			where: { userId: owner, parentFolderId },
			orderBy: [{ name: 'asc' }, { id: 'asc' }],
		})
		res.json({ folders })
	}),
)

foldersRouter.post(
	'/',
	route(async (req, res) => {
		const owner = await userId(req)
		const body = folderSchema.parse(req.body)
		await checkFolder(owner, body.parentFolderId)
		const folder = await prisma.folder.create({
			data: { userId: owner, name: body.name, parentFolderId: body.parentFolderId },
		})
		res.status(201).json({ folder })
	}),
)

foldersRouter.patch(
	'/:id',
	route(async (req, res) => {
		const owner = await userId(req)
		const folderId = id(req.params.id)
		const body = folderChangeSchema.parse(req.body)
		if (Object.keys(body).length === 0) throw new HttpError(400, 'No changes provided')
		const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: owner } })
		if (!folder) throw new HttpError(404, 'Folder not found')
		if (body.parentFolderId !== undefined) {
			await checkFolder(owner, body.parentFolderId)
			let cursor = body.parentFolderId
			while (cursor !== null) {
				if (cursor === folderId) throw new HttpError(409, 'Folder move would create a cycle')
				const parent: { parentFolderId: number | null } | null = await prisma.folder.findUnique(
					{ where: { id: cursor }, select: { parentFolderId: true } },
				)
				cursor = parent?.parentFolderId ?? null
			}
		}
		const updated = await prisma.folder.update({ where: { id: folderId }, data: body })
		res.json({ folder: updated })
	}),
)

foldersRouter.delete(
	'/:id',
	route(async (req, res) => {
		const owner = await userId(req)
		const folderId = id(req.params.id)
		const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: owner } })
		if (!folder) throw new HttpError(404, 'Folder not found')
		const [children, files] = await Promise.all([
			prisma.folder.count({ where: { parentFolderId: folderId } }),
			prisma.file.count({ where: { folderId } }),
		])
		if (children || files) throw new HttpError(409, 'Folder is not empty')
		await prisma.folder.delete({ where: { id: folderId } })
		res.status(204).end()
	}),
)

storageRouter.get(
	'/usage',
	route(async (req, res) => {
		const value = await usage(await userId(req))
		res.json({
			usedBytes: value.used.toString(),
			reservedBytes: value.reserved.toString(),
			limitBytes: value.limit.toString(),
			availableBytes: value.available.toString(),
		})
	}),
)

filesRouter.post(
	'/',
	route(async (req, res) => {
		const owner = await userId(req)
		const { size, name, mimeType } = uploadHeaders(req)
		const folderId =
			req.headers['x-folder-id'] === undefined ? null : id(req.headers['x-folder-id'])
		await checkFolder(owner, folderId)
		const file = await withStoredBytes(req, owner, size, async (tx, key, checksum) => {
			const created = await tx.file.create({
				data: {
					userId: owner,
					folderId,
					originalName: name,
					storageKey: key,
					sizeBytes: size,
					mimeType,
					checksum,
					versions: {
						create: {
							storageKey: key,
							sizeBytes: size,
							checksum,
							mimeType,
							versionNumber: 1,
						},
					},
				},
			})
			await audit(tx, owner, 'upload', requestIp(req), `file:${created.id}`)
			return created
		})
		res.status(201).json({ file: fileJson(file) })
	}),
)

filesRouter.get(
	'/',
	route(async (req, res) => {
		const owner = await userId(req)
		const folderId = req.query.folderId === undefined ? null : id(String(req.query.folderId))
		await checkFolder(owner, folderId)
		const page = req.query.page === undefined ? 1 : id(String(req.query.page))
		const limit = req.query.limit === undefined ? 50 : id(String(req.query.limit))
		if (limit > 100) throw new HttpError(400, 'Limit must be at most 100')
		const where = { userId: owner, folderId, isDeleted: false, status: 'ready' }
		const [files, total] = await Promise.all([
			prisma.file.findMany({
				where,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				skip: (page - 1) * limit,
				take: limit,
			}),
			prisma.file.count({ where }),
		])
		res.json({ files: files.map(fileJson), page, limit, total })
	}),
)

filesRouter.get(
	'/trash',
	route(async (req, res) => {
		const owner = await userId(req)
		const files = await prisma.file.findMany({
			where: { userId: owner, isDeleted: true, status: 'ready' },
			orderBy: { deletedAt: 'desc' },
		})
		res.json({ files: files.map(fileJson) })
	}),
)

filesRouter.get(
	'/:id',
	route(async (req, res) => {
		res.json({ file: fileJson(await ownedFile(await userId(req), id(req.params.id))) })
	}),
)

filesRouter.get(
	'/:id/download',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		await prisma.auditLog.create({
			data: {
				userId: owner,
				action: 'download',
				ipAddress: requestIp(req),
				details: `file:${file.id}`,
			},
		})
		await sendDownload(res, file.storageKey, file.originalName, file.mimeType, file.sizeBytes)
	}),
)

filesRouter.patch(
	'/:id',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		const body = fileChangeSchema.parse(req.body)
		if (Object.keys(body).length === 0) throw new HttpError(400, 'No changes provided')
		if (body.folderId !== undefined) await checkFolder(owner, body.folderId)
		const updated = await prisma.file.update({ where: { id: file.id }, data: body })
		res.json({ file: fileJson(updated) })
	}),
)

filesRouter.post(
	'/:id/versions',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		const { size, mimeType } = uploadHeaders(req)
		const version = await withStoredBytes(req, owner, size, async (tx, key, checksum) => {
			const current = await tx.file.findFirst({
				where: { id: file.id, userId: owner, isDeleted: false, status: 'ready' },
			})
			if (!current) throw new HttpError(409, 'File is no longer available')
			const latest = await tx.fileVersion.aggregate({
				where: { fileId: file.id },
				_max: { versionNumber: true },
			})
			const created = await tx.fileVersion.create({
				data: {
					fileId: file.id,
					storageKey: key,
					sizeBytes: size,
					checksum,
					mimeType,
					versionNumber: (latest._max.versionNumber ?? 0) + 1,
				},
			})
			await tx.file.update({
				where: { id: file.id },
				data: { storageKey: key, sizeBytes: size, mimeType, checksum },
			})
			await audit(
				tx,
				owner,
				'version_upload',
				requestIp(req),
				`file:${file.id};version:${created.id}`,
			)
			return created
		})
		res.status(201).json({ version: versionJson(version) })
	}),
)

filesRouter.get(
	'/:id/versions',
	route(async (req, res) => {
		const file = await ownedFile(await userId(req), id(req.params.id), true)
		const versions = await prisma.fileVersion.findMany({
			where: { fileId: file.id },
			orderBy: { versionNumber: 'desc' },
		})
		res.json({ versions: versions.map(versionJson) })
	}),
)

filesRouter.get(
	'/:id/versions/:versionId/download',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		const version = await prisma.fileVersion.findFirst({
			where: { id: id(req.params.versionId), fileId: file.id },
		})
		if (!version) throw new HttpError(404, 'Version not found')
		await prisma.auditLog.create({
			data: {
				userId: owner,
				action: 'version_download',
				ipAddress: requestIp(req),
				details: `file:${file.id};version:${version.id}`,
			},
		})
		await sendDownload(
			res,
			version.storageKey,
			file.originalName,
			version.mimeType,
			version.sizeBytes,
		)
	}),
)

filesRouter.post(
	'/:id/versions/:versionId/restore',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		const source = await prisma.fileVersion.findFirst({
			where: { id: id(req.params.versionId), fileId: file.id },
		})
		if (!source) throw new HttpError(404, 'Version not found')
		const version = await withStoredBytes(
			{ copyFrom: source.storageKey, checksum: source.checksum },
			owner,
			source.sizeBytes,
			async (tx, key, checksum) => {
				const current = await tx.file.findFirst({
					where: { id: file.id, userId: owner, isDeleted: false, status: 'ready' },
				})
				if (!current) throw new HttpError(409, 'File is no longer available')
				const latest = await tx.fileVersion.aggregate({
					where: { fileId: file.id },
					_max: { versionNumber: true },
				})
				const created = await tx.fileVersion.create({
					data: {
						fileId: file.id,
						storageKey: key,
						sizeBytes: source.sizeBytes,
						checksum,
						mimeType: source.mimeType,
						versionNumber: (latest._max.versionNumber ?? 0) + 1,
					},
				})
				await tx.file.update({
					where: { id: file.id },
					data: {
						storageKey: key,
						sizeBytes: source.sizeBytes,
						checksum,
						mimeType: source.mimeType,
					},
				})
				await audit(
					tx,
					owner,
					'version_restore',
					requestIp(req),
					`file:${file.id};version:${created.id}`,
				)
				return created
			},
		)
		res.status(201).json({ version: versionJson(version) })
	}),
)

filesRouter.delete(
	'/:id',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		await prisma.$transaction(async (tx) => {
			await tx.file.update({
				where: { id: file.id },
				data: { isDeleted: true, deletedAt: new Date() },
			})
			await tx.sharedLink.updateMany({
				where: { fileId: file.id, revokedAt: null },
				data: { revokedAt: new Date() },
			})
			await audit(tx, owner, 'trash', requestIp(req), `file:${file.id}`)
		})
		res.status(204).end()
	}),
)

filesRouter.post(
	'/:id/restore',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id), true)
		if (!file.isDeleted) throw new HttpError(409, 'File is not in trash')
		const restored = await prisma.$transaction(async (tx) => {
			const value = await tx.file.update({
				where: { id: file.id },
				data: { isDeleted: false, deletedAt: null },
			})
			await audit(tx, owner, 'trash_restore', requestIp(req), `file:${file.id}`)
			return value
		})
		res.json({ file: fileJson(restored) })
	}),
)

filesRouter.delete(
	'/:id/permanent',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id), true)
		if (!file.isDeleted) throw new HttpError(409, 'Move the file to trash first')
		await prisma.$transaction(async (tx) => {
			await lockUser(tx, owner)
			await tx.file.update({ where: { id: file.id }, data: { status: 'deleting' } })
			await audit(tx, owner, 'permanent_delete', requestIp(req), `file:${file.id}`)
		})
		try {
			await purgeFile(file.id)
			res.status(204).end()
		} catch (error) {
			console.error('[STORAGE] Permanent deletion queued for retry:', error)
			res.status(202).json({ status: 'deleting' })
		}
	}),
)

filesRouter.post(
	'/:id/shares',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id))
		const body = z
			.object({ expiresInSeconds: z.number().int().min(60).max(604800).default(86400) })
			.strict()
			.parse(req.body ?? {})
		const token = randomBytes(32).toString('base64url')
		const hashed = createHash('sha256').update(token).digest('hex')
		const expiresAt = new Date(Date.now() + body.expiresInSeconds * 1000)
		const link = await prisma.$transaction(async (tx) => {
			const created = await tx.sharedLink.create({
				data: { fileId: file.id, userId: owner, token: hashed, expiresAt },
			})
			await audit(
				tx,
				owner,
				'share_create',
				requestIp(req),
				`file:${file.id};share:${created.id}`,
			)
			return created
		})
		res.status(201).json({
			id: link.id,
			url: `${env.BETTER_AUTH_URL}/shares/${token}`,
			expiresAt,
		})
	}),
)

filesRouter.get(
	'/:id/shares',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id), true)
		const shares = await prisma.sharedLink.findMany({
			where: { fileId: file.id },
			select: { id: true, expiresAt: true, revokedAt: true, createdAt: true },
			orderBy: { createdAt: 'desc' },
		})
		res.json({ shares })
	}),
)

filesRouter.delete(
	'/:id/shares/:shareId',
	route(async (req, res) => {
		const owner = await userId(req)
		const file = await ownedFile(owner, id(req.params.id), true)
		const shareId = id(req.params.shareId)
		const changed = await prisma.sharedLink.updateMany({
			where: { id: shareId, fileId: file.id, userId: owner },
			data: { revokedAt: new Date() },
		})
		if (!changed.count) throw new HttpError(404, 'Share not found')
		await prisma.auditLog.create({
			data: {
				userId: owner,
				action: 'share_revoke',
				ipAddress: requestIp(req),
				details: `file:${file.id};share:${shareId}`,
			},
		})
		res.status(204).end()
	}),
)

sharesRouter.get(
	'/:token',
	route(async (req, res) => {
		const token = req.params.token
		if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
			throw new HttpError(404, 'Share not found')
		const hashed = createHash('sha256').update(token).digest('hex')
		const share = await prisma.sharedLink.findUnique({
			where: { token: hashed },
			include: { file: true },
		})
		if (!share) throw new HttpError(404, 'Share not found')
		if (
			share.revokedAt ||
			share.expiresAt <= new Date() ||
			share.file.isDeleted ||
			share.file.status !== 'ready'
		)
			throw new HttpError(410, 'Share is no longer available')
		await prisma.auditLog.create({
			data: {
				userId: share.userId,
				action: 'share_download',
				ipAddress: requestIp(req),
				details: `file:${share.fileId};share:${share.id}`,
			},
		})
		await sendDownload(
			res,
			share.file.storageKey,
			share.file.originalName,
			share.file.mimeType,
			share.file.sizeBytes,
		)
	}),
)
