# Catálogo de skills do NumIA

Este diretório reúne skills instaladas automaticamente nos workspaces MCP.

- As skills oficiais incluídas foram copiadas sem modificação do repositório público `anthropics/skills` no commit registrado em `CATALOG.json`. Cada diretório preserva seu próprio `LICENSE.txt` Apache 2.0.
- Skills com licença restrita ao uso de serviços Anthropic não são redistribuídas.
- As skills `anki-apkg` e `document-*` são implementações independentes do projeto NumIA e usam somente bibliotecas locais gratuitas.
- A instalação de uma skill não concede acesso a credenciais e não transforma a skill em ferramenta MCP. Ela orienta o agente executado por `goal_run` dentro do workspace isolado.
