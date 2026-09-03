# NumIA Gemini Server

Backend privado que conecta o NumIA ao **Antigravity CLI oficial do Google**, autenticado com a conta Google AI Pro do proprietário. Não usa Gemini API Key, não replica chamadas internas do Google e nunca envia as credenciais OAuth ao Android.

> Desde 18 de junho de 2026, o Google desativou o login pessoal do antigo Gemini CLI para os planos Individuals, Google AI Pro e Google AI Ultra. O sucessor oficial é o Antigravity CLI (`agy`). O backend usa esse caminho suportado e continua acessando os modelos Gemini da assinatura, incluindo Gemini 3.1 Pro.

## Arquitetura

```text
NumIA Android ──HTTPS/Bearer──> Fastify ──spawn(args[])──> Antigravity CLI oficial
       │                           │                           │
       ├─ texto + IDs de anexos    ├─ SQLite + arquivos        └─ OAuth Google persistido
       └─ recebe SSE               └─ fila/timeout/limpeza         em volume separado
```

O servidor usa SQLite para conversas e histórico. Cada chamada cria uma execução headless do `agy` em modo `plan` + sandbox dentro da pasta isolada da conversa. Imagens do NumIA são salvas temporariamente e abertas pelo caminho absoluto isolado. A saída oficial `stream-json` (JSONL) é convertida em eventos SSE simples para o NumIA.

Os endpoints OpenAI-compatible também aceitam Tool Calling/Function Calling. Quando o cliente envia `tools`, o backend usa saída estruturada do `agy`, valida nome e argumentos e retorna `assistant.tool_calls`; a execução continua sendo responsabilidade do cliente. Sem `tools`, o fluxo anterior de texto, streaming e imagens permanece o mesmo.

## Escolha de hospedagem

**Recomendação: Oracle Cloud Always Free Ampere A1**, com Ubuntu e Docker. A oferta oficial atual inclui até 2 OCPUs/12 GB equivalentes no nível gratuito, embora possa haver falta de capacidade na região. É uma VM persistente e combina bem com OAuth, Docker, SQLite e SSE.

Alternativas:

1. **Google Compute Engine e2-micro**: uma VM e disco persistente de até 30 GB no Free Tier. Funciona, mas 1 GB de RAM é apertado; configure `MAX_GEMINI_PROCESSES=1` e swap. Google AI Pro não deve ser tratado como crédito de infraestrutura do Google Cloud sem uma promoção explícita na sua conta.
2. **Oracle A1 Always Free**: melhor recurso gratuito para este projeto; prefira uma imagem Ubuntu ARM64. A imagem Docker e Node 22 funcionam em ARM64.
3. **Hugging Face Spaces**: CPU Basic pode ser gratuito, porém o disco padrão é efêmero. OAuth e SQLite seriam perdidos após reinício sem um volume/bucket persistente; portanto não é a opção padrão deste projeto.
4. **Koyeb/Render/Railway**: viáveis apenas em plano que mantenha armazenamento e processo; ofertas grátis e suspensão mudam com frequência.
5. **Vercel Functions/Cloudflare Workers**: inadequados para esta arquitetura. São ambientes de função, não um host persistente para o binário e as credenciais do CLI.

## Pré-requisitos

- VM Linux com pelo menos 1 GB de RAM (2 GB ou mais recomendado)
- Docker Engine + plugin Docker Compose
- domínio apontando para o IP da VM (Caddy emitirá HTTPS automaticamente)
- portas TCP 80 e 443 liberadas; não exponha 3000 publicamente

## Instalação na VM

### Opção automática para Windows

Baixe ou clone o repositório em um computador Windows e execute `INSTALAR_AUTOMATICO.bat`. O assistente configura uma VM Linux já criada, gera chaves privadas, instala/inicia o Docker e conduz o login oficial do Google. Ele não cria recursos na Oracle e não modifica faturamento; a VM deve ter sido criada manualmente como Always Free.

