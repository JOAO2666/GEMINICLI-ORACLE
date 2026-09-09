# NumIA Gemini Server

Backend privado de alto desempenho que conecta qualquer aplicação ao **Antigravity CLI oficial do Google**, autenticado com a conta Google AI Pro do proprietário. Não usa Gemini API Key tradicional, não replica chamadas internas do Google e nunca envia as credenciais OAuth aos clientes. Oferece acesso aos modelos disponibilizados para a conta via API REST/SSE, Servidor MCP e Controle Remoto Web oficial. O acesso continua sujeito às cotas, limites e regras da conta Google; este projeto não promete uso ilimitado.

> Desde 18 de junho de 2026, o Google desativou o login pessoal do antigo Gemini CLI para os planos Individuals, Google AI Pro e Google AI Ultra. O sucessor oficial é o Antigravity CLI (`agy`). O backend usa esse caminho suportado e continua acessando os modelos Gemini da assinatura, incluindo Gemini 3.1 Pro.

## Arquitetura

```text
Aplicações / Clientes ──HTTPS/Bearer──> Fastify ──spawn(args[])──> Antigravity CLI oficial
(Web, Mobile, MCP)          │                           │                           │
                            ├─ texto + IDs de anexos    ├─ SQLite + arquivos        └─ OAuth Google persistido
                            └─ recebe SSE               └─ fila/timeout/limpeza         em volume separado
```

O servidor usa SQLite para conversas e histórico. Cada chamada cria uma execução headless do `agy` em modo `plan` + sandbox dentro da pasta isolada da conversa. Imagens e arquivos são salvos temporariamente e abertos pelo caminho absoluto isolado. A saída oficial `stream-json` (JSONL) é convertida em eventos SSE simples para as aplicações clientes.

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

Baixe ou clone o repositório em um computador Windows e utilize os assistentes prontos:

- `INSTALAR_AUTOMATICO.bat`: Configura uma VM Linux já criada, gera chaves privadas, instala/inicia o Docker e conduz o login oficial do Google. Ele não cria recursos na Oracle e não modifica faturamento; a VM deve ter sido criada manualmente como Always Free.
- `RECONECTAR_AGY.bat`: Refaz apenas o login oficial do `agy` caso a sessão Google expire, reinicia o backend e testa a descoberta de modelos. Ele não altera `NUMIA_SERVER_TOKEN`, autorização MCP, dados, volumes ou faturamento.
- `CONTROLE_REMOTO_ORACLE.bat`: Verifica em tempo real o status e a conectividade do daemon de Controle Remoto do Antigravity na Oracle VM, garantindo que o `oracle-pc` esteja ativo e visível no painel oficial em `https://antigravity.google.com/`.

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
- mantenha `VISION_MODEL=gemini-3.6-flash-high` para analisar imagens com o Flash mais rápido e estável na VM pequena, mesmo quando uma conversa de texto estiver no Pro;
- deixe `ALLOWED_MODELS` vazio para liberar automaticamente tudo que `agy models` oferecer (Gemini, Claude e GPT-OSS), ou preencha para restringir;
- use `MAX_GEMINI_PROCESSES=1` em VM de 1 GB.

### Primeiro login Google sem navegador na VM

O Antigravity CLI detecta SSH e oferece o fluxo manual oficial: mostra uma URL, você abre em qualquer computador/celular, autoriza e cola o código retornado no terminal. O serviço auxiliar simula esse ambiente para login dentro do container.

```bash
docker compose --profile login run --rm antigravity-login
```

Abra a URL mostrada, entre com sua conta Google AI Pro e cole o código no terminal. Não use Selenium, cookies exportados, senha ou tokens nas aplicações clientes.

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

## Duas Formas de Acesso Remoto

O projeto disponibiliza **duas formas complementares** de integração e controle remoto do Antigravity CLI e dos seus modelos:

### Opção 1: Servidor MCP Remoto (`https://SEU-DOMINIO/mcp`)

Com `MCP_ENABLED=true`, o mesmo domínio publica um endpoint Streamable HTTP em `https://SEU-DOMINIO/mcp`. Ele aceita a chave privada do servidor como Bearer e também oferece OAuth 2.0 com cadastro dinâmico, PKCE e tela de autorização para clientes como Gemini Spark, Claude Desktop, Cursor, Zed e qualquer cliente compatível com MCP.

O servidor oferece **30 ferramentas MCP**, combinando operações isoladas de workspace, catálogo completo de skills e uma **interface completa e segura para o Antigravity CLI (`agy`)**.

### Opção 2: Google Antigravity Remote Control Oficial (`https://antigravity.google.com/`)

Permite conectar e controlar suas sessões de agentes diretamente de **qualquer navegador web** (desktop ou mobile), sem a necessidade de softwares adicionais:

