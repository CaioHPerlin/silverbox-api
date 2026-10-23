-- Esquema MÍNIMO de partida do projeto "Minha Nuvem".
-- Isto é um ponto de partida, não a resposta: adapte, renomeie e expanda
-- conforme as suas decisões de projeto. Você precisa saber explicar cada tabela.

CREATE TABLE IF NOT EXISTS usuarios (
    id             BIGSERIAL PRIMARY KEY,
    email          TEXT        NOT NULL UNIQUE,
    senha_hash     TEXT        NOT NULL,          -- NUNCA a senha em texto puro
    papel          TEXT        NOT NULL DEFAULT 'usuario',  -- 'usuario' | 'admin'
    cota_bytes     BIGINT      NOT NULL DEFAULT 1073741824, -- 1 GiB
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arquivos (
    id             BIGSERIAL PRIMARY KEY,
    usuario_id     BIGINT      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nome           TEXT        NOT NULL,          -- nome que o usuário vê
    chave_objeto   TEXT        NOT NULL UNIQUE,   -- chave no armazenamento de objetos
    tamanho_bytes  BIGINT      NOT NULL,
    tipo_conteudo  TEXT,
    checksum       TEXT,                          -- RF18
    na_lixeira     BOOLEAN     NOT NULL DEFAULT FALSE,  -- RF09
    versao         INTEGER     NOT NULL DEFAULT 1,      -- RF10
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arquivos_usuario ON arquivos (usuario_id, na_lixeira);

CREATE TABLE IF NOT EXISTS compartilhamentos (          -- RF11
    id             BIGSERIAL PRIMARY KEY,
    arquivo_id     BIGINT      NOT NULL REFERENCES arquivos(id) ON DELETE CASCADE,
    token          TEXT        NOT NULL UNIQUE,
    expira_em      TIMESTAMPTZ NOT NULL,
    criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auditoria (                  -- RF15
    id             BIGSERIAL PRIMARY KEY,
    usuario_id     BIGINT      REFERENCES usuarios(id) ON DELETE SET NULL,
    acao           TEXT        NOT NULL,   -- 'login' | 'upload' | 'download' | ...
    alvo           TEXT,
    ip             INET,
    ocorrido_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_tempo ON auditoria (ocorrido_em DESC);

-- Consulta de apoio ao painel de uso (RF14) e à cota (RF12):
-- SELECT usuario_id, SUM(tamanho_bytes) AS usado
--   FROM arquivos WHERE na_lixeira = FALSE GROUP BY usuario_id;
