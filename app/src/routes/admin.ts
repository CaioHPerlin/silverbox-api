import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Prisma } from '@prisma/client'
import { fromNodeHeaders } from 'better-auth/node'
import { isAPIError } from 'better-auth/api'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import {
	adminUserFields,
	adminUserJson,
	removeAdminUser,
	updateAdminUser,
} from '../lib/admin-users.js'
import { adminMetrics } from '../lib/admin-metrics.js'
import { audit } from '../lib/audit.js'
import { auth } from '../lib/auth.js'
import { expungeFile, fileJson, HttpError, trashFile } from '../lib/file-service.js'
import { prisma } from '../lib/prisma.js'
import { currentUser, requireRole } from '../middleware/auth.js'
import { requireTrustedMutationOrigin } from '../middleware/trusted-origin.js'
import { sendFile } from './files.js'

export const adminRouter = Router()
export const nativeAdminRouter = Router()
const requireAdmin = requireRole('admin')

const numericId = z
	.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
	.pipe(z.number().int().positive().max(2147483647))
const pageNumber = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().min(1).max(10000))
const pageLimit = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100))
const pageQuery = z.object({
	page: pageNumber.optional().default(1),
	limit: pageLimit.optional().default(50),
	q: z.string().trim().max(155).optional(),
})
const role = z.enum(['user', 'admin'])
const nativeRole = z
	.union([role, z.array(role).min(1).max(2)])
	.transform((value) => [...new Set(Array.isArray(value) ? value : [value])].join(','))
const quota = z
	.string()
	.regex(/^[1-9]\d{0,18}$/)
	.transform(BigInt)
	.refine((b) => b <= 9223372036854775807n)
const createUser = z.object({
	name: z.string().trim().min(1).max(155),
	email: z.email().max(155),
	password: z.string().min(8).max(128),
	role: role.default('user'),
})
const changeUser = z
	.object({
		role: role.optional(),
		banned: z.boolean().optional(),
		quotaLimitBytes: quota.optional(),
	})
	.strict()
	.refine((body) => Object.keys(body).length > 0, 'No changes provided')

adminRouter.use(
	requireAdmin,
	requireTrustedMutationOrigin,
	(_req: Request, res: Response, next: NextFunction) => {
		res.setHeader('Cache-Control', 'no-store')
		next()
	},
)

function pageResult(page: number, limit: number) {
	return { skip: (page - 1) * limit, take: limit }
}

adminRouter.get('/users', async (req, res) => {
	const { page, limit, q } = pageQuery.parse(req.query)
	const where: Prisma.UserWhereInput = q
		? {
				OR: [
					{ name: { contains: q, mode: 'insensitive' } },
					{ email: { contains: q, mode: 'insensitive' } },
				],
			}
		: {}
	const result = await prisma.$transaction(
		async (tx) => {
			const users = await tx.user.findMany({
				where,
				select: adminUserFields,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				...pageResult(page, limit),
			})
			const total = await tx.user.count({ where })
			if (users.length === 0) return { users: [], total, page, limit }

			const ids = users.map((user) => user.id)
			// Match /storage/usage: billed versions (including trash) plus avatar bytes.
			// Reservations affect availability but are not committed usage.
			const usage = await tx.$queryRaw<Array<{ userId: number; bytes: string }>>`
				SELECT user_id AS "userId", SUM(bytes)::text AS bytes
				FROM (
					SELECT files.userid AS user_id, SUM(versions.sizebytes) AS bytes
					FROM silverbox_api.files AS files
					JOIN silverbox_api.file_versions AS versions ON versions.fileid = files.id
					WHERE files.userid = ANY(${ids}::integer[])
					GROUP BY files.userid
					UNION ALL
					SELECT user_id, size_bytes AS bytes
					FROM silverbox_api.avatars
					WHERE user_id = ANY(${ids}::integer[])
				) AS account_usage
				GROUP BY user_id
			`
			const byUser = new Map(usage.map(({ userId, bytes }) => [userId, bytes]))
			return {
				users: users.map((user) => ({
					...adminUserJson(user),
					usedBytes: byUser.get(user.id) ?? '0',
				})),
				total,
				page,
				limit,
			}
		},
		{ isolationLevel: 'RepeatableRead' },
	)
	res.json(result)
})