Se a instalação já existe e somente a sessão Google do servidor expirou, execute `RECONECTAR_AGY.bat`. Esse segundo assistente refaz apenas o login oficial do `agy`, reinicia o backend e testa a descoberta de modelos. Ele não altera `NUMIA_SERVER_TOKEN`, configuração do NumIA, autorização MCP, dados, volumes ou faturamento.

### Opção manual

```bash
git clone https://github.com/JOAO2666/GEMINICLI-ORACLE.git numia-gemini-server
cd numia-gemini-server
cp .env.example .env
openssl rand -hex 32
```

Edite `.env`:

- cole a saída aleatória em `NUMIA_SERVER_TOKEN`;
- defina `DOMAIN` para o domínio público;
- mantenha `DEFAULT_MODEL=gemini-3.8-flash-high` para usar o Gemini 3.8 Flash;
- deixe `ALLOWED_MODELS` vazio para liberar automaticamente tudo que `agy models` oferecer (Gemini, Claude e GPT-OSS), ou preencha para restringir;
- use `MAX_GEMINI_PROCESSES=1` em VM de 1 GB.

### Primeiro login Google sem navegador na VM

O Antigravity CLI detecta SSH e oferece o fluxo manual oficial: mostra uma URL, você abre em qualquer computador/celular, autoriza e cola o código retornado no terminal. O serviço auxiliar simula esse ambiente para login dentro do container.

```bash
docker compose --profile login run --rm antigravity-login
```

Abra a URL mostrada, entre com sua conta Google AI Pro e cole o código no terminal. Não use Selenium, cookies exportados, senha ou tokens no NumIA.

As credenciais ficam no volume `antigravity-auth`, montado em `/home/node/.gemini`, onde o CLI mantém seu estado. O backend testa a autenticação por `agy models` e nunca devolve credenciais.

### Testar a mesma autenticação

```bash
docker compose --profile login run --rm antigravity-login agy models
docker compose --profile login run --rm antigravity-login agy -p "Responda somente OK" --model gemini-3.1-pro-high
docker compose --profile login run --rm antigravity-login agy -p "Responda somente OK" --model gemini-3.1-pro-high --output-format stream-json --mode plan
```

Se o modelo não estiver disponível, `agy` encerra com erro. O servidor atualiza o catálogo automaticamente e também permite atualização imediata em `POST /api/models/refresh`.

### Recuperar uma sessão Google expirada

No Windows, a opção recomendada é dar duplo clique em `RECONECTAR_AGY.bat`. Para fazer manualmente, conecte-se à VM e execute:

```bash
cd /home/opc/numia-gemini
sudo docker compose --profile login run --rm antigravity-login
sudo docker compose restart server
sudo docker compose --profile login run --rm antigravity-login agy models
```

O login no `agy` de outro computador normalmente cria uma sessão separada e não desconecta o servidor. Se a sessão remota for revogada ou expirar, a API permanece online, mas as chamadas de IA retornam `GEMINI_AUTH_REQUIRED` até esse procedimento ser concluído. Não execute `docker compose down -v`, porque `-v` remove o volume da autenticação.

### Iniciar e sobreviver a reinicializações

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100 server
```

`restart: unless-stopped` reinicia servidor e Caddy depois do reboot. Caddy publica HTTPS e desativa buffering no proxy para preservar SSE.

## Desenvolvimento local

```bash
cp .env.example .env
npm install
npm run dev
npm test
```

Use um token de 32 caracteres ou mais. Em desenvolvimento, `REQUIRE_HTTPS` não bloqueia HTTP local. O binário `agy` precisa estar instalado e autenticado no mesmo ambiente.

## Fluxo de uso

1. Crie uma conversa em `POST /api/conversations`.
2. Envie imagens/PDFs em `POST /api/files?conversationId=...`.
3. Guarde os IDs de anexos retornados.
4. Chame `POST /api/chat/stream` com texto, `conversationId` e `attachmentIds`.
5. Leia cada linha SSE `data:` e acrescente eventos `delta` à mensagem visível.

Veja o [guia rápido em português](docs/GUIA_RAPIDO.md), a [documentação da API](docs/API.md) e a [integração Android](docs/ANDROID.md).

## Servidor MCP remoto

Com `MCP_ENABLED=true`, o mesmo domínio também publica um endpoint Streamable HTTP em `https://SEU-DOMINIO/mcp`. Ele aceita a chave privada do NumIA como Bearer e também oferece OAuth 2.0 com cadastro dinâmico, PKCE e tela de autorização para clientes como Gemini Spark, Claude Desktop, Cursor, Zed e qualquer cliente compatível com MCP.

