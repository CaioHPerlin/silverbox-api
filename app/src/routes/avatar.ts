import { createHash } from 'node:crypto'
import express, { Router } from 'express'
import sharp from 'sharp'
import { env } from '../config/env.js'
import { audit } from '../lib/audit.js'
import {
	HttpError,
	lockStorageBudget,
	lockUser,
	requireWritableAccount,
	usage,
} from '../lib/file-service.js'
import { prisma } from '../lib/prisma.js'
import { currentUser, requireAuth } from '../middleware/auth.js'
import { requireTrustedMutationOrigin } from '../middleware/trusted-origin.js'

export const avatarRouter = Router()
const mimeTypes = new Map([
	['image/jpeg', 'jpeg'],
	['image/png', 'png'],
	['image/webp', 'webp'],
])

avatarRouter.use(requireAuth, requireTrustedMutationOrigin)
avatarRouter.get('/', async (_req, res) => {
	const userId = currentUser(res).id
	const avatar = await prisma.avatar.findUnique({ where: { userId } })
	if (!avatar) throw new HttpError(404, 'Avatar not found')
	res.setHeader('Cache-Control', 'private, no-store')
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.type('image/webp').send(Buffer.from(avatar.content))
})

avatarRouter.post(
	'/',
	express.raw({ type: [...mimeTypes.keys()], limit: '2mb', inflate: false }),
	async (req, res) => {
		const format = mimeTypes.get(req.is([...mimeTypes.keys()]) || '')
		if (!format || !Buffer.isBuffer(req.body) || !req.body.length)
			throw new HttpError(415, 'Send a JPEG, PNG or WebP image')
		const image = sharp(req.body, { failOn: 'warning', limitInputPixels: 16_777_216 })
		let content: Buffer
		try {
			const metadata = await image.metadata()
			if (metadata.format !== format) throw new Error('Image does not match its declared type')
			content = await image
				.rotate()
				.resize(512, 512, { fit: 'inside', withoutEnlargement: true })
				.webp()
				.toBuffer()
		} catch {
			throw new HttpError(415, 'Invalid JPEG, PNG or WebP image')
		}
		const userId = currentUser(res).id
		const sizeBytes = BigInt(content.length)
		const version = createHash('sha256').update(content).digest('hex').slice(0, 16)
		const reference = `/users/me/avatar?v=${version}`
		await prisma.$transaction(async (tx) => {
			await lockStorageBudget(tx)
			await lockUser(tx, userId)
			await requireWritableAccount(tx, userId)
			const [old, budget, versions, avatars, reserved] = await Promise.all([
				tx.avatar.findUnique({ where: { userId }, select: { sizeBytes: true } }),
				usage(userId, tx),
				tx.fileVersion.aggregate({ _sum: { sizeBytes: true } }),
				tx.avatar.aggregate({ _sum: { sizeBytes: true } }),
				tx.uploadReservation.aggregate({ _sum: { sizeBytes: true } }),
			])
			const difference = sizeBytes - (old?.sizeBytes ?? 0n)
			if (difference > 0n && difference > budget.available)
				throw new HttpError(413, 'Storage quota exceeded')
			if (
				difference > 0n &&
				(versions._sum.sizeBytes ?? 0n) +
					(avatars._sum.sizeBytes ?? 0n) +
					(reserved._sum.sizeBytes ?? 0n) +
					difference >
					env.STORAGE_MAX_BYTES
			)
				throw new HttpError(507, 'Global storage limit exceeded')
			await tx.avatar.upsert({
				where: { userId },
				update: { content: Uint8Array.from(content), sizeBytes },
				create: { userId, content: Uint8Array.from(content), sizeBytes },
			})
			await tx.user.update({ where: { id: userId }, data: { image: reference } })
			await audit(req, userId, 'avatar_update', `user:${userId}`, tx)
		})
		res.json({ image: reference, sizeBytes: sizeBytes.toString() })
	},
)

avatarRouter.delete('/', async (req, res) => {
	const userId = currentUser(res).id
	await prisma.$transaction(async (tx) => {
		await lockStorageBudget(tx)
		await lockUser(tx, userId)
		await requireWritableAccount(tx, userId)
		const removed = await tx.avatar.deleteMany({ where: { userId } })
		if (removed.count) {
			await tx.user.update({ where: { id: userId }, data: { image: null } })
			await audit(req, userId, 'avatar_delete', `user:${userId}`, tx)
		}
	})
	res.status(204).end()
})
