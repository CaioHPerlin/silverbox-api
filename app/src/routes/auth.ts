import { APIError } from 'better-auth/api'
import { fromNodeHeaders } from 'better-auth/node'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { auth } from '../lib/auth.js'
import { env } from '../config/env.js'

export const authRouter = Router()
export const usersRouter = Router()

type AuthResult = { headers: Headers; response: unknown }

function forwardHeaders(res: Response, headers: Headers): void {
	headers.forEach((value, key) => {
		if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value)
	})

	const cookies = headers.getSetCookie()
	if (cookies.length > 0) res.setHeader('set-cookie', cookies)
}

async function sendAuthResult(
	res: Response,
	next: NextFunction,
	operation: () => Promise<AuthResult>,
	respond: (response: unknown) => void = (response) => res.json(response),
): Promise<void> {
	try {
		const result = await operation()
		forwardHeaders(res, result.headers)
		respond(result.response)
	} catch (error) {
		if (error instanceof APIError) {
			forwardHeaders(res, error.headers)
			res.status(error.statusCode).json(error.body)
			return
		}
		next(error)
	}
}

authRouter.post('/register', (req, res, next) =>
	sendAuthResult(res, next, () =>
		auth.api.signUpEmail({
			body: req.body,
			headers: fromNodeHeaders(req.headers),
			returnHeaders: true,
		}),
	),
)

authRouter.post('/login', (req, res, next) =>
	sendAuthResult(res, next, () =>
		auth.api.signInEmail({
			body: req.body,
			headers: fromNodeHeaders(req.headers),
			returnHeaders: true,
		}),
	),
)

authRouter.post('/logout', (req, res, next) =>
	sendAuthResult(res, next, () =>
		auth.api.signOut({
			body: req.body,
			headers: fromNodeHeaders(req.headers),
			returnHeaders: true,
		}),
	),
)

authRouter.get('/google', (req, res, next) =>
	sendAuthResult(
		res,
		next,
		() =>
			auth.api.signInSocial({
				body: { provider: 'google', callbackURL: env.BETTER_AUTH_URL },
				headers: fromNodeHeaders(req.headers),
				returnHeaders: true,
			}),
		(response) => {
			const { url } = response as { url?: string }
			if (!url) {
				res.status(502).json({ error: 'Google sign-in did not return an authorization URL' })
				return
			}
			res.redirect(302, url)
		},
	),
)

usersRouter.get('/me', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
		if (!session) {
			res.status(401).json({ error: 'Unauthorized' })
			return
		}
		res.json({ user: session.user })
	} catch (error) {
		next(error)
	}
})
