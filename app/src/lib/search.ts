import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'

// Profundidade máxima percorrida nas árvores de pastas (escopo e caminho dos resultados).
// Os movimentos já impedem ciclos; o teto só garante que a consulta sempre termina.
const MAX_DEPTH = 64

const intParam = (max: number) =>
	z
		.string()
		.regex(/^\d{1,16}$/, 'Must be a positive integer')
		.transform(Number)
		.pipe(z.number().int().min(1).max(max))

export const searchQuerySchema = z
	.object({
		q: z.string().trim().min(1, 'Search term is required').max(100),
		scope: z.enum(['all', 'folder']).default('all'),
		folderId: intParam(Number.MAX_SAFE_INTEGER).optional(),
		type: z.enum(['all', 'file', 'folder']).default('all'),
		includeTrash: z
			.enum(['true', 'false'])
			.default('false')
			.transform((value) => value === 'true'),
		// page * limit fica limitado a 1.000.000 linhas puladas no OFFSET.
		page: intParam(10_000).default(1),
		limit: intParam(100).default(50),
	})
	.strict()
	.refine((value) => value.scope === 'folder' || value.folderId === undefined, {
		message: 'folderId is only allowed with scope=folder',
		path: ['folderId'],
	})

export type SearchQuery = z.infer<typeof searchQuerySchema>

type Row = {
	total: number
	kind: 'file' | 'folder' | null
	id: number | null
	name: string | null
	folderid: number | null
	sizebytes: bigint | number | string | null
	mimetype: string | null
	isdeleted: boolean | null
	createdat: string | null
	updatedat: string | null
	path: Array<{ id: number; name: string }> | string | null
}

export type SearchItem = {
	kind: 'file' | 'folder'
	id: number
	name: string
	folderId: number | null
	path: Array<{ id: number; name: string }>
	sizeBytes: number | null
	mimeType: string | null
	isDeleted: boolean
	createdAt: string
	updatedAt: string
}

