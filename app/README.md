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

Google é opcional. Preencha as duas credenciais e configure o redirect URI `http://localhost:8000/api/auth/callback/google` no Google Cloud. Comece pelo navegador em `/auth/google`, mantendo o cookie de estado. Em produção use `${BETTER_AUTH_URL}/api/auth/callback/google`, com a origem HTTPS correta. Sem credenciais, `/auth/google` retorna `400` legível e o login por senha continua funcionando.

### Sessão e autorização administrativa

`GET /users/me` retorna `user.role` como `user` ou `admin`. Na rota nativa `GET /api/auth/get-session`, o Better Auth retorna os papéis persistidos, por exemplo `user,admin` quando a conta tem os dois, ou `null` sem sessão. Use o papel efetivo de `/users/me` para exibir recursos administrativos. O servidor verifica a permissão em cada chamada.

| Requisição | Sem sessão ou sessão revogada | Sessão `user` | Sessão `admin` |
| --- | --- | --- | --- |
| `GET /users/me` | `401` | `200`, papel `user` | `200`, papel `admin` |
| `GET /api/auth/admin/list-users` | `401` | `403` | `200`, lista e total |
| `POST /api/auth/admin/set-role` | `401` | `403` | `200`, papel alterado com corpo válido |
| `POST /api/auth/admin/revoke-user-sessions` | `401` | `403` | `200`, sessões revogadas com corpo válido |

O Better Auth consulta o banco para ler a sessão e o papel. Promover ou rebaixar um usuário muda a autorização na próxima requisição, inclusive para cookies já emitidos. Revogar as sessões invalida esses cookies.

As três rotas administrativas da tabela respondem sem corpo no `401`. No `403`, o Better Auth retorna o erro em JSON.

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

Configure juntas `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` e `MAIL_FROM` no `.env`. Todas vazias deixam o envio desabilitado; configuração parcial impede a API de iniciar. `SMTP_SECURE=true` usa TLS direto. `SMTP_SECURE=false` exige STARTTLS. Em ambos os casos os certificados são verificados. As variáveis são genéricas: qualquer serviço que ofereça SMTP autenticado pode ser usado atualizando esses valores e o remetente permitido no serviço. A API aceita a solicitação sem aguardar a entrega; falhas são registradas sem dados do destinatário ou do link. Não há fila persistente nem repetição automática, então uma interrupção do processo pode perder envios pendentes. O token Better Auth expira em uma hora. O limite nativo é de três solicitações por minuto por IP; em produção, a API deve receber tráfego pelo proxy reverso (Traefik no deploy ou Caddy no Compose local), que define `X-Real-IP`. O acesso direto à API deve ficar restrito à rede interna.

```sh
curl -X POST http://localhost:8000/api/auth/request-password-reset \
  -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","redirectTo":"http://localhost:5173/reset-password"}'
```

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
