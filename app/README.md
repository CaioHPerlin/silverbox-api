## Versões do ambiente

O projeto usa o **Node.js 24 LTS**. O `package.json` aceita somente versões
da linha 24 (`>=24 <25`) e o npm da linha 11 (`>=11 <12`). As dependências
também estão com versões exatas, sem os prefixos `^` ou `~`, e o
`package-lock.json` deve ser versionado para tornar a instalação reproduzível.

Antes de começar, confira as versões instaladas:

    node --version
    npm --version
