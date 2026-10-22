# Validação CI/CD — 22/10/2026

- API `main`: merge fast-forward de `feature/local-file-management`, SHA `d76c3b8`; push concluído e CI anterior aprovado no GitHub.
- Branches `feature/ci-cd` criadas nos dois repositórios.
- Oracle inspecionada por `ssh dock` (config explícita para contornar erro de permissões da configuração SSH global): Ubuntu24.04, aarch64, Docker29, ~35GiB livres, Traefik nas portas80/443 e rede `traefik`. Nenhum serviço existente alterado.
- Diretórios privados `/home/perlin/silverbox/{api,web}` criados. Duas chaves SSH exclusivas testadas com sucesso; segredos gravados nos ambientes `oracle`. Chaves privadas temporárias removidas.
- `actionlint` passou nos quatro workflows; `bash -n`, `sh -n` e `docker compose config --quiet` passaram nos arquivos de deploy.
- Web: build pnpm passou; lint sem erros (quatro avisos existentes de React Hook Form); Docker passou: `/health`200, rota React direta200, runtime-config sem cache, asset inexistente404, UID101, URL insegura rejeitada. Testes somente `.ts`.
- npm ci/build isolados passaram; npm audit não apontou vulnerabilidades após correção de Vite/brace-expansion/source-map-js. Versões corrigidas também fixadas para pnpm.

Os testes ARM64 de publicação, saúde e rollback são executados no job de publicação. A validação pública HTTPS/Google na Oracle depende dos domínios reais e ainda não foi executada. `ORACLE_READY` fica desabilitado enquanto essa configuração está pendente. Não há alegação de deploy público concluído.

## Endpoint → corpo → resposta (web Docker observado)

### GET /health
Corpo: nenhum.
Resposta: HTTP200, `ok\n`.

### GET /runtime-config.js
Corpo: nenhum. Ambiente de teste: `API_URL=https://api.silverbox.test`.
Resposta: HTTP200, `window.__SILVERBOX_CONFIG__ = {"apiUrl":"https://api.silverbox.test"};`; Cache-Control `no-store`.

### GET /arquivos
Corpo: nenhum.
Resposta: HTTP200, mesmo HTML de `/`, carregando o bundle React. Isto valida fallback SPA, não a integração de arquivos da tela.

### GET /assets/missing.js
Corpo: nenhum.
Resposta: HTTP404, sem devolver HTML como JavaScript.

Os contratos e resultados de todos os endpoints da API permanecem em `dados/arquivos.md` e `dados/validacao-2026-10-22.md`, mergeados em main. As rotas da API não foram alteradas no branch CI/CD.
