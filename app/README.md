# Silverbox API

## Para desenvolver apenas o front contra a API publicada

No repositório `silverbox-web`, com Node 24 e pnpm 11, execute `pnpm install --frozen-lockfile` e `pnpm dev`. Abra http://localhost:5173. Não é necessário rodar esta API, banco ou storage localmente; o Vite usa https://api.silverbox.perlin.com.br por padrão.

O proxy `/__api` do front mantém autenticação, upload e download na mesma origem do navegador. Ele traduz os cookies somente no transporte local; a API HTTPS mantém Secure, HttpOnly e SameSite=Lax. Cadastro, login e logout usam e-mail/senha; Google é opcional. Contas e arquivos criados pertencem à instância compartilhada. Veja o [guia do front](https://github.com/CaioHPerlin/silverbox-web#desenvolver-o-front-usando-a-api-publicada).

O deploy permite CORS de qualquer origem HTTP(S) com `CORS_ALLOW_ALL_ORIGINS=true`, refletindo Origin com `Vary: Origin` e credenciais. `null`, esquemas não HTTP(S) e valores inválidos são rejeitados. Login, autorização e isolamento de arquivos continuam obrigatórios. As origens de autenticação direta do Better Auth permanecem em `FRONTEND_ORIGINS`; o proxy usa a origem da própria API. CORS não resolve cookies entre localhost e outro site sem o proxy.

## Alternativa: API e banco locais com Docker

Instale Docker com Compose e, dentro de `app/`, execute:

```sh
docker compose up --build -d --wait
```

Não é necessário instalar Node/pnpm, criar `.env` ou configurar Google, Oracle ou CI/CD. O comando constrói a API, espera o PostgreSQL e aplica as migrações automaticamente.

- API: http://localhost:8000
- Swagger: http://localhost:8000/docs
- OpenAPI: http://localhost:8000/docs.json
- Prontidão: http://localhost:8000/health/ready

Cadastre uma conta por e-mail e senha pelo front ou pelo Swagger. O navegador guarda o cookie HttpOnly ao cadastrar/entrar. Use sempre `localhost` nas URLs locais; não misture com `127.0.0.1`. No front, inclua credenciais nas chamadas:

```ts
await fetch('http://localhost:8000/users/me', { credentials: 'include' })
```

As origens locais permitidas são `http://localhost:5173` e `http://localhost:3000`. Para outra porta, configure `FRONTEND_ORIGINS` com origens separadas por vírgula e recrie a API. Por padrão local, CORS rejeita origens desconhecidas; `CORS_ALLOW_ALL_ORIGINS=true` permite origens HTTP(S) mantendo credenciais sem `*`.

```sh
docker compose logs -f api
# Parar preservando contas e arquivos:
docker compose down
# Apagar explicitamente todos os dados locais:
docker compose down --volumes
```

Banco e arquivos usam volumes separados e persistem ao recriar os contêineres. O Compose é uma configuração local de desenvolvimento, com senha/segredo locais. A implantação Oracle é documentada em `deploy/README.md`.

## Para desenvolver a API sem contêiner

Requer Node 24, pnpm 11 ou npm 11. Dentro de `app/`:

```sh
cp .env.example .env
# Preencha BETTER_AUTH_SECRET com um segredo de ao menos 32 caracteres.
docker compose up -d --wait db
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Se a API Docker estiver rodando, execute `docker compose stop api` antes de `pnpm dev` para liberar a porta 8000. O banco é exposto somente em `127.0.0.1:5432`. Com npm, use `npm ci` e `npm run <script>`; os dois lockfiles são versionados.

## Armazenamento privado e configuração

O processo local usa `.data/` dentro de `app/`; o Compose usa `/var/lib/silverbox/files` em um volume Docker. Nunca sirva esse diretório estaticamente. Em produção, execute como usuário Unix dedicado sem root e configure explicitamente `STORAGE_ROOT` e `STORAGE_MAX_BYTES`.

| Variável | Padrão local | Função |
| --- | --- | --- |
| `STORAGE_ROOT` | Caminho absoluto de `app/.data` | Diretório privado; obrigatório em produção |
| `STORAGE_MAX_BYTES` | `10737418240` (10 GiB) | Teto global, incluindo versões, lixeira e reservas; obrigatório em produção |
| `STORAGE_MIN_FREE_BYTES` | `104857600` (100 MiB) | Margem mínima física |
| `STORAGE_MIN_FREE_PERCENT` | `0` | Percentual de capacidade a preservar; prevalece a maior margem |
| `STORAGE_MIN_FREE_INODES` | `1024` | Inodes livres a preservar |
| `STORAGE_MAX_TRANSFERS` | `4` | Transferências simultâneas globais |
| `STORAGE_MAX_USER_TRANSFERS` | `2` | Transferências simultâneas por usuário |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Máximo por arquivo, nunca acima de 1 GiB |
| `CORS_ALLOW_ALL_ORIGINS` | `false` local, `true` no deploy | Permite CORS HTTP(S); não dispensa sessão nem muda origens de autenticação |
| `FRONTEND_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Origens de navegador confiáveis |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM` | Ausentes | Conjunto SMTP completo para habilitar recuperação de senha; `SMTP_SECURE=true` usa TLS direto e `false` exige STARTTLS |

O Compose permite sobrescrever limites por variáveis de ambiente ou `.env`, mas mantém seu caminho interno de volume. Para uma implantação com disco/montagem próprios, configure o caminho e o volume correspondentes na etapa de implantação.

As reservas globais e individuais são transacionais. A margem física desconta conservadoramente todas as reservas em andamento, inclusive as parcialmente gravadas; assim, uma gravação pode ser recusada antes de atingir o teto nominal. Os bytes de versões e lixeira só deixam de contar após exclusão física definitiva. Falta de capacidade retorna `507`, excesso de transferências retorna `429` com `Retry-After: 1`; downloads e exclusões permanecem disponíveis.

Diretórios novos recebem `0700`, arquivos recebem `0600`. Diretórios/objetos existentes com proprietário ou permissões incompatíveis são rejeitados, sem `chmod/chown` silencioso. Symlinks são rejeitados. Na Oracle, prepare um diretório dedicado para o usuário do serviço antes de iniciar a API, por exemplo `sudo install -d -m 0700 -o silverbox -g silverbox /srv/silverbox/files`; não aplique alterações recursivas sobre dados sem inspeção.

Uma conexão PostgreSQL dedicada mantém o lock exclusivo associado ao caminho canônico do armazenamento. Use um banco e diretório exclusivos do Silverbox. Uma segunda instância com esse mesmo banco/diretório é recusada antes da limpeza de reservas; se a conexão do lock cair, a API encerra. O supervisor deve esperar o processo anterior terminar antes de iniciar outro. No reinício, a API remove uploads abandonados e retoma exclusões pendentes.

## Upload e autenticação

Envie bytes brutos como `application/octet-stream`, com `X-File-Name` codificado por `encodeURIComponent` e `X-File-Size` exato. `X-File-Mime` e `X-Folder-Id` são opcionais. O upload verifica tamanho e SHA-256 em fluxo, sem guardar o corpo inteiro na memória.

```sh
curl -b cookies.txt -H 'Origin: http://localhost:8000' \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-File-Name: note.txt' -H 'X-File-Mime: text/plain' \
  -H 'X-File-Size: 5' --data-binary 'hello' http://localhost:8000/files
```

Veja [`../dados/arquivos.md`](../dados/arquivos.md) para **endpoint → corpo → resposta**. Para testar operações privadas no Swagger, execute primeiro `/auth/register` ou `/auth/login`; o navegador envia o cookie automaticamente.

Google é opcional. Preencha as duas credenciais e configure o redirect URI `http://localhost:8000/api/auth/callback/google` no Google Cloud. Comece pelo navegador em `/auth/google`, mantendo o cookie de estado. Em produção use `${BETTER_AUTH_URL}/api/auth/callback/google`, com a origem HTTPS correta. O front pode consultar `GET /auth/providers` para mostrar o botão apenas quando habilitado. Sem credenciais, `/auth/google` retorna `400` e o login por senha continua funcionando.

### Sessão e autorização administrativa

`GET /users/me` retorna `user.role` como `user` ou `admin`. Na rota nativa `GET /api/auth/get-session`, o Better Auth retorna os papéis persistidos, por exemplo `user,admin` quando a conta tem os dois, ou `null` sem sessão. Use o papel efetivo de `/users/me` para exibir recursos administrativos. O servidor verifica a permissão em cada chamada.

| Requisição | Sem sessão ou sessão revogada | Sessão `user` | Sessão `admin` |
| --- | --- | --- | --- |
| `GET /users/me` | `401` | `200`, papel `user` | `200`, papel `admin` |
| `GET /api/auth/admin/list-users` | `401` | `403` | `200`, lista e total |
| `POST /api/auth/admin/set-role` | `401` | `403` | `200`, papel alterado com corpo válido |
| `POST /api/auth/admin/revoke-user-sessions` | `401` | `403` | `200`, sessões revogadas com corpo válido |

O Better Auth consulta o banco para ler a sessão e o papel. Promover ou rebaixar um usuário muda a autorização na próxima requisição, inclusive para cookies já emitidos. Revogar as sessões invalida esses cookies.

As rotas nativas de listagem e revogação respondem sem corpo no `401`. A alteração de papel e os endpoints do produto respondem erros em JSON.

Para provisionar o primeiro admin em um **banco local de teste**, cadastre uma conta descartável via Swagger e informe o e-mail dessa conta. Use a URL do banco local já configurada em `DATABASE_URL`.

```sh
read -r admin_email
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v admin_email="$admin_email" <<'SQL'
UPDATE silverbox_api.users
SET user_role = 'admin', updatedat = CURRENT_TIMESTAMP
WHERE email = :'admin_email'
RETURNING id, user_role;
SQL
```

Confira `UPDATE 1` e consulte `GET /users/me` com a sessão da conta. Com o administrador autenticado, use `POST /api/auth/admin/set-role` com `userId` (ID textual) e `role` (`admin` ou `user`) para mudar o papel de uma segunda conta e conferir a resposta dessa conta em `list-users`. Use `POST /api/auth/admin/revoke-user-sessions` com o mesmo `userId` para verificar a invalidação do cookie.

### Recuperação de senha

A solicitação usa `POST /api/auth/request-password-reset`, exposto pelo Better Auth. Envie `email` e, opcionalmente, `redirectTo` com uma URL em uma origem confiável de `FRONTEND_ORIGINS`. O corpo de sucesso é igual para e-mails cadastrados e desconhecidos. Sem SMTP, o endpoint retorna `400` com `RESET_PASSWORD_DISABLED`.

Configure juntas `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` e `MAIL_FROM` no `.env`. Todas vazias deixam o envio desabilitado; configuração parcial impede a API de iniciar. `SMTP_SECURE=true` usa TLS direto. `SMTP_SECURE=false` exige STARTTLS. Em ambos os casos os certificados são verificados. As variáveis são genéricas: qualquer serviço que ofereça SMTP autenticado pode ser usado atualizando esses valores e o remetente permitido no serviço. A API aceita a solicitação sem aguardar a entrega; falhas são registradas sem dados do destinatário ou do link. Não há fila persistente nem repetição automática, então uma interrupção do processo pode perder envios pendentes. O token expira em 15 minutos e só pode ser usado uma vez. `POST /api/auth/reset-password` recebe `token` e `newPassword` e revoga todas as sessões anteriores. O limite nativo é de três solicitações por minuto por IP; em produção, a API deve receber tráfego pelo proxy reverso (Traefik no deploy ou Caddy no Compose local), que define `X-Real-IP`. O acesso direto à API deve ficar restrito à rede interna.

```sh
curl -X POST http://localhost:8000/api/auth/request-password-reset \
  -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","redirectTo":"http://localhost:5173/nova-senha"}'
```

Para trocar a senha com uma sessão ativa, use `POST /api/auth/change-password` com `currentPassword` e `newPassword`. Depois de validar a senha atual, o servidor revoga todas as sessões anteriores e emite um novo cookie de sessão para o cliente que fez a troca.

### Operações administrativas

Todos os endpoints em `/admin` exigem sessão admin. Mudanças também exigem a origem da API ou uma origem configurada em `FRONTEND_ORIGINS`. O Swagger documenta parâmetros, formatos e códigos de retorno.

| Endpoint | Contrato |
| --- | --- |
| `GET /admin/users` | Contas e cotas com busca por nome ou email (`q`), `page` e `limit`. |
| `POST /admin/users` e `PATCH /admin/users/:id` | Criar conta pelo Better Auth ou alterar papel, bloqueio e cota em bytes como string. Bloquear revoga sessões. Cota menor que uso mais reservas ou a remoção do último admin resultam em `409`. |
| `DELETE /admin/users/:id` | Bloqueia a conta, revoga sessões e links, expurga os arquivos e versões e remove a conta. O admin atual não pode excluir a própria conta. Um `202` indica limpeza pendente. A conta permanece bloqueada e o admin pode repetir a operação. |
| `GET /admin/files` | Pesquisa por nome, proprietário ou email, com paginação. `trash=true` lista os arquivos na lixeira. |
| `GET /admin/files/:id/download` | Transmite os bytes do arquivo com o nome original e registra o administrador que baixou. |
| `DELETE /admin/files/:id` e `DELETE /admin/files/:id/permanent` | Mover para a lixeira e revogar links, ou expurgar o arquivo após ele estar na lixeira. |
| `GET /admin/audit` e `GET /admin/audit/export` | Consulta paginada e CSV UTF-8 de todos os resultados filtrados por `since`, `until`, `userId` e `action`. |
| `GET /admin/stats?days=7` | Totais globais e tráfego diário em UTC para 7 ou 30 dias, com zeros nos dias sem eventos. |

Cada evento novo carrega ator, ação, alvo, data, IP e ID da requisição. Acessos públicos pelo token registram ator anônimo e identificam o proprietário do arquivo. O CSV neutraliza fórmulas de planilha. A auditoria permanece disponível após remover usuários e não tem expiração automática. Registros anteriores à migração podem ter ID de requisição e volume transferido ausentes.

O armazenamento global contabiliza versões, arquivos na lixeira, avatares e reservas. `trashBytes` é a fração de versões na lixeira e já está incluída em `usedBytes`. A série de tráfego só contabiliza bytes de eventos coletados após a migração, incluindo prévias públicas no tráfego de saída. Os números de bytes em `/admin/stats` são strings decimais.

### Avatar

`GET /users/me/avatar` serve a foto da sessão atual. `POST` recebe bytes brutos com `Content-Type: image/jpeg`, `image/png` ou `image/webp`, até 2 MiB. A API decodifica e normaliza o avatar para WebP. A referência relativa devolvida em `user.image` pode ser exibida usando a origem da API e credenciais. Os bytes da foto entram em `/storage/usage`. `DELETE /users/me/avatar` remove a foto e libera o espaço. A foto corrente é armazenada no PostgreSQL e incluída no backup do banco.

### Paginação de compartilhamentos

`GET /shares?page=1&limit=20&q=relatorio` devolve `{ shares, page, limit, total }`, com ordem por data de criação e ID decrescentes. `q` é opcional e busca por nome de arquivo. `limit` aceita de 1 a 100. A chamada sem parâmetros continua devolvendo `{ shares }`. O estado e a permissão vêm da API. `expiresAt: null` representa link sem expiração.

## Verificação

```sh
pnpm typecheck
pnpm build
pnpm test
# Teste Docker isolado, sem .env; requer portas locais 8000 e 5432 livres:
pnpm test:docker
```

Os testes são `.ts`. A suíte HTTP usa PostgreSQL e diretórios temporários, confere o OpenAPI e os contratos de resposta, testa cotas/concorrência/cancelamento e usa bancos separados para as proteções globais. O teste Docker cria e remove somente seus próprios volumes. Consulte [`../dados/validacao-2026-10-22.md`](../dados/validacao-2026-10-22.md) para as evidências desta entrega.

## Busca de arquivos e pastas

`GET /search?q=termo` busca por trecho do nome em todas as pastas do usuário, sem diferenciar maiúsculas nem acentos, com paginação e total calculados no banco. `scope=folder&folderId=<id>` restringe à pasta e às subpastas; a lixeira fica de fora salvo `includeTrash=true`. Cada resultado traz `path` com as pastas até o local do item. Contrato, índices (`unaccent`, `pg_trgm`, `btree_gin`) e medições: [`../dados/busca-por-nome.md`](../dados/busca-por-nome.md).

## Backup e restauração

Pare a API para obter um conjunto consistente de banco e arquivos. Preserve as permissões e guarde os backups privadamente. No Compose:

```sh
umask 077
docker compose stop api
docker compose exec -T db pg_dump -U nuvem -d nuvem -Fc > silverbox-db.dump
docker compose run --rm --no-deps --entrypoint tar api -czf - -C /var/lib/silverbox files > silverbox-files.tar.gz
docker compose up -d --wait api
```

Restaure banco e diretório do mesmo conjunto, com a API parada, antes de reiniciar. Use `pg_restore` para o banco e extraia o arquivo no volume de arquivos vazio, preservando UID/GID do usuário de serviço. Verifique `/health/ready`, `/storage/usage` e o download de um arquivo conhecido. Banco sem arquivos perde os bytes; arquivos sem banco perdem propriedade, versões e compartilhamentos.

## Oracle e CI/CD

A configuração de produção e o fluxo de deploy ficam em [../deploy/README.md](../deploy/README.md). O Compose local acima continua independente da Oracle.

## Pagamentos em Asaas Sandbox

`GET /plans` publica Free, Pro, Team e Business. Use uma instância e um banco de homologação para habilitar os pagamentos.

| Variável | Configuração |
| --- | --- |
| `BILLING_MODE` | `disabled` por padrão. Use `sandbox` na instância de homologação. |
| `ASAAS_API_KEY` | Chave de uma conta Asaas Sandbox. |
| `ASAAS_WEBHOOK_TOKEN` | Token dedicado de pelo menos 32 caracteres, distinto da chave. Configure o mesmo valor no painel Asaas. |
| `BILLING_RETURN_ORIGIN` | Origem do frontend que serve `/planos`. Use a origem HTTPS de homologação ou `http://localhost:5173` com o túnel da API. |
| `BILLING_PUBLIC_RETURN_ORIGIN` | Opcional. Quando o frontend roda em localhost, use a origem HTTPS do túnel da API, sem caminho. O Asaas envia o navegador para `/plans/return`, que redireciona para `/planos` no frontend local. |
| `BILLING_MAX_CHARGE_CENTS` | Limite por cobrança verificado na conta Sandbox, em centavos. Por exemplo, `5000000` para um limite de R$ 50.000. |

Aplique a migração Prisma e configure a URL HTTPS de homologação em `POST /webhooks/asaas`. Habilite os eventos de checkout e de ciclo de vida das cobranças, incluindo recebimento, vencimento, exclusão, estorno e disputa. A API persiste os eventos antes de responder e retoma os pendentes no próximo início do processo.

Envie `planCode`, `cycle`, `seats` e `method` para `POST /plans/checkout` com o cookie de sessão e um `Idempotency-Key` por intenção. Na primeira compra Pix ou boleto, inclua `payerCpf`. O cartão é coletado pelo checkout hospedado. Acompanhe o estado por `GET /plans/purchases/:id`. O retorno do navegador serve para atualizar essa consulta. Para testar com o front local, configure `VITE_API_URL=http://localhost:8000`.

Use a mesma chave após timeout. Para Pix ou boleto, a API procura a cobrança pela referência e recupera as instruções do mesmo ID. Para cartão, ela recupera o vínculo por evento do checkout ou pela cobrança associada. Uma criação inconclusiva sem evidência suficiente entra em `review`. Confira a referência de compra no painel Asaas antes de iniciar outra tentativa.

A vigência do Pro começa na confirmação válida, com fim exclusivo e ajuste ao último dia de meses mais curtos. Compras simultaneamente vigentes usam a maior quota aplicável. Cada renovação é iniciada pelo usuário e tem sua própria vigência. Após expiração, estorno integral ou disputa, o arquivo continua acessível e a quota vigente volta a valer nas novas gravações. Estorno parcial segue para revisão e preserva eventual benefício já concedido. Team e Business permitem testar a cobrança em Sandbox. Os benefícios de equipe permanecem como proposta comercial.
