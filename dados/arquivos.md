# Silverbox API — autenticação e arquivos

Base local: `http://localhost:8000`. Rotas privadas exigem o cookie de sessão Better Auth. Métodos que alteram sessão exigem `Origin` igual à origem pública da API. Em erros de validação, a API retorna `{ "error": "..." }` (às vezes com `issues`); objetos de outro usuário retornam `404`. IDs e datas abaixo são exemplos.

## Autenticação

**`POST /auth/register`** → Corpo: `{"name":"Ana","email":"ana@example.com","password":"senha-longa"}` (`application/json`). → Resposta `200`: objeto Better Auth com `user` e `token`, além de `Set-Cookie` HTTP-only.

**`POST /auth/login`** → Corpo: `{"email":"ana@example.com","password":"senha-longa"}`. → Resposta `200`: objeto Better Auth com `user` e `token`, além de `Set-Cookie`.

**`POST /auth/logout`** → Corpo: `{}` e cookie de sessão. → Resposta `200`: confirmação Better Auth; cookie de sessão invalidado.

**`GET /users/me`** → Corpo: nenhum; cookie de sessão. → Resposta `200`: `{"user":{"id":"1","name":"Ana","email":"ana@example.com",...}}`; sem sessão, `401`.

**`GET /auth/google`** → Corpo: nenhum. → Resposta `302`: redirecionamento ao Google quando as duas credenciais estão configuradas. O callback usado pelo Google é `/api/auth/callback/google`.

## Pastas

**`POST /folders`** → Corpo: `{"name":"Pessoal","parentFolderId":null}`; `parentFolderId` omitido também significa raiz. → Resposta `201`: `{"folder":{"id":1,"userId":1,"parentFolderId":null,"name":"Pessoal",...}}`.

**`GET /folders?parentFolderId=1`** → Corpo: nenhum; sem `parentFolderId`, lista a raiz. → Resposta `200`: `{"folders":[{"id":2,"name":"Fotos",...}]}`.

**`PATCH /folders/2`** → Corpo: `{"name":"Imagens","parentFolderId":null}`; cada campo é opcional, mas pelo menos um é obrigatório. → Resposta `200`: `{"folder":{"id":2,"name":"Imagens","parentFolderId":null,...}}`. Mover pasta para si ou descendente retorna `409`.

**`DELETE /folders/2`** → Corpo: nenhum. → Resposta `204` sem corpo. Pasta com subpastas ou arquivos, inclusive na lixeira, retorna `409`.

## Arquivos e versões

**`POST /files`** → Corpo: bytes brutos (`application/octet-stream`), com `X-File-Name: nota.txt` (nome codificado por `encodeURIComponent`), `X-File-Size: 5`, `X-File-Mime: text/plain` opcional e `X-Folder-Id: 2` opcional. O tamanho informado deve coincidir exatamente com os bytes enviados. → Resposta `201`: `{"file":{"id":1,"folderId":2,"originalName":"nota.txt","sizeBytes":5,"mimeType":"text/plain","checksum":"<sha256>","isDeleted":false,...}}`. Cota ou limite ultrapassado retorna `413`; tamanho diferente retorna `400`.

**`GET /files?folderId=2&page=1&limit=50`** → Corpo: nenhum; sem `folderId`, lista a raiz. `limit` máximo: 100. → Resposta `200`: `{"files":[{"id":1,...}],"page":1,"limit":50,"total":1}`.

**`GET /files/1`** → Corpo: nenhum. → Resposta `200`: `{"file":{"id":1,"originalName":"nota.txt",...}}`.

**`GET /files/1/download`** → Corpo: nenhum. → Resposta `200`: bytes do arquivo, com `Content-Type`, `Content-Length` e `Content-Disposition: attachment`. Arquivo indisponível no disco retorna `503`.

**`PATCH /files/1`** → Corpo: `{"originalName":"nova-nota.txt","folderId":null}`; cada campo é opcional, mas pelo menos um é obrigatório. → Resposta `200`: `{"file":{"id":1,"originalName":"nova-nota.txt","folderId":null,...}}`.

**`POST /files/1/versions`** → Corpo: novos bytes brutos e cabeçalhos de upload como em `POST /files`. → Resposta `201`: `{"version":{"id":2,"versionNumber":2,"sizeBytes":5,"checksum":"<sha256>","mimeType":"text/plain",...}}`. A versão anterior permanece armazenada e conta na cota.

**`GET /files/1/versions`** → Corpo: nenhum. → Resposta `200`: `{"versions":[{"id":2,"versionNumber":2,...},{"id":1,"versionNumber":1,...}]}`.

**`GET /files/1/versions/1/download`** → Corpo: nenhum. → Resposta `200`: bytes da versão solicitada; versão inexistente ou de outro arquivo retorna `404`.

**`POST /files/1/versions/1/restore`** → Corpo: nenhum. → Resposta `201`: `{"version":{"id":3,"versionNumber":3,...}}`. Copia a versão escolhida para uma versão nova; exige espaço na cota.

## Lixeira

**`DELETE /files/1`** → Corpo: nenhum. → Resposta `204` sem corpo. O arquivo vai para a lixeira e seus links são revogados; bytes e versões continuam na cota.

**`GET /files/trash`** → Corpo: nenhum. → Resposta `200`: `{"files":[{"id":1,"isDeleted":true,...}]}`.

**`POST /files/1/restore`** → Corpo: nenhum. → Resposta `200`: `{"file":{"id":1,"isDeleted":false,...}}`. Links previamente revogados continuam revogados.

