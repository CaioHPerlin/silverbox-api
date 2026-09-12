# Esta pasta é sua

O kit inicial entrega a infraestrutura pronta (proxy, armazenamento de objetos
e banco). **A aplicação é o seu trabalho** — é ela que vale nota.

Para o `docker compose up -d` funcionar por inteiro, crie aqui:

1. **`Dockerfile`** — que construa a sua aplicação e a faça ouvir na **porta 8000**;
2. o código, na linguagem e no framework que você escolher.

Enquanto a aplicação não existir, suba só a infraestrutura:

    docker compose up -d db minio

Regras que a aplicação precisa respeitar:

- **Sem estado** (RNF08): nada de gravar arquivo, sessão ou cache no disco do
  container. Arquivo vai para o MinIO; metadado vai para o PostgreSQL.
- Ler toda a configuração das **variáveis de ambiente** já definidas no
  `docker-compose.yml` — nunca com valores fixos no código.
- Aplicar a **cota também na API** (RF12), não só na interface web.
- Nunca confiar no nome de arquivo enviado pelo usuário: sanitize antes de usar.
