# Busca por nome (`GET /search`)

Issue: [#28](https://github.com/CaioHPerlin/silverbox-api/issues/28)

## Contrato

`GET /search?q=<termo>&scope=all|folder&folderId=<id>&type=all|file|folder&includeTrash=false&page=1&limit=50`

| Parâmetro | Padrão | Regra |
| --- | --- | --- |
| `q` | obrigatório | 1 a 100 caracteres após remover espaços das pontas |
| `scope` | `all` | `all`: todas as pastas do usuário. `folder`: `folderId` (ou a raiz, se omitido) **e todas as subpastas**; a própria pasta não aparece no resultado |
| `folderId` | — | Somente com `scope=folder`; pasta de outro usuário ou inexistente responde 404 |
| `type` | `all` | Restringe a arquivos ou pastas |
| `includeTrash` | `false` | `true` inclui arquivos da lixeira (`isDeleted: true`). Pastas não têm lixeira |
| `page` | `1` | 1 a 10000 |
| `limit` | `50` | 1 a 100 |

Resposta: `{ items, page, limit, total }`. Cada item traz `kind` (`file`/`folder`), `id`, `name`,
`folderId` (pasta onde está; para pastas, a pasta-mãe), `path` (pastas da raiz até o local do item,
sem incluir o próprio item), `sizeBytes` e `mimeType` (`null` em pastas), `isDeleted`, `createdAt` e `updatedAt`.

Comportamento:

- Sem diferenciar maiúsculas nem acentos: `relatorio`, `RELATÓRIO` e `Relatório` são equivalentes
  (`unaccent` + `lower`, na função `silverbox_api.search_key`).
- `%`, `_` e `\` no termo são literais, não curingas.
- Apenas itens do usuário da sessão; arquivos ainda não concluídos (`status <> 'ready'`) nunca aparecem.
- Ordem estável e igual em qualquer locale do banco (`COLLATE "C"`): pastas antes de arquivos,
  depois nome normalizado, nome original e `id`.
  Itens com o mesmo nome aparecem todos, desempatados pelo `id`.
- Filtro, contagem e paginação acontecem no banco, em uma única consulta. `total` é coerente com a página.
- Página além do fim responde `items: []` com o `total` real.

## Índices e medição

Migração `20261116000000_name_search`: extensões `unaccent`, `pg_trgm` e `btree_gin` e índices GIN em
`(userid, search_key(nome) gin_trgm_ops)` para `folders` e para os arquivos ativos de `files`.

Conjunto medido (PostgreSQL 16 local, `EXPLAIN ANALYZE`, mediana de 6 execuções, `limit=20`):
200 usuários, 1.095.000 arquivos (5% na lixeira) e 24.900 pastas. Um usuário "pesado" tem 100 mil
arquivos em 5 mil pastas; os demais têm 5 mil arquivos. Os nomes repetem 8 palavras com acentos
mais um sufixo aleatório, então `relat` casa 1/8 dos arquivos (pior caso realista).

| Consulta | Sem índice de busca | Trigram só no nome | Trigram + `userid` (adotado) |
| --- | ---: | ---: | ---: |
| Usuário pesado, `relat` (10.708 resultados), página 1 | 134 ms | 450 ms | **75 ms** |
| Usuário pesado, `relat`, página 50 | — | 367 ms | **68 ms** |
| Usuário pesado, termo raro `a1b` | 109 ms | 16 ms | **2 ms** |
| Usuário pesado, `orcamento` com `scope=folder` | — | 411 ms | **41 ms** |
| Usuário típico (5 mil), `relat` | — | 383 ms | **4 ms** |
| Usuário típico, sem resultados | — | 14 ms | **0,4 ms** |
| Usuário pesado, `fo` (2 caracteres, sem trigramas) | 146 ms | 153 ms | 146 ms |

O índice só de trigramas era pior que nenhum índice para termos comuns, porque devolvia as
correspondências de todos os usuários antes de filtrar pelo dono. Com `userid` dentro do índice GIN
(`btree_gin`), a varredura fica restrita ao usuário. Termos de 1 ou 2 caracteres não usam o índice
de trigramas e varrem os itens ativos do usuário; o front espera 300 ms de pausa na digitação antes de consultar.
O índice de `files` ocupa cerca de 80 MB para 1,1 milhão de linhas.