O servidor oferece **30 ferramentas MCP**, combinando operações isoladas de workspace, catálogo completo de skills e uma **interface completa e segura para o Antigravity CLI (`agy`)**.

## Comandos MCP e Interface do Antigravity CLI

Todas as funcionalidades do Antigravity CLI podem ser controladas diretamente pelo chat de qualquer cliente MCP através de comandos intuitivos ou chamadas de ferramentas:

### Comandos Rápidos de Chat (Slash Commands)

| Comando | Descrição | Ferramenta MCP |
| :--- | :--- | :--- |
| `/models` | Lista todos os modelos disponíveis e destaca o modelo atual (`← atual`) | `models` |
| `/model` | Exibe o modelo ativo do workspace ou do servidor | `model_current` |
| `/model <modelo>` | Altera o modelo do workspace com suporte a aliases (`pro`, `flash`, `sonnet`, `opus`) | `model_set` |
| `/usage` ou `/quota` | Exibe gráfico visual de barras de cota (`████████░░ 82%`) e percentuais | `usage` |
| `/status` | Visão consolidada: saúde do servidor, autenticação do CLI, versão, cotas e workspace | `status` |
| `/help` | Ajuda geral dos comandos disponíveis no Antigravity CLI | `cli_help` |
| `/help <comando>` | Ajuda detalhada, sintaxe e flags de um subcomando específico (`agy <cmd> --help`) | `cli_help` |
| `/update` | Atualização protegida do CLI (com trava contra gerações ativas) | `cli_update` |

### Ferramentas MCP do Antigravity CLI

1. `commands`: Catálogo completo de comandos de chat, ferramentas de workspace e comandos CLI detectados.
2. `models`: Lista modelos de IA detectados dinamicamente via `agy models`, sem listas estáticas hardcoded.
3. `model_current`: Informa o modelo em uso para o workspace selecionado ou padrão global.
4. `model_set`: Define e persiste o modelo no `.workspace.json` do workspace, validando contra o catálogo real.
5. `usage`: Consulta `/usage` oficial e formata barras visuais de progresso e horários de renovação.
6. `usage_last`: Retorna métricas de tokens (prompt, conclusão, total) e duração da última execução de objetivo.
7. `status`: Diagnóstico consolidado de conectividade, autenticação do `agy`, arquivos do workspace e catálogo.
8. `cli_help`: Consulta ajuda geral ou específica do Antigravity CLI diretamente pelo executável do servidor.
9. `cli_update`: Dispara a atualização do CLI de forma protegida, sincronizando o catálogo de modelos logo após.
10. `cli_execute`: Executa subcomandos seguros do binário `agy` (`models`, `changelog`, `agent`, `mcp list`, `plugin list`).
11. `cli_history`: Exibe o histórico higienizado de comandos e execuções realizadas no workspace.

### Persistência de Modelo por Workspace e Fallback Inteligente

- Cada workspace armazena seu modelo selecionado de forma isolada em `.workspace.json`.
- A resolução de modelo em `goal_run` segue rigorosamente:
  1. Modelo explícito fornecido na chamada da ferramenta.
  2. Modelo persistido do workspace (`workspace.selectedModel`).
  3. Modelo padrão global configurado (`DEFAULT_MODEL`).
  4. Primeiro modelo disponível no catálogo do Antigravity CLI.
- Se uma atualização do CLI remover um modelo previamente selecionado, o servidor realiza fallback automático seguro para o padrão e anexa uma nota informativa (`notice`) na resposta, sem quebrar o fluxo de trabalho.

### Segurança e Execução Protegida

