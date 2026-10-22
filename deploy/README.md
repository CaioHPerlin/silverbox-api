# CI/CD — Oracle

## Local

O ambiente local independe da Oracle. Consulte o README do projeto. Não copie os segredos da Oracle para desenvolvimento.

## Fluxo

Push em `feature/ci-cd` ou `main` executa os gates e publica imagem Linux ARM64 no GHCR com tag igual ao SHA completo do commit. Pull requests só validam. A arquitetura foi escolhida após inspeção do `dock` (Ubuntu 24.04, aarch64, Docker, rede externa `traefik`). Runners: [referência oficial GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

O ambiente GitHub `oracle` guarda `ORACLE_HOST`, `ORACLE_USER`, `ORACLE_SSH_KEY` e `ORACLE_KNOWN_HOSTS`. Foram cadastradas chaves exclusivas por repositório; a chave pessoal não foi copiada. A identidade SSH é fixada pelo known_hosts, sem `StrictHostKeyChecking=no`. As chaves públicas têm `restrict` (sem encaminhamento ou PTY); o usuário ainda tem os privilégios de Docker da conta `perlin`.

**O deploy só é habilitado com a variável `ORACLE_READY=true` no ambiente `oracle`.** Enquanto faltarem os domínios e o `.env`, a imagem é publicada e o passo SSH é pulado. Não habilitar antes da configuração abaixo. Após habilitar, pushes nessas duas branches fazem deploy; remover `feature/ci-cd` da lista de push ao encerrar a homologação. O workflow também aceita disparo manual com `deploy=true` após existir na branch padrão.

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

Padrões: teto 10GiB, margem física maior entre 5GiB e 10%, reserva de 1024 inodes, quatro transferências globais e duas por usuário. O host foi inspecionado com ~35GiB livres em filesystem de 45GiB. Ajustar o orçamento conforme o crescimento do banco e demais serviços.

Backup consistente: bloquear novas gravações/parar a API, gerar dump PostgreSQL e copiar todo o volume de arquivos antes de retomar. Guardar também o `.env` cifrado em local privado. Na restauração, recuperar banco e arquivos do mesmo ponto, conferir UID1000/modos e iniciar uma única API. Não restaurar somente os metadados nem somente os objetos. Validar download/SHA-256 após restauração.

## Limites da entrega

Deploy não integra automaticamente as telas de arquivos do web: várias ainda usam dados simulados e o helper multipart não corresponde ao upload binário da API. O pipeline valida a publicação do frontend e sua configuração de autenticação. O consentimento Google real exige a conta e configuração do usuário e deve ser verificado no domínio final.
