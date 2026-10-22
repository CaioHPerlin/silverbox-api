# Evidências — finalização da API em 22/10/2026

Branch: `feature/local-file-management`. Escopo: Swagger, proteção global do armazenamento, ownership e ambiente local Docker. A etapa Oracle/CI-CD será feita em `feature/ci-cd`; a instância usa o alias SSH `dock`. O `silverbox-web` não foi alterado nesta entrega.

## Resultados executados

| Verificação | Resultado |
| --- | --- |
| `pnpm typecheck` e `pnpm build` | Aprovados |
| `pnpm test` | **14 testes aprovados, zero falhas, zero ignorados** |
| OpenAPI 3.0.3 | Validado por `@apidevtools/swagger-parser` |
| Respostas HTTP | **35 operações documentadas exercitadas**, com schemas JSON conferidos por AJV, além de cabeçalhos/tamanho dos downloads binários |
| `pnpm test:docker` | **1 teste aprovado**, usando projeto/volumes novos e `--env-file /dev/null` |
| PostgreSQL | Suíte nativa com PostgreSQL 18 temporário; teste Compose com PostgreSQL 16 e migrações automáticas desde banco vazio |
| npm isolado | `npm ci`, `npm run db:generate`, `npm run typecheck` e `npm run build` aprovados |
| `docker compose config --quiet` | Aprovado |

O teste Docker executou o equivalente a `docker compose up --build -d --wait` sem `.env`, confirmou API/banco saudáveis, realizou cadastro e upload e recriou o contêiner da API. O cookie de sessão e os bytes `hello` continuaram válidos depois da recriação, comprovando persistência independente do contêiner.

O processo rodou com **UID 1000**, diretório do volume **UID 1000 / modo 0700** e arquivo **UID 1000 / modo 0600**. Um processo com UID 65534 foi recusado por ownership; execução root com `NODE_ENV=production` também foi recusada. As verificações usaram contêineres de teste, sem alterar ownership de diretórios do host.

## Casos de proteção comprovados

- Dois usuários disputando teto global de 6 bytes com arquivos de 4 bytes: respostas `201` e `507`; mover o vencedor para a lixeira não liberou capacidade; a exclusão definitiva liberou.
- Margens de espaço livre em bytes, percentual e inodes configuradas para recusa controlada: `507`, sem reservas vazadas, mantendo downloads e exclusões. Nenhum disco foi preenchido para simular a falha.
- Uploads mantidos abertos: limites individual/global retornaram `429` com `Retry-After: 1`. Cancelamento liberou reservas e permitiu novo upload.
- Segunda API no mesmo banco/diretório: encerrou com erro de exclusividade; a reserva do upload ativo da primeira permaneceu intacta.
- Encerramento da sessão PostgreSQL do lock: a API encerrou com código 1, impedindo operação sem exclusividade.
- Falha física de exclusão provocada por permissão de diretório: resposta `202`; uso permaneceu em 4 bytes. Após reparar a permissão e reiniciar, a reconciliação removeu os bytes e o uso voltou a zero.
- Diretório com modo 0755 e symlinks internos/por usuário: recusados, sem mudança silenciosa de permissão.
- Produção sem `STORAGE_ROOT` ou `STORAGE_MAX_BYTES`: inicialização recusada com diagnóstico legível.

## Rotas e contratos

A suíte de autenticação verifica cadastro/login/logout por aliases e rotas nativas, sessão, usuário atual, origem do front, redirecionamento Google e callback negativo, além de raiz e saúde. A suíte de arquivos verifica todas as 22 operações de pastas/arquivos/versões/lixeira/compartilhamento/uso. Ambas exigem a cobertura das operações previstas e validam os contratos retornados.

O front em `http://localhost:5173` conseguiu autenticar, recebeu CORS com credenciais e consultou a sessão; origem desconhecida recebeu `403`. Preflight de upload recebeu `204` com cabeçalhos explícitos. O Swagger foi servido e a configuração permite cookies nas chamadas pelo navegador.

Também foi corrigido um defeito encontrado no reteste: renomear uma pasta aplicava o valor padrão de `parentFolderId` e a movia para a raiz. A atualização parcial agora preserva o pai quando esse campo não é enviado, com regressão coberta.

Sem credenciais Google, o login por senha funciona e `/auth/google` retorna `400` legível. Com credenciais de teste, foi conferido o redirecionamento de entrada e o callback de erro. **Consentimento e troca de código reais do Google não foram executados nesta rodada**; não são necessários para subir o ambiente local.

## Reprodução

Para quem desenvolve o front, a partir de `app/`:

```sh
docker compose up --build -d --wait
```

API: `http://localhost:8000`; Swagger: `http://localhost:8000/docs`. Login por senha não exige outra configuração. O teste Docker automatizado requer portas locais 8000/5432 livres e é executado com `pnpm test:docker` após instalar as dependências de desenvolvimento. Ele apaga somente os volumes isolados que criou.

Os endpoints, corpos e respostas estão em [arquivos.md](arquivos.md). Configuração, limites, operação local e backup estão no [README da API](../app/README.md).
