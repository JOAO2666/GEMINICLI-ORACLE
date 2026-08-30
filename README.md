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

```bash
git clone https://github.com/JOAO2666/GEMINICLI-ORACLE.git numia-gemini-server
cd numia-gemini-server
cp .env.example .env
openssl rand -hex 32
```

Edite `.env`:

- cole a saída aleatória em `NUMIA_SERVER_TOKEN`;
- defina `DOMAIN` para o domínio público;
- mantenha `DEFAULT_MODEL=gemini-3.1-pro-high` para usar o Gemini 3.1 Pro;
- ajuste `ALLOWED_MODELS` somente para nomes que pretende permitir;
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

Se o modelo não estiver disponível, `agy` encerra com erro. Consulte os slugs liberados para a conta com `agy models` e ajuste a allowlist.

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

Com `MCP_ENABLED=true`, o mesmo domínio também publica um endpoint Streamable HTTP em `https://SEU-DOMINIO/mcp`. Ele aceita a chave privada do NumIA como Bearer e também oferece OAuth 2.0 com cadastro dinâmico, PKCE e tela de autorização para clientes como Gemini Spark.

As 16 ferramentas disponíveis são `goal_run`, `skill_list`, `skill_read`, `skill_resources`, `skill_install`, `workspace_create`, `workspace_delete`, `workspace_info`, `shell_execute`, `file_list`, `file_read`, `file_write`, `file_edit`, `git_clone`, `artifact_list` e `artifact_publish`.

- Arquivos e comandos ficam em workspaces dedicados no volume `mcp-workspaces`.
- Comandos rodam em um serviço separado, sem o volume das credenciais Google e com limites de memória, processos, tempo e saída.
- Exclusão de workspace move os dados para uma lixeira recuperável.
- `git_clone` aceita somente repositórios públicos HTTPS do GitHub.
- Artefatos publicados recebem URLs HTTPS com identificadores aleatórios.
- Clientes compatíveis devem solicitar confirmação do usuário antes das ferramentas marcadas como escrita ou destrutivas.

Defina `MCP_WORKER_TOKEN` com outro valor aleatório de pelo menos 32 caracteres; ele deve ser diferente de `NUMIA_SERVER_TOKEN` e nunca deve ser enviado ao aplicativo ou versionado.

## Sessões e histórico

O `agy` oferece `--conversation` e o evento `init` fornece `conversation_id`. Este projeto registra o ID, mas **não depende da sessão interna**: recompõe um histórico limitado pelo SQLite e o envia a cada chamada. Esta opção é mais robusta porque:

- não depende do diretório/hash interno onde uma versão do CLI gravou a sessão;
- continua funcionando após atualização ou limpeza das sessões internas;
- torna o histórico inspecionável e permite futuramente trocar o provider;
- evita duas fontes de verdade entre SQLite e o CLI.

O custo é reenviar parte do histórico. `MAX_HISTORY_CHARS` limita esse contexto.

## Modelos

O CLI possui `agy models`. `GET /api/models` cruza a descoberta real com `ALLOWED_MODELS`, portanto apenas modelos simultaneamente disponíveis e autorizados são retornados. O servidor nunca aceita esse valor como argumento arbitrário. Um modelo novo não é habilitado automaticamente: confirme o slug com `agy models`, inclua-o em `ALLOWED_MODELS` e recrie o serviço. Essa allowlist evita que uma mudança externa selecione um modelo inesperado.

## Atualização segura do Antigravity CLI

1. Consulte a release oficial e reconstrua a imagem; o Dockerfile usa o instalador oficial do `agy`.
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