async function registerUser(req: Request, actorId: number) {
	const body = createUser.parse(req.body)
	try {
		const result = await auth.api.createUser({ body, headers: fromNodeHeaders(req.headers) })
		await audit(req, actorId, 'admin_user_create', `user:${Number(result.user.id)}`)
		return result
	} catch (error) {
		if (isAPIError(error))
			throw new HttpError(error.statusCode, error.body?.message ?? 'Unable to create user')
		throw error
	}
}

adminRouter.post('/users', async (req, res) => {
	res.status(201).json(await registerUser(req, currentUser(res).id))
})

adminRouter.patch('/users/:id', async (req, res) => {
	const user = await updateAdminUser(
		req,
		currentUser(res).id,
		numericId.parse(req.params.id),
		changeUser.parse(req.body),
	)
	res.json({ user })
})

adminRouter.delete('/users/:id', async (req, res) => {
	const removed = await removeAdminUser(req, currentUser(res).id, numericId.parse(req.params.id))
	if (removed) res.status(204).end()
	else res.status(202).json({ status: 'deleting' })
})

// Preserve the native client entry points while applying the same invariants as the REST API.
const nativeMutation = [...requireAdmin, requireTrustedMutationOrigin, express.json()]
nativeAdminRouter.post('/create-user', nativeMutation, async (req: Request, res: Response) => {
	res.json(await registerUser(req, currentUser(res).id))
})
nativeAdminRouter.post('/set-role', nativeMutation, async (req: Request, res: Response) => {
	const { userId, role } = z.object({ userId: numericId, role: nativeRole }).parse(req.body)
	res.json({ user: await updateAdminUser(req, currentUser(res).id, userId, { role }) })
})
nativeAdminRouter.post('/remove-user', nativeMutation, async (req: Request, res: Response) => {
	const { userId } = z.object({ userId: numericId }).parse(req.body)
	const success = await removeAdminUser(req, currentUser(res).id, userId)
	res.status(success ? 200 : 202).json({ success })
})
for (const [path, banned] of [
	['/ban-user', true],
	['/unban-user', false],
] as const) {
	nativeAdminRouter.post(path, nativeMutation, async (req: Request, res: Response) => {
		const { userId } = z.object({ userId: numericId }).parse(req.body)
		res.json({ user: await updateAdminUser(req, currentUser(res).id, userId, { banned }) })
	})
}

adminRouter.get('/files', async (req, res) => {
	const { page, limit, q, trash } = pageQuery
		.extend({ trash: z.enum(['true', 'false']).optional() })
		.parse(req.query)
	const term = q ? { contains: q, mode: 'insensitive' as const } : undefined
	const where: Prisma.FileWhereInput = {
		status: 'ready',
		isDeleted: trash === 'true',
		...(term
			? { OR: [{ originalName: term }, { user: { name: term } }, { user: { email: term } }] }
			: {}),
	}
	const [files, total] = await prisma.$transaction(
		[
			prisma.file.findMany({
				where,
				include: { user: { select: { name: true, email: true } } },
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				...pageResult(page, limit),
			}),
			prisma.file.count({ where }),
		],
		{ isolationLevel: 'RepeatableRead' },
	)
	res.json({
		files: files.map((file) => ({
			...fileJson(file),
			ownerId: file.userId,
			ownerName: file.user.name,
			ownerEmail: file.user.email,
		})),
		total,
		page,
		limit,
	})
})

async function getAdminFile(id: number) {
	const file = await prisma.file.findFirst({ where: { id, status: 'ready' } })
	if (!file) throw new HttpError(404, 'File not found')
	return file
}

adminRouter.get('/files/:id/download', async (req, res) => {
	const file = await getAdminFile(numericId.parse(req.params.id))
	if (file.isDeleted) throw new HttpError(404, 'File not found')
	await sendFile(res, file.storageKey, file.originalName, file.mimeType, file.sizeBytes)
	if (res.writableFinished)
		await audit(
			req,
			currentUser(res).id,
			'admin_file_download',
			`file:${file.id};owner:${file.userId}`,
			prisma,
			file.sizeBytes,
		)
})

