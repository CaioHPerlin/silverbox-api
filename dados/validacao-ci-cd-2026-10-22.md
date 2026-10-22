# Validação CI/CD — 22/10/2026

- API `main`: merge fast-forward de `feature/local-file-management`, SHA `d76c3b8`; push concluído e CI anterior aprovado no GitHub.
- Branches `feature/ci-cd` criadas nos dois repositórios.
- Oracle inspecionada por `ssh dock` (config explícita para contornar erro de permissões da configuração SSH global): Ubuntu24.04, aarch64, Docker29, ~35GiB livres, Traefik nas portas80/443 e rede `traefik`. Nenhum serviço existente alterado.
- Diretórios privados `/home/perlin/silverbox/{api,web}` criados. Duas chaves SSH exclusivas testadas com sucesso; segredos gravados nos ambientes `oracle`. Chaves privadas temporárias removidas.
- `actionlint` passou nos quatro workflows; `bash -n`, `sh -n` e `docker compose config --quiet` passaram nos arquivos de deploy.
- Web: build pnpm passou; lint sem erros (quatro avisos existentes de React Hook Form); Docker passou: `/health`200, rota React direta200, runtime-config sem cache, asset inexistente404, UID101, URL insegura rejeitada. Testes somente `.ts`.
- npm ci/build isolados passaram; npm audit não apontou vulnerabilidades após correção de Vite/brace-expansion/source-map-js. Versões corrigidas também fixadas para pnpm.

Os testes ARM64 de publicação, saúde e rollback passaram no runner GitHub e foram repetidos com sucesso em projetos Compose privados e descartáveis na Oracle. A validação pública HTTPS/Google na Oracle depende dos domínios reais e ainda não foi executada. `ORACLE_READY` fica desabilitado enquanto essa configuração está pendente. Não há alegação de deploy público concluído.

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

## Execução no dock

Os testes privados usam o mesmo Compose e script de release de produção, com nome de projeto exclusivo e `traefik.enable=false`. Não publicam portas nem usam banco/arquivos de outras aplicações. Em cada componente: release saudável → tentativa com healthcheck deliberadamente inválido → erro confirmado com mensagem de recuperação → link `current` ainda na release anterior → saúde recuperada. O teste final da API também baixa os mesmos bytes depois do rollback, comprovando persistência de sessão, banco e arquivos.

Foi conferida a remoção dos contêineres e volumes temporários e dos arquivos em `/home/perlin/silverbox/checks`. Os serviços que já existiam continuaram ativos. O Node24 dos testes foi extraído temporariamente da imagem oficial e apagado; não se instalou Node no sistema.

### POST /auth/register — Oracle privada
Corpo: `{"name":"ARM Release","email":"release-<timestamp>@example.com","password":"<senha de teste>"}`; Origin `https://web.silverbox.test`.
Resposta verificada: HTTP200 e cookie de sessão com atributo `Secure`. Segredo/cookie não registrados na documentação.

### POST /files — Oracle privada
Corpo binário: `hello`. Cabeçalhos: `Content-Type: application/octet-stream`, `X-File-Name: arm.txt`, `X-File-Size: 5`, `X-File-Mime: text/plain`, cookie da sessão de teste e Origin autorizada.
Resposta verificada: HTTP201; ID extraído de `file.id` para o download.

### GET /files/{id}/download — Oracle privada
Corpo: nenhum; cookie da sessão de teste.
Resposta verificada: HTTP200 e bytes `hello`, iguais ao upload, antes e depois da recuperação do deploy.

Essas chamadas são feitas dentro do contêiner pelo teste: não comprovam DNS, certificado público, navegação real do front ou consentimento Google. Os hosts `.test` são somente valores descartáveis do teste e não foram configurados como domínios de produção.

## Pipelines finais aprovados

- [API — execução 39870418846](https://github.com/CaioHPerlin/silverbox-api/actions/runs/39870418846), commit `83c3831`: build, 14 testes PostgreSQL/armazenamento, npm, Docker/OpenAPI, publicação ARM64, rollout/rollback no runner e na Oracle. Todos os jobs aprovados; testes de rollout com um aprovado, zero falhas e zero pulados em cada ambiente.
- [Web — execução 39870423984](https://github.com/CaioHPerlin/silverbox-web/actions/runs/39870423984), commit `c2a2f6e`: build/lint pnpm, npm, Docker SPA/configuração, publicação ARM64, rollout/rollback no runner e na Oracle. Todos os jobs aprovados; testes de rollout com um aprovado, zero falhas e zero pulados em cada ambiente.

O commit seguinte altera somente este relatório e usa `[skip ci]` para não repetir builds sem alteração de código. As imagens testadas têm as tags dos commits acima. As branches CI/CD ainda não foram mergeadas em main; aguardam aprovação. O merge anterior da API já foi autorizado e concluído.
