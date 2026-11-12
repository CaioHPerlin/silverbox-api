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