- **Sem interpretador de shell**: Comandos do CLI são disparados diretamente via `spawn()` com argumentos em vetor; `sh -c`, `cmd.exe /c` e `bash -c` são estritamente proibidos.
- **Validação rigorosa de argumentos**: Rejeição imediata de caracteres de encadeamento (`|`, `;`, `&`, `&&`, `||`), substituições (`$()`, \`\`, `${}`), injeções de variáveis de ambiente (`%VAR%`), caminhos absolutos arbitrários e path traversal (`..`).
- **Redação ativa de saída**: Tokens Bearer, JWTs, chaves de API e caminhos confidenciais (`.gemini/auth.json`) são automaticamente redigidos antes do envio ao cliente.
- **Proteção de concorrência**: Atualizações do CLI via `cli_update` são adiadas com segurança caso existam gerações ativas.

### Endpoints REST da API CLI

Além do protocolo MCP, o servidor expõe rotas HTTP protegidas por token Bearer:
- `GET /api/cli/commands`: Lista comandos detectados e data da última sincronização.
- `GET /api/cli/help`: Ajuda geral do CLI.
- `GET /api/cli/help/:command`: Ajuda detalhada do subcomando solicitado.
- `POST /api/cli/execute`: Execução segura de comandos autorizados.
- `GET /api/cli/history/:workspaceId`: Consulta o histórico de execuções do workspace.

---

### Ferramentas de Workspace e Skills

As 19 ferramentas de workspace existentes continuam totalmente operacionais: `workspace_create`, `workspace_delete`, `workspace_info`, `file_list`, `file_read`, `file_write`, `file_edit`, `shell_execute`, `git_clone`, `goal_run`, `skill_list`, `skill_catalog`, `skill_read`, `skill_resources`, `skill_install`, `skill_install_catalog`, `skill_remove`, `artifact_list` e `artifact_publish`.

O catálogo incluído instala automaticamente 18 skills em cada workspace: 13 skills oficiais da Anthropic sob Apache 2.0 e cinco skills independentes do NumIA para Anki/APKG, PDF, DOCX, XLSX e PPTX. Skills oficiais com licença restrita ao uso de serviços Anthropic não são redistribuídas. A origem, o commit auditado e todas as exclusões ficam documentados em [`skill-catalog/CATALOG.json`](skill-catalog/CATALOG.json).

- `skill_catalog` mostra o catálogo e a origem de cada skill.
- `skill_install_catalog` instala uma seleção ou todas as skills e permite atualização explícita com `overwrite=true`.
- `skill_remove` move uma skill para a lixeira recuperável.
- Skills personalizadas continuam disponíveis por `skill_install`.
- O caminho canônico é `.agents/skills/<nome>/SKILL.md`, compatível com Antigravity; o caminho legado `.skills` permanece legível.
- `MCP_AUTO_INSTALL_SKILLS=true` instala o catálogo em workspaces novos e completa workspaces existentes na inicialização.

- Arquivos e comandos ficam em workspaces dedicados no volume `mcp-workspaces`.
- Comandos rodam em um serviço separado, sem o volume das credenciais Google e com limites de memória, processos, tempo e saída.
- Exclusão de workspace move os dados para uma lixeira recuperável.
- `git_clone` aceita somente repositórios públicos HTTPS do GitHub.
- Artefatos publicados recebem URLs HTTPS com identificadores aleatórios.
- Clientes compatíveis devem solicitar confirmação do usuário antes das ferramentas marcadas como escrita ou destrutivas.
- Skills adaptadas nunca autorizam APIs Anthropic/OpenAI nem outros serviços pagos; `goal_run` recebe uma regra explícita para usar somente o login Google já configurado e ferramentas locais gratuitas.

Defina `MCP_WORKER_TOKEN` com outro valor aleatório de pelo menos 32 caracteres; ele deve ser diferente de `NUMIA_SERVER_TOKEN` e nunca deve ser enviado ao aplicativo ou versionado.

## Sessões e histórico

O `agy` oferece `--conversation` e o evento `init` fornece `conversation_id`. Este projeto registra o ID, mas **não depende da sessão interna**: recompõe um histórico limitado pelo SQLite e o envia a cada chamada. Esta opção é mais robusta porque:

- não depende do diretório/hash interno onde uma versão do CLI gravou a sessão;
- continua funcionando após atualização ou limpeza das sessões internas;
- torna o histórico inspecionável e permite futuramente trocar o provider;
- evita duas fontes de verdade entre SQLite e o CLI.

O custo é reenviar parte do histórico. `MAX_HISTORY_CHARS` limita esse contexto.

## Modelos, Claude e atualizações automáticas

O catálogo vem diretamente de `agy models`, é renovado a cada 15 minutos e aparece em `GET /api/models`, `GET /models` e `GET /v1/models`. Com `ALLOWED_MODELS=` vazio, novos modelos são liberados automaticamente sem alteração de código ou reinício. A lista atual inclui Gemini 3.8 Flash, Claude Sonnet 4.6, Claude Opus 4.6 Thinking e GPT-OSS, conforme a disponibilidade da conta.

Cada chamada da API seleciona o modelo no campo `model`. No MCP, a ferramenta `goal_run` aceita o mesmo slug no argumento `model`. Para uma atualização imediata, use `POST /api/models/refresh`. Se quiser uma política restrita, preencha `ALLOWED_MODELS` com os slugs permitidos.

`AGY_AUTO_UPDATE=true` verifica e aplica atualizações do CLI na inicialização e a cada seis horas, adiando a ação quando houver geração em andamento. Consulte `GET /api/provider/maintenance` ou force a verificação em `POST /api/provider/update`.

`GET /api/usage` consulta o `/usage` oficial e devolve porcentagem usada/restante e horário de renovação para os grupos Gemini e Claude/GPT.

## Atualização segura do Antigravity CLI

1. A atualização automática cobre o processo em execução; reconstrua a imagem periodicamente para persistir a versão após recriar o container.
2. Execute os três testes de login/JSON acima em uma janela de manutenção.
3. Reconstrua: `docker compose build --pull server antigravity-login`.
4. Suba: `docker compose up -d`.

Os volumes `antigravity-auth` e `numia-data` não são removidos por rebuild. **Não execute `docker compose down -v`**, pois `-v` apaga ambos.

## Backup sem copiar OAuth

Faça backup somente do volume `numia-data`, que contém SQLite e anexos. Não inclua `antigravity-auth`. Exemplo:

```bash
docker run --rm -v numia-gemini-server_numia-data:/source:ro -v "$PWD/backups:/backup" alpine \
  tar czf /backup/numia-data-$(date +%F).tgz -C /source .
```

Para consistência máxima, pare o servidor durante a cópia ou use a API de backup do SQLite. O token do NumIA também não deve entrar no backup; ele permanece no `.env` da VM.

## Limitações importantes

- A assinatura Google AI Pro controla acesso/quota do CLI, não garante que um nome específico de modelo esteja disponível.
- O endpoint de status valida a sessão executando `agy models`; falhas de login são convertidas em `GEMINI_AUTH_REQUIRED` para manter compatibilidade com o NumIA.
- O SSE usa POST. Se a conexão cair, o subprocesso é cancelado. O Android não deve reenviar automaticamente a mesma mensagem, pois isso criaria outro turno.
- Os arquivos expiram após `FILE_RETENTION_HOURS`; os registros de conversa/mensagem permanecem até a conversa ser excluída.
- O backend analisa anexos. O modo `plan` impede mutações, mas o host ainda deve ser dedicado e sem outros dados sensíveis.

## Fontes oficiais verificadas

- [Descontinuação do login pessoal no Gemini CLI](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals?hl=pt-br)
- [Antigravity CLI: modo headless e stream-json](https://antigravity.google/docs/cli/headless/)
- [Antigravity CLI: instalação e autenticação](https://antigravity.google/docs/cli/install/)
- [Antigravity CLI: modos de execução](https://antigravity.google/docs/cli/modes/)
- [Antigravity CLI: boas práticas e arquivos](https://antigravity.google/docs/cli/best-practices/)
