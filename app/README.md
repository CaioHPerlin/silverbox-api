# Silverbox API

## Para desenvolver apenas o front

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

As origens locais permitidas são `http://localhost:5173` e `http://localhost:3000`. Para outra porta, configure `FRONTEND_ORIGINS` com origens separadas por vírgula e recrie a API. CORS rejeita origens desconhecidas; não usa `*` com cookies.

```sh
docker compose logs -f api
# Parar preservando contas e arquivos:
docker compose down
# Apagar explicitamente todos os dados locais:
docker compose down --volumes
```

Banco e arquivos usam volumes separados e persistem ao recriar os contêineres. O Compose é uma configuração local de desenvolvimento, com senha/segredo locais. A implantação Oracle será tratada na branch `feature/ci-cd`.

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
| `STORAGE_MIN_FREE_BYTES` | `5368709120` (5 GiB) | Margem mínima física |
| `STORAGE_MIN_FREE_PERCENT` | `10` | Percentual de capacidade a preservar; prevalece a maior margem |
| `STORAGE_MIN_FREE_INODES` | `1024` | Inodes livres a preservar |
| `STORAGE_MAX_TRANSFERS` | `4` | Transferências simultâneas globais |
| `STORAGE_MAX_USER_TRANSFERS` | `2` | Transferências simultâneas por usuário |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Máximo por arquivo, nunca acima de 1 GiB |
| `FRONTEND_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Origens de navegador confiáveis |

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

## Verificação

```sh
pnpm typecheck
pnpm build
pnpm test
# Teste Docker isolado, sem .env; requer portas locais 8000 e 5432 livres:
pnpm test:docker
```

Os testes são `.ts`. A suíte HTTP usa PostgreSQL e diretórios temporários, confere o OpenAPI e os contratos de resposta, testa cotas/concorrência/cancelamento e usa bancos separados para as proteções globais. O teste Docker cria e remove somente seus próprios volumes. Consulte [`../dados/validacao-2026-10-22.md`](../dados/validacao-2026-10-22.md) para as evidências desta entrega.

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
