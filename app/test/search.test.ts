import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOperationsCovered, validateHttpContracts } from './contracts.js'

const baseURL = 'http://127.0.0.1:18004'
const headers = { Origin: baseURL, 'Content-Type': 'application/json' }

type Item = {
	kind: 'file' | 'folder'
	id: number
	name: string
	folderId: number | null
	path: Array<{ id: number; name: string }>
	isDeleted: boolean
}
type Result = { items: Item[]; page: number; limit: number; total: number }

async function startServer(storageRoot: string): Promise<ChildProcess> {
	const server = spawn(process.execPath, ['dist/server.js'], {
		cwd: process.cwd(),
		env: { ...process.env, BETTER_AUTH_URL: baseURL, PORT: '18004', STORAGE_ROOT: storageRoot },
		stdio: 'pipe',
	})
	for (let attempt = 0; attempt < 80; attempt++) {
		if (server.exitCode !== null) throw new Error(`API exited with ${server.exitCode}`)
		try {
			const response = await fetch(`${baseURL}/api/auth/ok`)
			if (response.ok) return server
		} catch {
			/* still starting */
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	server.kill('SIGTERM')
	throw new Error('API did not start')
}

async function stopServer(server: ChildProcess): Promise<void> {
	server.kill('SIGTERM')
	if (server.exitCode === null) await once(server, 'exit')
}

async function register(name: string) {
	const response = await fetch(`${baseURL}/auth/register`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			name,
			email: `${name}-${randomUUID()}@example.com`,
			password: 'Correct-horse-battery-staple',
		}),
	})
	assert.equal(response.status, 200)
	const cookie = response.headers.get('set-cookie')?.split(';')[0]
	assert.ok(cookie)
	return cookie
}

async function folder(cookie: string, name: string, parentFolderId: number | null = null) {
	const response = await fetch(`${baseURL}/folders`, {
		method: 'POST',
		headers: { ...headers, Cookie: cookie },
		body: JSON.stringify({ name, parentFolderId }),
	})
	assert.equal(response.status, 201)
	return ((await response.json()) as { folder: { id: number } }).folder.id
}

async function upload(cookie: string, name: string, folderId: number | null = null) {
	const bytes = Buffer.from(name)
	const response = await fetch(`${baseURL}/files`, {
		method: 'POST',
		headers: {
			Origin: baseURL,
			Cookie: cookie,
			'Content-Type': 'application/octet-stream',
			'X-File-Name': encodeURIComponent(name),
			'X-File-Size': String(bytes.length),
			'X-File-Mime': 'text/plain',
			...(folderId === null ? {} : { 'X-Folder-Id': String(folderId) }),
		},
		body: bytes,
	})
	assert.equal(response.status, 201)
	return ((await response.json()) as { file: { id: number } }).file.id
}

async function search(cookie: string | undefined, params: Record<string, string | number>) {
	const query = new URLSearchParams(
		Object.entries(params).map(([key, value]) => [key, String(value)]),
	)
	return fetch(`${baseURL}/search?${query}`, { headers: cookie ? { Cookie: cookie } : {} })
}

async function found(cookie: string, params: Record<string, string | number>): Promise<Result> {
	const response = await search(cookie, params)
	assert.equal(response.status, 200)
	return (await response.json()) as Result
}

const labels = (result: Result) => result.items.map((item) => `${item.kind}:${item.name}`)

