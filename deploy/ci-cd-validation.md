# Validação de CI/CD — 2026-11-12

## Referência anterior

- API: últimas cinco runs de main, 206–302s; última run 41970041111: total 294s, Docker 83s, deploy 200s.
- Na última run: publicação 49s, startup/rollback ARM64 41s, ensaio Oracle 67s, aplicação 17s e HTTPS 2s.
- A suíte Oracle saiu do fluxo automático; o custo observado era 47–73s em três runs.

## Validação após merge

Registrar três pushes equivalentes em main com CI e deploy bem-sucedidos. A primeira execução aquece o novo cache; comparar as seguintes separadamente. Como CI e deploy agora são workflows distintos, medir a latência entre o push e o fim do deploy, incluindo a espera entre workflows. Não somar jobs paralelos.

| Amostra | SHA | URL CI | Fila CI | Execução CI | URL deploy | Espera até deploy | Execução deploy | Total |
|---|---|---|---|---|---|---|---|---|
| 1 — cache inicial | pendente | | | | | | | |
| 2 — cache aquecido | pendente | | | | | | | |
| 3 — cache aquecido | pendente | | | | | | | |

Conferir: fonte sem mudança de dependências dispensa npm; lockfile executa npm; CI reprovado/cancelado/PR não publica; SHA ultrapassado não aplica; manual com deploy=false testa Oracle sem trocar current; novo push cancela CI antigo sem cancelar deploy ativo. Não há promessa de ganho exato antes dessas medições.

## Evidências executadas nesta branch

Runs manuais do CI no GitHub, todas aprovadas. Estes tempos incluem fila e CI, **sem publicação nem deploy**. As primeiras três usam o mesmo SHA; a quarta do front valida também a correção de preservação de dados e escopo de erros. Não comparar diretamente com os totais anteriores de CI + deploy.

| Amostra | SHA | Run | Fila inicial | CI após início do primeiro job | Total | Build Docker | Teste Docker |
|---|---|---|---|---|---|---|---|
| 1 — cache inicial | `6e3d4d1` | [43289719912](https://github.com/CaioHPerlin/silverbox-api/actions/runs/43289719912) | 4s | 175s | 180s | 123s | 22s |
| 2 — cache aquecido | `6e3d4d1` | [43290327472](https://github.com/CaioHPerlin/silverbox-api/actions/runs/43290327472) | 4s | 73s | 78s | 21s | 25s |
| 3 — cache aquecido | `6e3d4d1` | [43290606120](https://github.com/CaioHPerlin/silverbox-api/actions/runs/43290606120) | 6s | 71s | 78s | 15s | 26s |

O custo inicial de exportação do cache GHA foi 75s na API. A construção aquecida ficou mais rápida, mas ainda há custo de provisionamento do runner, Buildx, importação da imagem e instalação npm. A validação npm foi executada nas amostras porque são disparos manuais.

Verificações locais: `actionlint` nos dois workflows e sete testes Node da seleção npm/autorização de releases aprovados. Confirmado no GitHub que main não possui branch protection nem regras de checks obrigatórios; nenhuma configuração do repositório foi alterada. Ambos os lockfiles permaneceram intactos.

API: build e 14 testes HTTP aprovados com PostgreSQL temporário; teste Docker aprovado com imagem pré-construída, incluindo persistência após substituição. Nesta máquina o disco estava 95% ocupado: o primeiro teste Docker retornou 507 pela proteção real de espaço. A repetição passou com `STORAGE_MIN_FREE_PERCENT=0 TEST_IMAGE=silverbox-api-test:local npm run test:docker`, apenas no ambiente temporário. Os padrões da aplicação e do CI não foram reduzidos.

A autorização de publicação foi exercitada com testes de lógica (SHA exato, CI falho/cancelado, PR, repositório externo, revisão ultrapassada e disparo manual sem CI). A integração real entre `workflow_run`, publicação ARM64, aplicação e ensaio Oracle manual permanece para depois do merge, pois a política permite releases somente da main aprovada. Não houve alteração da release pública nesta validação.
