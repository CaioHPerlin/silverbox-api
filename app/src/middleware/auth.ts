import { fromNodeHeaders } from 'better-auth/node'
import type { RequestHandler, Response } from 'express'
import { auth } from '../lib/auth.js'

export type UserRole = 'admin' | 'user'
export type AuthenticatedUser = { id: number; role: UserRole }

export function effectiveUserRole(role: string | null | undefined): UserRole {
	// Better Auth stores multiple roles as a comma-separated string.
	return role?.split(',').includes('admin') ? 'admin' : 'user'
}

declare global {
	namespace Express {
		interface Locals {
			user?: AuthenticatedUser
		}
	}
}

export function currentUser(res: Response): AuthenticatedUser {
	const user = res.locals.user
	if (!user) throw new Error('requireAuth must run before this handler')
	return user
}

export const requireAuth: RequestHandler = async (req, res, next) => {
	try {
		const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
		const id = Number(session?.user.id)

		if (!session || !Number.isSafeInteger(id) || id <= 0) {
			res.status(401).json({ error: 'Unauthorized' })
			return
		}

		res.locals.user = { id, role: effectiveUserRole(session.user.role) }
		next()
	} catch (error) {
		next(error)
	}
}

export function requireRole(...allowed: UserRole[]): RequestHandler[] {
	return [
		requireAuth,
		(_req, res, next) => {
			if (!allowed.includes(currentUser(res).role)) {
				res.status(403).json({ error: 'Forbidden' })
				return
			}
			next()
		},
	]
}