1. **Acesso Direto**: Acesse [https://antigravity.google.com/](https://antigravity.google.com/) logado com sua conta Google AI Pro.
2. **Instância Dedicada**: O servidor na nuvem aparece listado automaticamente sob **Remote Control Instances** como **`oracle-pc`** (🟢 Online), com o botão **Connect**.
3. **Persistência via systemd**: O daemon do CLI roda como serviço nativo do sistema (`antigravity-cli-daemon.service`) com *linger* ativo (`loginctl enable-linger opc`) e montagem persistente em `/etc/fstab`, sobrevivendo a reinicializações e desconexões SSH.
4. **Gerenciador 1-Clique no Windows**: Execute [CONTROLE_REMOTO_ORACLE.bat](CONTROLE_REMOTO_ORACLE.bat) na raiz do projeto para auditar o status do daemon em tempo real.

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

### Agent Orchestrator (Novas Ferramentas High-Level)

Para que clientes como **YhikkaHub** e **Gemini Spark** criem documentos e executem tarefas completas em uma única chamada de linguagem natural sem encadear dezenas de ferramentas manuais, foram adicionadas 4 ferramentas orquestradoras de alto nível:

1. **`artifact_create`**: Recebe um pedido ("Faça um PDF sobre...", "Crie um documento Word", "Crie uma planilha de gastos", "Faça uma apresentação de slides", "Crie 100 flashcards para o Anki"). Detecta deterministicamente o formato (`pdf`, `docx`, `xlsx`, `pptx`, `apkg`), cria ou reutiliza o workspace, instala a skill necessária (`document-pdf`, `document-docx`, `document-xlsx`, `document-pptx`, `anki-apkg`), executa o agente, valida a integridade do arquivo antes de publicar e retorna os metadados com URL assinada.
2. **`task_run`**: Orquestrador para tarefas complexas de desenvolvimento e análise. Cria/reutiliza workspace, clona repositório se solicitado, executa objetivo, roda verificações e sumariza alterações.
3. **`artifact_revise`**: Continua trabalhando sobre um artefato já gerado, aplicando alterações solicitadas pelo usuário.
4. **`artifact_get`**: Recupera metadados detalhados de um artefato e gera uma nova URL de download assinada com expiração atualizada.

---

### Ferramentas de Workspace e Skills (Total: 34 ferramentas MCP)

Todas as ferramentas low-level originais permanecem 100% disponíveis com contratos estritos inalterados:
- **Workspaces**: `workspace_create`, `workspace_delete`, `workspace_info`
- **Arquivos**: `file_list`, `file_read`, `file_write`, `file_edit`
- **Execução e Autonomia**: `shell_execute`, `git_clone`, `goal_run`
- **Skills**: `skill_list`, `skill_catalog`, `skill_read`, `skill_resources`, `skill_install`, `skill_install_catalog`, `skill_remove`
- **Artefatos**: `artifact_list`, `artifact_publish`, `artifact_create`, `task_run`, `artifact_revise`, `artifact_get`
- **Modelos e Status**: `models`, `model_current`, `model_set`, `status`, `usage`, `usage_last`, `commands`, `cli_help`, `cli_execute`, `cli_history`, `cli_update`

O catálogo incluído instala automaticamente 18 skills em cada workspace: 13 skills oficiais da Anthropic sob Apache 2.0 e cinco skills independentes do NumIA para Anki/APKG, PDF, DOCX, XLSX e PPTX. Skills oficiais com licença restrita ao uso de serviços Anthropic não são redistribuídas. A origem, o commit auditado e todas as exclusões ficam documentados em [`skill-catalog/CATALOG.json`](skill-catalog/CATALOG.json).

- `skill_catalog` mostra o catálogo e a origem de cada skill.
- `skill_install_catalog` instala uma seleção ou todas as skills e permite atualização explícita com `overwrite=true`.
- `skill_remove` move uma skill para a lixeira recuperável.
- Skills personalizadas continuam disponíveis por `skill_install`.
- O caminho canônico é `.agents/skills/<nome>/SKILL.md`, compatível com Antigravity; o caminho legado `.skills` permanece legível.
- `MCP_AUTO_INSTALL_SKILLS=true` instala o catálogo em workspaces novos e completa workspaces existentes na inicialização.

### Segurança, Isolamento e Validação de Artefatos

- **Validação de Integridade**: Antes da publicação de artefatos, PDFs são validados verificando assinatura `%PDF-`, finalizadores `%%EOF` e contagem de páginas; documentos Office (DOCX, XLSX, PPTX) e APKG são validados quanto à integridade do arquivo compactado e descritores essenciais.
- **Download Seguro com URLs Assinadas**: Os links de download (`/artifacts/:workspaceId/:artifactId/:filename?expires=...&sig=...`) usam HMAC-SHA256 e comparação em tempo constante (`timingSafeEqual`), permitindo abrir diretamente no navegador ou clientes sem exigir headers de autenticação adicionais, mas expirando após o prazo configurado.
- **Isolamento de Workspaces**: Traversal de caminhos (`..`, `/`, `\`) é bloqueado com verificação canônica estrita. No executor (`worker-server`), cada execução recebe um diretório temporário isolado (`TMPDIR`/`HOME`) que é destruído ao final. Em Linux, o isolamento com `bubblewrap` isola o volume `/workspaces` garantindo que o Workspace A não enxergue nem acesse arquivos do Workspace B.
- **`MCP_WORKER_ISOLATION`**: Modo `compat` (padrão) ou `strict`. No modo `strict`, o servidor valida a disponibilidade do mecanismo de sandbox e, caso não esteja disponível, reporta o estado degradado em `/health/ready` e rejeita comandos não isolados com 503.
- **Fila Concorrente Delimitada**: O semáforo de requisições conta com `MAX_QUEUE_DEPTH` (retornando 429 QUEUE_FULL em sobrecarga) e `QUEUE_WAIT_TIMEOUT_MS` (retornando 504 QUEUE_TIMEOUT).
- **Maintenance Lock**: Leituras/inferências adquirem lock compartilhado, enquanto a atualização do CLI (`agy update`) adquire lock exclusivo, impedindo que atualizações ocorram durante gerações ativas.
- **Model Versioning e Aliases**: Comparação de versões numéricas por tuplas (`3.10 > 3.9`) e aliases dinâmicos (`latest`, `latest-flash`, `latest-pro`, `latest-sonnet`, `latest-opus`).
- **Observabilidade**: Endpoints `GET /health` (básico), `GET /health/live` (processo) e `GET /health/ready` (prontidão do banco, autenticação Google e worker sandbox).

Defina `MCP_WORKER_TOKEN` com outro valor aleatório de pelo menos 32 caracteres; ele deve ser diferente de `NUMIA_SERVER_TOKEN` e nunca deve ser enviado ao aplicativo ou versionado.

## StorageGuardian: Gestão Autônoma de Disco e Política de 24 Horas

Para evitar que o disco da Oracle VM atinja 100% de ocupação com acúmulo de arquivos gerados e uploads, o servidor conta com o **StorageGuardian**:

1. **Política Estrita de 24 Horas (Descartável por Padrão)**:
   - Todo arquivo gerado (PDF, DOCX, XLSX, PPTX, APKG, TXT, CSV, HTML, Markdown), upload, anexo e workspace temporário criado automaticamente por tarefas tem vida útil máxima de **24 horas**.
   - Após 24 horas da criação, o recurso é fisicamente excluído do disco pelo StorageGuardian e sua URL/metadados são invalidados (retornando 410 Gone / 404).
   - Sem sistema de "pin" ou guardar permanente: arquivos gerados são intencionalmente descartáveis.
   - Baixar ou reabrir o arquivo não renova o prazo de 24 horas.

2. **Caminhos Sagrados e Proteção de Dados Essenciais**:
   - O StorageGuardian possui proteção de caminhos imunes (`isSacredPath`).
   - **NUNCA são tocados**: credenciais OAuth Google (`/home/node/.gemini`, `antigravity-auth`), `.env`, banco de dados SQLite (`numia.db*`), `docker-compose.yml`, `Caddyfile`, catálogo original de skills e workspaces com tarefas em execução ativa (travados via *lease*).

3. **Política Progressiva de Pressão de Disco**:
   - `< 75%`: Operação normal.
   - `75% - 84%`: Warning; execução de limpeza periódica normal (a cada 15 min).
   - `85% - 89%`: Limpeza imediata de expirados e temporários antigos.
   - `90% - 94%`: Limpeza agressiva (remove temporários mais antigos mesmo antes de completarem 24h).
   - `95% - 97%`: Limpeza crítica imediata de todo temporário sem lock.
   - `>= 98%`: Hard stop para novas operações pesadas de escrita (`INSUFFICIENT_STORAGE`), preservando leitura, status, diagnóstico e `/health`.

4. **Ferramentas MCP e Comandos Rápidos**:
   - `/storage` ou ferramenta `storage_status`: exibe status de disco, ocupação detalhada e última limpeza.
   - Ferramenta `storage_cleanup`: executa limpeza manual imediata sob demanda.

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

Para consistência máxima, pare o servidor durante a cópia ou use a API de backup do SQLite. O token do servidor também não deve entrar no backup; ele permanece no `.env` da VM.

## Limitações importantes

- A assinatura Google AI Pro controla acesso/quota do CLI, não garante que um nome específico de modelo esteja disponível.
- O endpoint de status valida a sessão executando `agy models`; falhas de login são convertidas em `GEMINI_AUTH_REQUIRED` para sinalizar a necessidade de reautenticação.
- O SSE usa POST. Se a conexão cair, o subprocesso é cancelado. Os clientes não devem reenviar automaticamente a mesma mensagem sem necessidade, pois isso criaria outro turno.
- Os arquivos expiram após `FILE_RETENTION_HOURS`; os registros de conversa/mensagem permanecem até a conversa ser excluída.
- O backend analisa anexos. O modo `plan` impede mutações, mas o host ainda deve ser dedicado e sem outros dados sensíveis.

## Fontes oficiais verificadas

- [Descontinuação do login pessoal no Gemini CLI](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals?hl=pt-br)
- [Antigravity CLI: modo headless e stream-json](https://antigravity.google/docs/cli/headless/)
- [Antigravity CLI: instalação e autenticação](https://antigravity.google/docs/cli/install/)
- [Antigravity CLI: modos de execução](https://antigravity.google/docs/cli/modes/)
- [Antigravity CLI: boas práticas e arquivos](https://antigravity.google/docs/cli/best-practices/)