test('search finds owned files and folders across pages and subfolders', async () => {
	const root = await mkdtemp(join(tmpdir(), 'silverbox-search-'))
	const server = await startServer(root)
	try {
		await validateHttpContracts(baseURL)
		const alice = await register('Alice')
		const bob = await register('Bob')

		// Projetos > Clientes > Acme Relatórios; Pessoal
		const projetos = await folder(alice, 'Projetos')
		const clientes = await folder(alice, 'Clientes', projetos)
		const acme = await folder(alice, 'Acme Relatórios', clientes)
		const pessoal = await folder(alice, 'Pessoal')
		const anual = await upload(alice, 'Relatório Anual.pdf')
		await upload(alice, 'notas.txt')
		await upload(alice, 'fotos.zip')
		const lower = await upload(alice, 'relatorio.txt', acme)
		const upper = await upload(alice, 'RELATÓRIO.txt', acme)
		const duplicate = await upload(alice, 'relatorio.txt', pessoal)
		const trashed = await upload(alice, 'relatório lixo.txt', pessoal)
		await upload(alice, '100% pronto.txt')
		await upload(alice, '1000 pronto.txt')
		assert.equal(
			(
				await fetch(`${baseURL}/files/${trashed}`, {
					method: 'DELETE',
					headers: { Origin: baseURL, Cookie: alice },
				})
			).status,
			204,
		)
		const bobFolder = await folder(bob, 'Relatórios do Bob')
		await upload(bob, 'relatorio do bob.txt', bobFolder)

		assert.equal((await search(undefined, { q: 'relatorio' })).status, 401)

		// O arquivo mais antigo da raiz não está na primeira página de /files.
		const firstPage = (await (
			await fetch(`${baseURL}/files?limit=2`, { headers: { Cookie: alice } })
		).json()) as { files: Array<{ id: number }> }
		assert.ok(!firstPage.files.some((file) => file.id === anual))

		// Sem diferenciar caixa nem acentos; pastas primeiro; sem lixeira nem itens de outro usuário.
		const all = await found(alice, { q: 'RELATORIO' })
		assert.equal(all.total, 5)
		assert.deepEqual(labels(all), [
			'folder:Acme Relatórios',
			'file:Relatório Anual.pdf',
			'file:RELATÓRIO.txt',
			'file:relatorio.txt',
			'file:relatorio.txt',
		])
		assert.deepEqual(
			(await found(alice, { q: 'relatório' })).items.map((item) => item.id),
			all.items.map((item) => item.id),
		)
		assert.deepEqual(
			(await found(alice, { q: '  rElAtÓrIo ' })).items.map((item) => item.id),
			all.items.map((item) => item.id),
		)

		// Nomes repetidos aparecem todos, desempatados pelo id.
		const repeated = all.items.filter((item) => item.name === 'relatorio.txt')
		assert.deepEqual(
			repeated.map((item) => item.id),
			[lower, duplicate].sort((a, b) => a - b),
		)
		const findFile = (id: number) =>
			all.items.find((item) => item.kind === 'file' && item.id === id)
		assert.equal(findFile(upper)?.name, 'RELATÓRIO.txt')

		// Local dos resultados.
		const inAcme = findFile(lower)!
		assert.equal(inAcme.folderId, acme)
		assert.deepEqual(
			inAcme.path.map((part) => part.name),
			['Projetos', 'Clientes', 'Acme Relatórios'],
		)
		assert.deepEqual(findFile(anual)?.path, [])
		assert.deepEqual(
			all.items.find((item) => item.kind === 'folder')?.path.map((part) => part.id),
			[projetos, clientes],
		)

		// Lixeira só quando pedida.
		const withTrash = await found(alice, { q: 'relatorio', includeTrash: 'true' })
		assert.equal(withTrash.total, 6)
		assert.equal(
			withTrash.items.find((item) => item.kind === 'file' && item.id === trashed)?.isDeleted,
			true,
		)

		// Escopo da pasta atual inclui subpastas e exclui a própria pasta.
		const scoped = await found(alice, { q: 'relat', scope: 'folder', folderId: projetos })
		assert.deepEqual(labels(scoped), [
			'folder:Acme Relatórios',
			'file:RELATÓRIO.txt',
			'file:relatorio.txt',
		])
		assert.equal((await found(alice, { q: 'acme', scope: 'folder', folderId: acme })).total, 0)
		assert.equal(
			(await search(alice, { q: 'relat', scope: 'folder', folderId: bobFolder })).status,
			404,
		)

		// Filtro por tipo.
		assert.deepEqual(labels(await found(alice, { q: 'relat', type: 'folder' })), [
			'folder:Acme Relatórios',
		])
		assert.equal((await found(alice, { q: 'relat', type: 'file' })).total, 4)

		// Isolamento entre usuários.
		assert.deepEqual(labels(await found(bob, { q: 'relat' })), [
			'folder:Relatórios do Bob',
			'file:relatorio do bob.txt',
		])

		// Paginação estável e total coerente.
		const pages: number[] = []
		for (let page = 1; page <= 3; page++) {
			const result = await found(alice, { q: 'relatorio', limit: 2, page })
			assert.equal(result.total, 5)
			assert.equal(result.page, page)
			assert.equal(result.limit, 2)
			pages.push(...result.items.map((item) => item.id))
		}
		assert.deepEqual(
			pages,
			all.items.map((item) => item.id),
		)
		const beyond = await found(alice, { q: 'relatorio', limit: 2, page: 4 })
		assert.deepEqual(beyond.items, [])
		assert.equal(beyond.total, 5)

		// Sem resultados e curingas literais.
		assert.deepEqual(await found(alice, { q: 'inexistente' }), {
			items: [],
			page: 1,
			limit: 50,
			total: 0,
		})
		assert.deepEqual(labels(await found(alice, { q: '100%' })), ['file:100% pronto.txt'])
		assert.equal((await found(alice, { q: '_' })).total, 0)

		// Validação e limite de tamanho da consulta.
		const invalid: Array<Record<string, string | number>> = [
			{},
			{ q: '   ' },
			{ q: 'x'.repeat(101) },
			{ q: 'a', limit: 101 },
			{ q: 'a', page: 0 },
			{ q: 'a', folderId: projetos },
			{ q: 'a', scope: 'tudo' },
			{ q: 'a', desconhecido: 1 },
		]
		for (const params of invalid)
			assert.equal((await search(alice, params)).status, 400, JSON.stringify(params))

		assertOperationsCovered(['GET /search'])
	} finally {
		await stopServer(server)
		await rm(root, { recursive: true, force: true })
	}
})
