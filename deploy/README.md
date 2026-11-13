# CI/CD — Oracle

## Local

O ambiente local independe da Oracle. Consulte o README do projeto. Não copie os segredos da Oracle para desenvolvimento.

## Fluxo

Pull requests e pushes em `main` executam CI com pnpm, build, testes HTTP e Docker. Validações anteriores da mesma branch são canceladas. A compatibilidade npm executa quando mudam manifests, lockfiles, configuração Node ou arquivos de `.github/`; disparos manuais e comparações indisponíveis sempre executam npm. Os dois gerenciadores continuam suportados.

Após CI aprovado de um push em `main`, o workflow independente **Publish and deploy** publica imagem Linux ARM64 no GHCR com tag igual ao SHA validado. PRs não publicam. O fluxo confere se o SHA ainda é o atual de `main` antes da publicação e antes da aplicação. Deploys são serializados, sem cancelamento de execução em andamento. A imagem de teste AMD64 e a imagem de release ARM64 têm caches GHA separados.

O ambiente GitHub `oracle` guarda `ORACLE_HOST`, `ORACLE_USER`, `ORACLE_SSH_KEY` e `ORACLE_KNOWN_HOSTS`. Foram cadastradas chaves exclusivas por repositório; a chave pessoal não foi copiada. A identidade SSH é fixada pelo known_hosts, sem `StrictHostKeyChecking=no`. As chaves públicas têm `restrict` (sem encaminhamento ou PTY); o usuário ainda tem os privilégios de Docker da conta `perlin`.

Toda publicação executa startup, persistência e rollback em ARM64 no runner. A repetição completa na Oracle ocorre **somente manualmente**, em projeto Compose isolado, sem portas públicas ou router Traefik, com dados descartáveis. O teste extrai temporariamente Node24 da imagem oficial e limpa seus próprios recursos.

**Aplicação da release exige `ORACLE_READY=true` no ambiente `oracle`.** O fluxo automático aplica após os gates, verifica saúde e depois DNS/HTTPS. Se a variável estiver desabilitada, publica e valida ARM64 sem aplicar a release. Não alterar essa variável antes de preparar domínios e `.env`.

Para ensaio manual, selecionar **Publish and deploy → Run workflow → main**: `oracle_check=true` e `deploy=false` são os padrões. Exige CI aprovado para o SHA exato selecionado; sem aprovação, executar CI manual na `main` primeiro. O ensaio não troca a release pública. Para aplicar manualmente, marcar `deploy=true`; a proteção `ORACLE_READY` continua obrigatória. O input antigo `deploy` do workflow CI foi substituído pelos controles deste workflow independente.

## Preparação

1. Criar dois registros DNS A para `152.67.57.175`: web e API, preferencialmente no mesmo domínio base (cookies SameSite).
2. Preencher o modelo `deploy/.env.example` em `/home/perlin/silverbox/api/.env`, pertencente a `perlin`, modo `0600`. Os diretórios de deploy são `0700`. Valores secretos nunca entram no GitHub como variáveis públicas ou nos logs.
3. API: gerar senha PostgreSQL e segredo Better Auth independentes com `openssl rand -hex 32`. Não mudar a senha de um volume PostgreSQL já inicializado sem alterar também a role no banco. OAuth é opcional: preencher os dois campos juntos e autorizar `https://API_HOST/api/auth/callback/google` no Google.
4. Manter a rede externa `traefik` existente e o resolver `letsencrypt`. Os novos routers são exclusivos `silverbox-api` e `silverbox-web`; banco não publica portas. Não é necessário alterar o proxy nem os outros serviços.
5. Habilitar `ORACLE_READY` e executar o pipeline. Não é necessário Node na Oracle: somente Docker Compose, bash, flock e SSH.

## Operação

