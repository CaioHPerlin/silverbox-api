// Roteiro completo de testes da Silverbox API, executado contra uma API no ar.
//
// Uso (Node 24, sem instalar dependências):
//   node scripts/roteiro-api.ts                       # API local em http://localhost:8000
//   API_URL=https://api.silverbox.perlin.com.br node scripts/roteiro-api.ts --producao
//
// Cria contas de teste (<uuid>@example.com) e apaga ao final as pastas, arquivos,
// versões e links que criou. As contas permanecem: a API não tem rota de exclusão.
// Sai com código 1 se alguma verificação falhar.

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const base = (process.env.API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)
if (!isLocal && !process.argv.includes('--producao')) {
	console.error(`${base} não é local. Para rodar contra ela, acrescente --producao.`)
	console.error('Atenção: o roteiro cria duas contas de teste nessa API.')
	process.exit(2)
}

const run = randomUUID().slice(0, 8)
const password = `roteiro-${randomUUID()}`
const users = {
	a: { name: 'Roteiro A', email: `roteiro-a-${run}@example.com`, cookie: '' },
	b: { name: 'Roteiro B', email: `roteiro-b-${run}@example.com`, cookie: '' },
}

type Result = { etapa: string; teste: string; esperado: string; obtido: string; ok: boolean }
const results: Result[] = []
let etapa = ''

function section(name: string): void {
	etapa = name
	console.log(`\n== ${name}`)
}

function check(teste: string, esperado: unknown, obtido: unknown, ok = esperado === obtido): boolean {
	results.push({ etapa, teste, esperado: String(esperado), obtido: String(obtido), ok })
	console.log(`  ${ok ? 'OK  ' : 'FALHOU'}  ${teste} (esperado ${esperado}, obtido ${obtido})`)
	return ok
}

type Options = { cookie?: string; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }

async function call(method: string, path: string, options: Options = {}) {
	const headers: Record<string, string> = { Origin: base, ...options.headers }
	if (options.cookie) headers.Cookie = options.cookie
	let body: BodyInit | undefined
	if (options.json !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.json)
	} else if (options.bytes) {
		headers['Content-Type'] = 'application/octet-stream'
		body = options.bytes
	}
	const res = await fetch(base + path, { method, headers, body, redirect: 'manual' })
	const raw = Buffer.from(await res.arrayBuffer())
	let data: any = null
	if ((res.headers.get('content-type') ?? '').includes('application/json') && raw.length > 0) {
		data = JSON.parse(raw.toString('utf8'))
	}
	return { status: res.status, headers: res.headers, data, raw }
}

function sessionCookie(headers: Headers): string {
	const header = headers.getSetCookie().find((value) => value.includes('session_token'))
	return header ? header.split(';')[0]! : ''
}

function uploadHeaders(name: string, size: number, folderId?: number): Record<string, string> {
	const headers: Record<string, string> = {
		'X-File-Name': encodeURIComponent(name),
		'X-File-Size': String(size),
		'X-File-Mime': 'text/plain',
	}
	if (folderId) headers['X-Folder-Id'] = String(folderId)
	return headers
}

const original = new TextEncoder().encode(`roteiro ${run} - versão 1\n`)
const updated = new TextEncoder().encode(`roteiro ${run} - versão 2, com mais texto\n`)
const created = { folders: [] as number[], files: [] as number[] }

