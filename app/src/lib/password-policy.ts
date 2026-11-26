export const minPasswordLength = 15
export const maxPasswordLength = 128

const commonPasswords = new Set([
	'0123456789012345',
	'123456789012345',
	'1234567890123456',
	'987654321098765',
	'administrador123',
	'password123456789',
	'passwordpassword',
	'qwertyuiopasdfgh',
	'qwertyuiopasdfghjkl',
	'senha1234567890',
	'silverbox123456',
])

export function newPasswordError(password: string) {
	if (password.length > maxPasswordLength) {
		return { code: 'PASSWORD_TOO_LONG', message: `Use no máximo ${maxPasswordLength} caracteres.` }
	}
	if (Array.from(password).length < minPasswordLength) {
		return { code: 'PASSWORD_TOO_SHORT', message: `Use pelo menos ${minPasswordLength} caracteres.` }
	}
	const normalized = password.normalize('NFKC').trim().toLowerCase()
	if (!normalized || commonPasswords.has(normalized) || /^(.)\1*$/su.test(normalized)) {
		return {
			code: 'PASSWORD_TOO_COMMON',
			message: 'Essa senha é muito comum ou previsível. Escolha uma frase mais difícil de adivinhar.',
		}
	}
	return null
}
