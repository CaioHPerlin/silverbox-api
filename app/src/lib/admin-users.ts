import type { Prisma } from '@prisma/client'
import type { Request } from 'express'
import { effectiveUserRole } from '../middleware/auth.js'
import { audit } from './audit.js'
import { HttpError, lockUser, purgeFile, usage } from './file-service.js'
import { prisma } from './prisma.js'

export const adminUserFields = {
	id: true,
	name: true,
	email: true,
	userRole: true,
	banned: true,
	deletionPending: true,
	quotaLimitBytes: true,
	createdAt: true,
} satisfies Prisma.UserSelect

export function adminUserJson(user: Prisma.UserGetPayload<{ select: typeof adminUserFields }>) {
	const { userRole, quotaLimitBytes, ...account } = user
	return {
		...account,
		id: String(user.id),
		role: userRole,
		quotaLimitBytes: quotaLimitBytes.toString(),
	}
}

export async function lockAdminChange(tx: Prisma.TransactionClient, actorId: number) {
	// Serialize operations that can remove an active administrator.
	await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(714923, 2)`
	const actor = await tx.user.findUnique({ where: { id: actorId }, select: adminUserFields })
	if (
		!actor ||
		actor.banned ||
		actor.deletionPending ||
		effectiveUserRole(actor.userRole) !== 'admin'
	)
		throw new HttpError(403, 'Forbidden')
}

async function checkOtherAdmin(
	tx: Prisma.TransactionClient,
	id: number,
	role: string,
	banned: boolean | null,
) {
	if (banned || effectiveUserRole(role) !== 'admin') return
	const others = await tx.$queryRaw<Array<{ id: number }>>`
		SELECT id FROM silverbox_api.users
		WHERE id <> ${id} AND banned IS NOT TRUE AND deletion_pending = false
		AND 'admin' = ANY(string_to_array(user_role, ','))
		LIMIT 1
	`
	if (!others.length) throw new HttpError(409, 'At least one administrator must remain active')
}

export async function updateAdminUser(
	req: Request,
	actorId: number,
	id: number,
	change: { role?: string; banned?: boolean; quotaLimitBytes?: bigint },
) {
	return prisma.$transaction(async (tx) => {
		await lockAdminChange(tx, actorId)
		const target = await tx.user.findUnique({ where: { id }, select: adminUserFields })
		if (!target) throw new HttpError(404, 'User not found')
		await lockUser(tx, id)
		if (target.deletionPending) throw new HttpError(409, 'Account deletion is pending')
		if (
			(change.role !== undefined && effectiveUserRole(change.role) !== 'admin') ||
			change.banned
		)
			await checkOtherAdmin(tx, id, target.userRole, target.banned)
		if (change.quotaLimitBytes !== undefined) {
			const { used, reserved } = await usage(id, tx)
			if (change.quotaLimitBytes < used + reserved)
				throw new HttpError(409, 'Quota cannot be lower than usage and active reservations')
		}
		const account = await tx.user.update({
			where: { id },
			data: {
				userRole: change.role,
				banned: change.banned,
				...(change.banned === undefined ? {} : { banExpires: null, banReason: null }),
				quotaLimitBytes: change.quotaLimitBytes,
			},
			select: adminUserFields,
		})
		if (change.banned) await tx.session.deleteMany({ where: { userId: id } })
		const details = `user:${id}`
		if (change.role !== undefined) await audit(req, actorId, 'admin_user_role', details, tx)
		if (change.banned !== undefined)
			await audit(
				req,
				actorId,
				change.banned ? 'admin_user_ban' : 'admin_user_unban',
				details,
				tx,
			)
		if (change.quotaLimitBytes !== undefined)
			await audit(req, actorId, 'admin_user_quota', details, tx)
		return adminUserJson(account)
	})
}

export async function removeAdminUser(req: Request, actorId: number, id: number) {
	if (actorId === id) throw new HttpError(409, 'An administrator cannot delete their own account')
	await prisma.$transaction(async (tx) => {
		await lockAdminChange(tx, actorId)
		const target = await tx.user.findUnique({ where: { id }, select: adminUserFields })
		if (!target) throw new HttpError(404, 'User not found')
		await lockUser(tx, id)
		if (target.deletionPending) return
		await checkOtherAdmin(tx, id, target.userRole, target.banned)
		if (await tx.uploadReservation.count({ where: { userId: id } }))
			throw new HttpError(409, 'Wait for active uploads before deleting the account')
		await tx.user.update({
			where: { id },
			data: { deletionPending: true, banned: true, banExpires: null },
		})
		await tx.session.deleteMany({ where: { userId: id } })
		await tx.verification.deleteMany({
			where: { value: String(id), identifier: { startsWith: 'reset-password:' } },
		})
		await tx.sharedLink.updateMany({
			where: { userId: id, revokedAt: null },
			data: { revokedAt: new Date() },
		})
		await tx.file.updateMany({ where: { userId: id }, data: { status: 'deleting' } })
		await audit(req, actorId, 'admin_user_deletion_started', `user:${id}`, tx)
	})

	try {
		const files = await prisma.file.findMany({ where: { userId: id }, select: { id: true } })
		for (const file of files) await purgeFile(file.id)
	} catch (error) {
		console.error('[STORAGE] Account file deletion queued for retry:', error)
		return false
	}

	return prisma.$transaction(async (tx) => {
		await lockAdminChange(tx, actorId)
		const target = await tx.user.findUnique({ where: { id }, select: { deletionPending: true } })
		if (!target) return true
		await lockUser(tx, id)
		if (!target.deletionPending || (await tx.file.count({ where: { userId: id } }))) return false
		await tx.folder.updateMany({ where: { userId: id }, data: { parentFolderId: null } })
		await tx.billingGrant.deleteMany({ where: { userId: id } })
		await tx.billingPurchase.deleteMany({ where: { userId: id } })
		await tx.billingCustomer.deleteMany({ where: { userId: id } })
		await tx.user.delete({ where: { id } })
		await audit(req, actorId, 'admin_user_delete', `user:${id}`, tx)
		return true
	})
}