const key = (column: Prisma.Sql) => Prisma.sql`"silverbox_api"."search_key"(${column})`
const iso = (column: Prisma.Sql) => Prisma.sql`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/**
 * Busca arquivos e pastas do usuário por trecho do nome.
 *
 * - Comparação sem diferenciar maiúsculas nem acentos ("relatorio" encontra "Relatório").
 * - `%`, `_` e `\` no termo são literais.
 * - scope=all: todas as pastas do usuário. scope=folder: a pasta informada (ou a raiz) e
 *   todas as subpastas dela; a própria pasta não aparece no resultado.
 * - Arquivos na lixeira ou ainda não concluídos ficam de fora, salvo includeTrash=true
 *   (lixeira). Pastas não têm lixeira.
 * - Ordem estável e igual em qualquer locale do banco: pastas antes de arquivos, depois nome
 *   normalizado, nome original (byte a byte) e id.
 * - Filtra, conta e pagina no banco em uma única consulta.
 */
export async function searchItems(owner: number, query: SearchQuery) {
	const pattern = Prisma.sql`'%' || replace(replace(replace(${key(Prisma.sql`${query.q}`)}, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`
	const scoped = query.scope === 'folder' && query.folderId !== undefined
	const inScope = (column: Prisma.Sql) =>
		scoped ? Prisma.sql`AND ${column} IN (SELECT id FROM scope)` : Prisma.empty
	const offset = (query.page - 1) * query.limit

	const folders = Prisma.sql`
		SELECT 'folder'::text AS kind, d.id, d.name::text AS name, d.parentfolderid AS folderid,
			NULL::bigint AS sizebytes, NULL::text AS mimetype, false AS isdeleted,
			d.createdat, d.updatedat, ${key(Prisma.sql`d.name`)} AS sort_key
		FROM "silverbox_api"."folders" d
		WHERE d.userid = ${owner}
			AND ${key(Prisma.sql`d.name`)} LIKE ${pattern}
			${inScope(Prisma.sql`d.parentfolderid`)}`
	const files = Prisma.sql`
		SELECT 'file'::text AS kind, f.id, f.originalname::text AS name, f.folderid,
			f.sizebytes, f.mimetype::text AS mimetype, f.isdeleted,
			f.createdat, f.updatedat, ${key(Prisma.sql`f.originalname`)} AS sort_key
		FROM "silverbox_api"."files" f
		WHERE f.userid = ${owner}
			AND f.status = 'ready'
			${query.includeTrash ? Prisma.empty : Prisma.sql`AND f.isdeleted = false`}
			AND ${key(Prisma.sql`f.originalname`)} LIKE ${pattern}
			${inScope(Prisma.sql`f.folderid`)}`
	const branches =
		query.type === 'folder'
			? folders
			: query.type === 'file'
				? files
				: Prisma.sql`${folders} UNION ALL ${files}`

	const rows = await prisma.$queryRaw<Row[]>`
		WITH RECURSIVE
		scope AS (
			SELECT id, 0 AS depth FROM "silverbox_api"."folders"
			WHERE ${scoped ? Prisma.sql`id = ${query.folderId!} AND userid = ${owner}` : Prisma.sql`false`}
			UNION ALL
			SELECT child.id, scope.depth + 1
			FROM "silverbox_api"."folders" child
			JOIN scope ON child.parentfolderid = scope.id
			WHERE child.userid = ${owner} AND scope.depth < ${MAX_DEPTH}
		),
		matches AS (${branches}),
		page AS (
			SELECT matches.*, row_number() OVER (
				ORDER BY (kind = 'file'), sort_key COLLATE "C", name COLLATE "C", id
			) AS position
			FROM matches
			ORDER BY (kind = 'file'), sort_key COLLATE "C", name COLLATE "C", id
			LIMIT ${query.limit} OFFSET ${offset}
		),
		ancestors AS (
			SELECT page.kind, page.id AS item_id, a.id, a.name::text AS name, a.parentfolderid, 1 AS depth
			FROM page
			JOIN "silverbox_api"."folders" a ON a.id = page.folderid AND a.userid = ${owner}
			UNION ALL
			SELECT ancestors.kind, ancestors.item_id, a.id, a.name::text, a.parentfolderid, ancestors.depth + 1
			FROM ancestors
			JOIN "silverbox_api"."folders" a ON a.id = ancestors.parentfolderid AND a.userid = ${owner}
			WHERE ancestors.depth < ${MAX_DEPTH}
		)
		SELECT
			counted.total,
			page.kind, page.id, page.name, page.folderid, page.sizebytes, page.mimetype, page.isdeleted,
			${iso(Prisma.sql`page.createdat`)} AS createdat,
			${iso(Prisma.sql`page.updatedat`)} AS updatedat,
			COALESCE((
				SELECT json_agg(json_build_object('id', ancestors.id, 'name', ancestors.name) ORDER BY ancestors.depth DESC)
				FROM ancestors
				WHERE ancestors.kind = page.kind AND ancestors.item_id = page.id
			), '[]'::json) AS path
		FROM (SELECT count(*)::int AS total FROM matches) counted
		LEFT JOIN page ON true
		ORDER BY page.position`

	const total = Number(rows[0]?.total ?? 0)
	const items: SearchItem[] = rows
		.filter((row) => row.kind !== null && row.id !== null)
		.map((row) => ({
			kind: row.kind!,
			id: Number(row.id),
			name: row.name!,
			folderId: row.folderid === null ? null : Number(row.folderid),
			path: typeof row.path === 'string' ? JSON.parse(row.path) : (row.path ?? []),
			sizeBytes: row.sizebytes === null ? null : Number(row.sizebytes),
			mimeType: row.mimetype,
			isDeleted: Boolean(row.isdeleted),
			createdAt: row.createdat!,
			updatedAt: row.updatedat!,
		}))
	return { items, total }
}
