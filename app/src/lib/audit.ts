import type { Prisma } from '@prisma/client'
import type { Request } from 'express'
import { prisma } from './prisma.js'

export async function audit(
	req: Request,
	userId: number | null,
	action: string,
	details: string,
	tx: Prisma.TransactionClient = prisma,
	bytes?: bigint,
) {
	const actor =
		userId === null
			? null
			: await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
	await tx.auditLog.create({
		data: {
			userId,
			action,
			details,
			ipAddress: req.ip ?? 'unknown',
			requestId: req.id === undefined ? null : String(req.id),
			actorName: actor?.name,
			actorEmail: actor?.email,
			bytes,
		},
	})
}