**`DELETE /files/1/permanent`** → Corpo: nenhum; requer arquivo na lixeira. → Resposta `204` sem corpo. Remove versões, metadados e links; libera a cota somente após remover os bytes. Se o disco falhar, retorna `202` com `{"status":"deleting"}` e tenta novamente na reconciliação.

## Compartilhamento e uso

**`POST /files/1/shares`** → Corpo: `{"expiresInSeconds":3600}`; opcional, padrão 86400, intervalo 60–604800. → Resposta `201`: `{"id":1,"url":"http://localhost:8000/shares/<token>","expiresAt":"<data>"}`. O token é mostrado apenas nesta resposta; o banco guarda SHA-256 do token.

**`GET /files/1/shares`** → Corpo: nenhum. → Resposta `200`: `{"shares":[{"id":1,"expiresAt":"<data>","revokedAt":null,"createdAt":"<data>"}]}`; tokens não são retornados.

**`DELETE /files/1/shares/1`** → Corpo: nenhum. → Resposta `204` sem corpo. A revogação passa a valer para a próxima requisição.

**`GET /shares/<token>`** → Corpo: nenhum; não exige sessão. → Resposta `200`: bytes do arquivo. Token inexistente retorna `404`; expirado, revogado ou associado a arquivo na lixeira retorna `410`.

**`GET /storage/usage`** → Corpo: nenhum. → Resposta `200`: `{"usedBytes":"5","reservedBytes":"0","limitBytes":"1073741824","availableBytes":"1073741819"}`. Os números são strings decimais para não perder precisão de `BIGINT`.

## Verificação executada

Em 8 de outubro de 2026, com PostgreSQL 18 temporário e diretórios de arquivos temporários, a migração desde um banco vazio, `pnpm build` e `pnpm test` passaram: **5 testes, 5 aprovados**. Os testes cobriram bytes e SHA-256 idênticos após download, isolamento entre usuários, pastas e ciclos, versões, restauração, links e revogação, lixeira, exclusão definitiva, cota sob uploads concorrentes, upload interrompido, auditoria, validação do ambiente e reconciliação após reinício. Uma instalação npm isolada também passou por `npm ci`, `npm run db:generate` e `npm run build`.

O Compose com PostgreSQL não iniciou neste host porque o daemon não conseguiu criar as interfaces de rede do contêiner (`operation not supported`). A verificação acima usou PostgreSQL local temporário. Essa limitação do host não altera o arquivo Compose; a inicialização por Compose deve ser verificada em uma máquina com rede Docker funcional.

## Complementos da entrega de 22/10/2026

**`GET /`** → Corpo: nenhum. → Resposta `200`: `{"message":"Hello, World"}`.

**`GET /health/live`** → Corpo: nenhum. → Resposta `200`: `{"status":"ok"}`; indica processo ativo.

**`GET /health/ready`** → Corpo: nenhum. → Resposta `200`: `{"status":"ok"}` quando banco e armazenamento privado estão disponíveis; `503`: `{"status":"unavailable"}` em falha de dependência, sem expor caminhos ou credenciais.

**`POST /api/auth/sign-up/email`** → Corpo: mesmo JSON de `/auth/register`. → Resposta `200`: usuário/token e cookie HttpOnly, conforme contrato nativo Better Auth.

**`POST /api/auth/sign-in/email`** → Corpo: mesmo JSON de `/auth/login`. → Resposta `200`: usuário/token e cookie HttpOnly.

**`POST /api/auth/sign-out`** → Corpo: `{}` com cookie e `Origin` confiável. → Resposta `200`: `{"success":true}`.

**`GET /api/auth/get-session`** → Corpo: nenhum; cookie opcional. → Resposta `200`: `{"user":{...},"session":{...}}` ou `null` sem sessão.

**`GET /api/auth/callback/google?code=...&state=...`** → Corpo: nenhum; chamado pelo Google com o cookie de estado do navegador que iniciou o fluxo. → Resposta `302` com `Location` e, em sucesso, sessão. O callback de erro também redireciona; o teste negativo usa `error=access_denied`, sem fabricar consentimento ou código real.

**`GET /auth/google` sem credenciais configuradas** → Corpo: nenhum. → Resposta `400`: `{"error":"Google sign-in is not configured"}`. O login por senha não depende do Google.

**`POST /files`**, **`POST /files/:id/versions`** e **`POST /files/:id/versions/:versionId/restore`** → Corpo conforme cada endpoint acima. → Além dos resultados documentados: `429` com `Retry-After: 1` e `{"error":"Too many simultaneous transfers"}` para excesso de concorrência; `507` para teto global, margem livre/inodes ou disco cheio; `503` se não for possível verificar o armazenamento. A recusa ocorre antes de receber novos bytes quando detectável antecipadamente. Lixeira e versões continuam contabilizadas.

**Requisição com `Origin` não permitido** → Corpo conforme a operação. → Resposta `403`: `{"error":"Origin is not allowed"}`. Origens locais padrão: `http://localhost:5173` e `http://localhost:3000`. O front deve usar `credentials: 'include'`. Os preflights permitidos respondem `204` com origem explícita e credenciais, sem wildcard.

O Swagger em `/docs` e `/docs.json` contém schemas completos, respostas binárias e cabeçalhos. As evidências atuais estão em [validacao-2026-10-22.md](validacao-2026-10-22.md); o registro de 08/10 acima é histórico.