async function main(): Promise<void> {
	console.log(`Roteiro de testes — ${base} — execução ${run}`)

	section('1. Infraestrutura')
	check('GET / responde', 200, (await call('GET', '/')).status)
	check('GET /health/live responde', 200, (await call('GET', '/health/live')).status)
	check('GET /health/ready (banco e armazenamento)', 200, (await call('GET', '/health/ready')).status)
	check('GET /docs (Swagger) responde', 200, (await call('GET', '/docs/')).status)
	check('GET /docs.json responde', 200, (await call('GET', '/docs.json')).status)
	check(
		'Origem não autorizada é recusada',
		403,
		(await call('GET', '/users/me', { headers: { Origin: 'https://nao-autorizado.example' } })).status,
	)
	const preflight = await call('OPTIONS', '/files', {
		headers: { 'Access-Control-Request-Method': 'POST' },
	})
	check('Preflight CORS do upload', 204, preflight.status)
	check(
		'Preflight libera credenciais',
		'true',
		preflight.headers.get('access-control-allow-credentials'),
	)
	check('Rota inexistente', 404, (await call('GET', '/rota-que-nao-existe')).status)

	section('2. Cadastro e login: casos de erro')
	check(
		'Cadastro com senha curta',
		400,
		(await call('POST', '/auth/register', { json: { name: 'x', email: `curta-${run}@example.com`, password: '123' } })).status,
	)
	check(
		'Cadastro com e-mail inválido',
		400,
		(await call('POST', '/auth/register', { json: { name: 'x', email: 'nao-e-email', password } })).status,
	)
	check(
		'Cadastro sem nome',
		400,
		(await call('POST', '/auth/register', { json: { email: `sem-nome-${run}@example.com`, password } })).status,
	)
	check(
		'Login de e-mail inexistente',
		401,
		(await call('POST', '/auth/login', { json: { email: `inexistente-${run}@example.com`, password } })).status,
	)
	check('GET /users/me sem sessão', 401, (await call('GET', '/users/me')).status)
	check('GET /folders sem sessão', 401, (await call('GET', '/folders')).status)

	section('3. Cadastro, sessão e logout')
	for (const user of Object.values(users)) {
		const res = await call('POST', '/auth/register', { json: { name: user.name, email: user.email, password } })
		check(`Cadastro de ${user.name}`, 200, res.status)
		user.cookie = sessionCookie(res.headers)
		check(`Cookie de sessão de ${user.name} recebido`, true, user.cookie !== '')
	}
	if (!users.a.cookie || !users.b.cookie) throw new Error('Sem sessão: o restante do roteiro depende do cadastro.')
	check(
		'Cadastro com e-mail repetido',
		422,
		(await call('POST', '/auth/register', { json: { name: 'x', email: users.a.email, password } })).status,
	)
	const me = await call('GET', '/users/me', { cookie: users.a.cookie })
	check('GET /users/me com sessão', 200, me.status)
	check('/users/me devolve o e-mail certo', users.a.email, me.data?.user?.email)
	check('Logout', 200, (await call('POST', '/auth/logout', { cookie: users.a.cookie, json: {} })).status)
	check('Sessão encerrada após logout', 401, (await call('GET', '/users/me', { cookie: users.a.cookie })).status)
	check(
		'Login com senha errada',
		401,
		(await call('POST', '/auth/login', { json: { email: users.a.email, password: 'senha-errada-123' } })).status,
	)
	const login = await call('POST', '/auth/login', { json: { email: users.a.email, password } })
	check('Login com senha certa', 200, login.status)
	users.a.cookie = sessionCookie(login.headers)
	const a = users.a.cookie
	const b = users.b.cookie

	section('4. Pastas')
	const parent = await call('POST', '/folders', { cookie: a, json: { name: `Roteiro ${run}` } })
	check('Criar pasta na raiz', 201, parent.status)
	const parentId: number = parent.data?.folder?.id
	if (parentId) created.folders.push(parentId)
	const child = await call('POST', '/folders', { cookie: a, json: { name: 'Subpasta', parentFolderId: parentId } })
	check('Criar subpasta', 201, child.status)
	const childId: number = child.data?.folder?.id
	if (childId) created.folders.unshift(childId)
	check('Criar pasta com nome vazio', 400, (await call('POST', '/folders', { cookie: a, json: { name: '' } })).status)
	const root = await call('GET', '/folders', { cookie: a })
	check('Listar raiz mostra a pasta', true, root.data?.folders?.some((f: any) => f.id === parentId) ?? false)
	const children = await call('GET', `/folders?parentFolderId=${parentId}`, { cookie: a })
	check('Listar subpastas mostra a subpasta', true, children.data?.folders?.some((f: any) => f.id === childId) ?? false)
	const renamed = await call('PATCH', `/folders/${childId}`, { cookie: a, json: { name: 'Subpasta renomeada' } })
	check('Renomear pasta', 200, renamed.status)
	check(
		'Mover pasta para dentro da própria subpasta',
		409,
		(await call('PATCH', `/folders/${parentId}`, { cookie: a, json: { parentFolderId: childId } })).status,
	)
	check('Excluir pasta com subpasta', 409, (await call('DELETE', `/folders/${parentId}`, { cookie: a })).status)
	check('Outro usuário não vê a pasta', 404, (await call('GET', `/folders?parentFolderId=${parentId}`, { cookie: b })).status)

	section('5. Upload, consulta e download')
	const upload = await call('POST', '/files', {
		cookie: a,
		bytes: original,
		headers: uploadHeaders(`roteiro ${run}.txt`, original.length, childId),
	})
	check('Upload na subpasta', 201, upload.status)
	const fileId: number = upload.data?.file?.id
	if (fileId) created.files.push(fileId)
	check(
		'Upload com X-File-Size diferente do conteúdo',
		400,
		(await call('POST', '/files', { cookie: a, bytes: original, headers: uploadHeaders('errado.txt', original.length + 5) })).status,
	)
	check(
		'Upload sem X-File-Name',
		400,
		(await call('POST', '/files', { cookie: a, bytes: original, headers: { 'X-File-Size': String(original.length) } })).status,
	)
	const list = await call('GET', `/files?folderId=${childId}`, { cookie: a })
	check('Listar arquivos da subpasta', 200, list.status)
	check('Lista mostra o arquivo enviado', true, list.data?.files?.some((f: any) => f.id === fileId) ?? false)
	const meta = await call('GET', `/files/${fileId}`, { cookie: a })
	check('Consultar metadados', 200, meta.status)
	check('Nome do arquivo preservado', `roteiro ${run}.txt`, meta.data?.file?.originalName)
	const download = await call('GET', `/files/${fileId}/download`, { cookie: a })
	check('Download', 200, download.status)
	check('Conteúdo baixado igual ao enviado', true, download.raw.equals(Buffer.from(original)))
	check(
		'Download vem como anexo',
		true,
		(download.headers.get('content-disposition') ?? '').startsWith('attachment'),
	)
	check('Outro usuário não acessa o arquivo', 404, (await call('GET', `/files/${fileId}`, { cookie: b })).status)
	check('Outro usuário não baixa o arquivo', 404, (await call('GET', `/files/${fileId}/download`, { cookie: b })).status)
	check(
		'Renomear e mover arquivo para a raiz',
		200,
		(await call('PATCH', `/files/${fileId}`, { cookie: a, json: { originalName: `renomeado ${run}.txt`, folderId: null } })).status,
	)
	check('Excluir pasta que agora está vazia', 204, (await call('DELETE', `/folders/${childId}`, { cookie: a })).status)
	created.folders = created.folders.filter((id) => id !== childId)
	const usage = await call('GET', '/storage/usage', { cookie: a })
	check('Consultar uso de armazenamento', 200, usage.status)
	check('Uso vem como texto numérico', true, /^\d+$/.test(String(usage.data?.usedBytes)))

	section('6. Versões')
	const version = await call('POST', `/files/${fileId}/versions`, {
		cookie: a,
		bytes: updated,
		headers: uploadHeaders(`renomeado ${run}.txt`, updated.length),
	})
	check('Enviar nova versão', 201, version.status)
	check('Nova versão é a de número 2', 2, version.data?.version?.versionNumber)
	const versions = await call('GET', `/files/${fileId}/versions`, { cookie: a })
	check('Histórico tem 2 versões', 2, versions.data?.versions?.length)
	const first = versions.data?.versions?.find((v: any) => v.versionNumber === 1)
	const current = await call('GET', `/files/${fileId}/download`, { cookie: a })
	check('Download atual traz a versão 2', true, current.raw.equals(Buffer.from(updated)))
	const old = await call('GET', `/files/${fileId}/versions/${first?.id}/download`, { cookie: a })
	check('Download da versão 1', true, old.status === 200 && old.raw.equals(Buffer.from(original)))
	const restore = await call('POST', `/files/${fileId}/versions/${first?.id}/restore`, { cookie: a })
	check('Restaurar versão 1 (vira a versão 3)', 3, restore.data?.version?.versionNumber)
	const afterRestore = await call('GET', `/files/${fileId}/download`, { cookie: a })
	check('Download atual volta ao conteúdo original', true, afterRestore.raw.equals(Buffer.from(original)))

	section('7. Links de compartilhamento')
	check(
		'Criar link com prazo menor que 60 s',
		400,
		(await call('POST', `/files/${fileId}/shares`, { cookie: a, json: { expiresInSeconds: 30 } })).status,
	)
	const share = await call('POST', `/files/${fileId}/shares`, { cookie: a, json: { expiresInSeconds: 600 } })
	check('Criar link de 10 minutos', 201, share.status)
	const sharePath = share.data?.url ? new URL(share.data.url).pathname : '/shares/invalido'
	const publicDownload = await fetch(base + sharePath)
	const publicBytes = Buffer.from(await publicDownload.arrayBuffer())
	check('Baixar pelo link sem login', true, publicDownload.status === 200 && publicBytes.equals(Buffer.from(original)))
	const shares = await call('GET', `/files/${fileId}/shares`, { cookie: a })
	check('Listar links', 200, shares.status)
	check('Lista não revela o token', false, JSON.stringify(shares.data).includes(sharePath.split('/').pop()!))
	check('Link com token inválido', 404, (await fetch(`${base}/shares/token-invalido-${run}`)).status)
	check('Revogar link', 204, (await call('DELETE', `/files/${fileId}/shares/${share.data?.id}`, { cookie: a })).status)
	check('Link revogado não funciona', 410, (await fetch(base + sharePath)).status)
	const second = await call('POST', `/files/${fileId}/shares`, { cookie: a, json: {} })
	check('Criar outro link (prazo padrão)', 201, second.status)

	section('8. Lixeira')
	check('Mover para a lixeira', 204, (await call('DELETE', `/files/${fileId}`, { cookie: a })).status)
	check(
		'Link deixa de funcionar com o arquivo na lixeira',
		410,
		(await fetch(base + new URL(second.data?.url ?? `${base}/x`).pathname)).status,
	)
	const trash = await call('GET', '/files/trash', { cookie: a })
	check('Lixeira mostra o arquivo', true, trash.data?.files?.some((f: any) => f.id === fileId) ?? false)
	check('Restaurar da lixeira', 200, (await call('POST', `/files/${fileId}/restore`, { cookie: a })).status)
	const notInTrash = (await call('DELETE', `/files/${fileId}/permanent`, { cookie: a })).status
	check('Excluir de vez fora da lixeira é recusado', '4xx', notInTrash, notInTrash >= 400 && notInTrash < 500)
	check('Mover para a lixeira de novo', 204, (await call('DELETE', `/files/${fileId}`, { cookie: a })).status)
	const permanent = await call('DELETE', `/files/${fileId}/permanent`, { cookie: a })
	check('Excluir definitivamente', true, permanent.status === 204 || permanent.status === 202)
	if (permanent.status === 204 || permanent.status === 202) created.files = []
	const trashAfter = await call('GET', '/files/trash', { cookie: a })
	check('Lixeira não mostra mais o arquivo', false, trashAfter.data?.files?.some((f: any) => f.id === fileId) ?? false)
	check('Excluir a pasta de teste', 204, (await call('DELETE', `/folders/${parentId}`, { cookie: a })).status)
	created.folders = created.folders.filter((id) => id !== parentId)

	section('9. Encerramento')
	for (const user of Object.values(users)) {
		check(`Logout de ${user.name}`, 200, (await call('POST', '/auth/logout', { cookie: user.cookie, json: {} })).status)
	}
}

async function cleanup(): Promise<void> {
	const cookie = users.a.cookie
	if (!cookie) return
	for (const id of created.files) {
		await call('DELETE', `/files/${id}`, { cookie })
		await call('DELETE', `/files/${id}/permanent`, { cookie })
	}
	for (const id of created.folders) await call('DELETE', `/folders/${id}`, { cookie })
}

try {
	await main()
} catch (error) {
	check('Roteiro executado até o fim', 'sem exceção', (error as Error).message, false)
} finally {
	await cleanup().catch(() => undefined)
}

const failed = results.filter((r) => !r.ok)
console.log(`\nResultado: ${results.length - failed.length} de ${results.length} verificações passaram.`)
for (const r of failed) console.log(`  FALHOU [${r.etapa}] ${r.teste}: esperado ${r.esperado}, obtido ${r.obtido}`)
console.log(`Contas de teste criadas: ${users.a.email}, ${users.b.email}`)

const report = process.env.ROTEIRO_RELATORIO
if (report) {
	await writeFile(report, JSON.stringify({ base, run, at: new Date().toISOString(), results }, null, 2) + '\n')
	console.log(`Relatório salvo em ${report}`)
}
process.exit(failed.length > 0 ? 1 : 0)
