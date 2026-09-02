# Backup do NumIA Antigravity Server

Este pacote contém o código-fonte, testes, documentação, scripts de instalação,
configuração Docker/Caddy e o catálogo de skills necessários para reconstruir o projeto.

## Itens excluídos de propósito

- `.env` e tokens privados;
- sessão OAuth do Google/Antigravity;
- `data/` (conversas, anexos e autorizações MCP);
- `node_modules/`, `dist/`, caches, logs e ferramentas locais.

## Restauração

1. Extraia o ZIP.
2. Copie `.env.example` para `.env` e gere tokens novos.
3. Execute `npm install`, `npm test` e `npm run build`.
4. Autentique o Antigravity CLI novamente.

Os modelos são descobertos automaticamente por `agy models`. O campo `model` da
API e da ferramenta MCP `goal_run` aceita qualquer slug retornado pelo servidor,
incluindo Gemini, Claude e GPT-OSS.