Cada componente usa `/home/perlin/silverbox/api/releases/SHA`. O script recebe o token temporário do GitHub via stdin, faz login em diretório temporário e o apaga ao sair. Downloads de imagens acontecem antes da troca; não se usa `latest`. `flock` serializa deploys e `docker compose up --wait` verifica saúde. O link `current` só muda após sucesso. Falha de saúde tenta restaurar a imagem anterior; **migrações não são revertidas**. Usar migrações compatíveis com a aplicação anterior e backup antes de mudanças destrutivas. Não há promessa de zero downtime: a API deve parar antes de liberar seu lock de armazenamento.

Logs: `cd /home/perlin/silverbox/api/current && IMAGE=$(cat image) docker compose logs --tail 100`. Estado: mesmo comando com `ps`. Nunca publicar a saída de `docker compose config` sem `--quiet` porque expande segredos.

Rollback manual: escolher um diretório de release anterior, usar `IMAGE=$(cat image) docker compose up -d --wait` dentro dele e atualizar `current` após conferir saúde. Imagens privadas precisam de autenticação GHCR para novo pull. Volumes não são apagados pelo script; não executar `down -v` em produção. Releases e imagens antigas não são limpas automaticamente: remover apenas as não necessárias, preservando ao menos a atual e a anterior. Monitorar disco também para imagens e PostgreSQL: o teto do storage limita objetos, não o filesystem inteiro.

## Dados e permissões da API

O projeto Compose `silverbox-api` cria volumes separados `silverbox-api_database` e `silverbox-api_files`. O volume de arquivos nasce do diretório da imagem, UID/GID 1000, modo 0700; arquivos 0600. A aplicação valida ownership, permissões, symlinks e lock PostgreSQL. Não há chown automático em dados existentes. Se optar por bind mount, preparar somente o diretório novo explicitamente para UID1000 e modo700; não alterar recursivamente dados sem inspeção.

Padrões: teto 10GiB, margem física de 100MiB e reserva percentual desabilitada, reserva de 1024 inodes, quatro transferências globais e duas por usuário. O host foi inspecionado com ~35GiB livres em filesystem de 45GiB. Ajustar o orçamento conforme o crescimento do banco e demais serviços.

Backup consistente: bloquear novas gravações/parar a API, gerar dump PostgreSQL e copiar todo o volume de arquivos antes de retomar. Guardar também o `.env` cifrado em local privado. Na restauração, recuperar banco e arquivos do mesmo ponto, conferir UID1000/modos e iniciar uma única API. Não restaurar somente os metadados nem somente os objetos. Validar download/SHA-256 após restauração.

## Limites da entrega

Deploy não integra automaticamente as telas de arquivos do web: várias ainda usam dados simulados e o helper multipart não corresponde ao upload binário da API. O pipeline valida a publicação do frontend e sua configuração de autenticação. O consentimento Google real exige a conta e configuração do usuário e deve ser verificado no domínio final.

## Domínios desta instância

- Web: `https://silverbox.perlin.com.br`
- API: `https://api.silverbox.perlin.com.br`
- Callback Google: `https://api.silverbox.perlin.com.br/api/auth/callback/google`

Os registros A devem apontar para `152.67.57.175`. O deploy público exige DNS confirmado para cada serviço; os segredos ficam somente no `.env` privado da Oracle.

## Front local contra a API publicada

O Compose de produção ativa `CORS_ALLOW_ALL_ORIGINS=true` por padrão. É possível sobrescrever para `false` no `.env` e restringir novamente à API e `FRONTEND_ORIGINS`. `FRONTEND_ORIGINS` agora respeita o `.env`; sem valor, continua sendo `https://${WEB_HOST}`. Nenhum segredo precisa ir para o front.

O time pode executar apenas `pnpm dev` em `silverbox-web`: o proxy Vite `/__api` aponta à API pública e traduz cookies de sessão exclusivamente no loopback. O deploy mantém cookies Secure/HttpOnly/SameSite=Lax, login e isolamento por proprietário. Liberação CORS não libera arquivos anônimos nem remove a validação de origem do Better Auth. Para um web separado em HTTPS, configurar também as origens de autenticação e respeitar as regras SameSite; usar o proxy é o caminho suportado no desenvolvimento local.
