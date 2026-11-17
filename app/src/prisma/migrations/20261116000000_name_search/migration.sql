-- Busca por nome parcial (GET /search).
-- unaccent, pg_trgm e btree_gin são extensões "trusted" desde o PostgreSQL 13: o dono do banco
-- consegue instalá-las sem superusuário. Ficam em public, fora do schema gerenciado pelo Prisma.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;

-- Chave de comparação: sem acentos e em minúsculas. unaccent() é STABLE porque o dicionário
-- poderia mudar; fixando o dicionário pelo nome qualificado, a função pode ser IMMUTABLE e,
-- portanto, usada em índice. A API usa exatamente esta função no WHERE para casar com o índice.
CREATE OR REPLACE FUNCTION "silverbox_api"."search_key"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, value)) $$;

-- Índices GIN com o dono + trigramas do nome normalizado: LIKE '%termo%' (3+ caracteres)
-- percorre só as entradas do usuário. Sem userid no índice, um termo comum varria as
-- correspondências de todos os usuários (medição em dados/busca-por-nome.md).
-- Termos com 1-2 caracteres não geram trigramas e usam os índices por usuário já existentes.
-- Índices de expressão não são representáveis no schema.prisma: ao gerar migrações com
-- `prisma migrate dev`, confira se elas não removem estes índices.
CREATE INDEX IF NOT EXISTS "folders_name_search_trgm_idx"
	ON "silverbox_api"."folders"
	USING gin ("userid", "silverbox_api"."search_key"("name") public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "files_originalname_search_trgm_idx"
	ON "silverbox_api"."files"
	USING gin ("userid", "silverbox_api"."search_key"("originalname") public.gin_trgm_ops)
	WHERE "isdeleted" = false AND "status" = 'ready';