adminRouter.delete('/files/:id', async (req, res) => {
	const file = await getAdminFile(numericId.parse(req.params.id))
	await trashFile(req, currentUser(res).id, file, 'admin_file_trash')
	res.status(204).end()
})

adminRouter.delete('/files/:id/permanent', async (req, res) => {
	const file = await getAdminFile(numericId.parse(req.params.id))
	if (await expungeFile(req, currentUser(res).id, file, 'admin_file_expunge'))
		res.status(204).end()
	else res.status(202).json({ status: 'deleting' })
})

const auditFilters = z.object({
	since: z.iso.datetime({ offset: true }).optional(),
	until: z.iso.datetime({ offset: true }).optional(),
	userId: numericId.optional(),
	action: z.string().trim().min(1).max(80).optional(),
})
const validPeriod = (filter: { since?: string; until?: string }) =>
	!filter.since || !filter.until || new Date(filter.since) < new Date(filter.until)

function auditWhere(filters: z.infer<typeof auditFilters>): Prisma.AuditLogWhereInput {
	return {
		userId: filters.userId,
		action: filters.action,
		createdAt: {
			gte: filters.since ? new Date(filters.since) : undefined,
			lt: filters.until ? new Date(filters.until) : undefined,
		},
	}
}
const auditOrder = [
	{ createdAt: 'desc' },
	{ id: 'desc' },
] satisfies Prisma.AuditLogOrderByWithRelationInput[]
const auditFields = {
	id: true,
	createdAt: true,
	userId: true,
	actorName: true,
	actorEmail: true,
	action: true,
	ipAddress: true,
	requestId: true,
	details: true,
} satisfies Prisma.AuditLogSelect

adminRouter.get('/audit', async (req, res) => {
	const { page, limit, ...filters } = auditFilters
		.extend({
			page: pageNumber.optional().default(1),
			limit: pageLimit.optional().default(50),
		})
		.refine(validPeriod, 'Invalid date range')
		.parse(req.query)
	const where = auditWhere(filters)
	const [logs, total] = await prisma.$transaction(
		[
			prisma.auditLog.findMany({
				where,
				select: auditFields,
				orderBy: auditOrder,
				...pageResult(page, limit),
			}),
			prisma.auditLog.count({ where }),
		],
		{ isolationLevel: 'RepeatableRead' },
	)
	res.json({ logs, total, page, limit })
})

function csvCell(value: string | number | null) {
	let text = String(value ?? '')
	if (/^[\s\uFEFF]*[=+@-]|^[\r\n\t]/.test(text)) text = "'" + text
	return '"' + text.replaceAll('"', '""') + '"'
}

async function* auditCsv(where: Prisma.AuditLogWhereInput) {
	yield '\uFEFFData UTC,Usuário ID,Nome,E-mail,Ação,IP,ID da requisição,Alvo\r\n'
	let cursor: number | undefined
	for (;;) {
		const logs = await prisma.auditLog.findMany({
			where,
			select: auditFields,
			orderBy: auditOrder,
			take: 500,
			...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
		})
		for (const entry of logs) {
			yield [
				entry.createdAt.toISOString(),
				entry.userId,
				entry.actorName,
				entry.actorEmail,
				entry.action,
				entry.ipAddress,
				entry.requestId,
				entry.details,
			]
				.map(csvCell)
				.join(',') + '\r\n'
		}
		if (logs.length < 500) return
		cursor = logs.at(-1)?.id
	}
}

adminRouter.get('/audit/export', async (req, res) => {
	const filters = auditFilters.refine(validPeriod, 'Invalid date range').parse(req.query)
	res.setHeader('Content-Type', 'text/csv; charset=utf-8')
	res.setHeader('Content-Disposition', 'attachment; filename="silverbox-auditoria.csv"')
	res.setHeader('X-Content-Type-Options', 'nosniff')
	await pipeline(Readable.from(auditCsv(auditWhere(filters))), res)
})

adminRouter.get('/stats', async (req, res) => {
	const { days } = z.object({ days: z.enum(['7', '30']).optional().default('7') }).parse(req.query)
	res.json(await adminMetrics(days === '30' ? 30 : 7))
})
