export const passwordResetTtlMinutes = 15

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

export function passwordResetEmail(name: string, url: string) {
	const subject = 'Redefina sua senha do Silverbox'
	const greeting = `Olá, ${name}!`
	const action = 'Redefinir senha'
	const instructions = 'Recebemos um pedido para redefinir a senha da sua conta Silverbox.'
	const expiry = `O link expira em ${passwordResetTtlMinutes} minutos e só pode ser usado uma vez.`
	const notice = 'Se você não solicitou a troca, pode ignorar este e-mail.'

	return {
		subject,
		text: `${greeting}\n\n${instructions}\n\n${action}: ${url}\n\n${expiry}\n\n${notice}\n`,
		html: `<!doctype html>
<html lang="pt-BR" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${subject}</title>
</head>
<body style="margin:0;background-color:#09090b">
  <div lang="pt-BR" dir="ltr" style="display:none;max-height:0;overflow:hidden;mso-hide:all">O link para criar sua nova senha expira em ${passwordResetTtlMinutes} minutos.</div>
  <table lang="pt-BR" dir="ltr" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#09090b">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background-color:#18181b;border:1px solid #3f3f46;border-radius:16px">
        <tr><td style="padding:28px 24px;color:#fafafa;font-family:Arial,sans-serif">
          <p style="margin:0 0 24px;color:#9bc0fb;font-size:16px;font-weight:700;line-height:24px">Silverbox</p>
          <h1 style="margin:0 0 16px;font-size:26px;line-height:32px">Crie uma nova senha</h1>
          <p style="margin:0 0 8px;color:#e4e4e7;font-size:16px;line-height:24px">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 20px;color:#e4e4e7;font-size:16px;line-height:24px">${instructions}</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr><td align="center" bgcolor="#5c93e6" style="border-radius:8px">
              <a href="${escapeHtml(url)}" style="display:block;border:1px solid #5c93e6;border-radius:8px;padding:12px 16px;color:#09090b;font-size:16px;font-weight:700;line-height:24px;text-decoration:none">${action}</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#d4d4d8;font-size:16px;line-height:24px">${expiry}</p>
          <p style="margin:24px 0 0;border-top:1px solid #3f3f46;padding-top:16px;color:#a1a1aa;font-size:16px;line-height:24px">${notice}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
	}
}
