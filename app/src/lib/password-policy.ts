export const minPasswordLength = 8
export const maxPasswordLength = 128

export function newPasswordError(password: string) {
	if (password.length > maxPasswordLength) {
		return { code: 'PASSWORD_TOO_LONG', message: `Use no máximo ${maxPasswordLength} caracteres.` }
	}
	if (Array.from(password).length < minPasswordLength) {
		return { code: 'PASSWORD_TOO_SHORT', message: `Use pelo menos ${minPasswordLength} caracteres.` }
	}
	if (!/\p{Lu}/u.test(password)) {
		return { code: 'PASSWORD_MISSING_UPPERCASE', message: 'Use pelo menos uma letra maiúscula.' }
	}
	if (!/[\p{P}\p{S}]/u.test(password)) {
		return { code: 'PASSWORD_MISSING_SYMBOL', message: 'Use pelo menos um símbolo, como @, ! ou #.' }
	}
	return null
}
