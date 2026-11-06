import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

export const smtpConfigured = env.SMTP_HOST !== undefined

const transporter = smtpConfigured
	? nodemailer.createTransport({
			host: env.SMTP_HOST,
			port: env.SMTP_PORT,
			secure: env.SMTP_SECURE,
			requireTLS: !env.SMTP_SECURE,
			auth: {
				user: env.SMTP_USER,
				pass: env.SMTP_PASSWORD,
			},
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 30_000,
		})
	: undefined

export async function sendEmail({
	to,
	subject,
	text,
}: {
	to: string
	subject: string
	text: string
}): Promise<void> {
	if (!transporter || !env.MAIL_FROM) throw new Error('SMTP email delivery is disabled')
	await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text })
}
