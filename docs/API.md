# API NumIA Gemini Server

URL base: `https://SEU_DOMINIO`. Todas as rotas `/api/*` exigem:

```http
Authorization: Bearer SEU_NUMIA_SERVER_TOKEN
Content-Type: application/json
```

## Compatibilidade com o aplicativo numAi

O servidor também aceita o formato OpenAI usado pelo aplicativo
[gohoski/numAi](https://github.com/gohoski/numAi):

- URL base: `https://SEU_DOMINIO` (sem `/api` ou `/v1`)
- Chave de API: o valor de `NUMIA_SERVER_TOKEN`
- Modelos: `GET /models`
- Chat: `POST /chat/completions`

As variantes `/v1/models` e `/v1/chat/completions` também são aceitas. Texto e imagens
locais em Data URL são suportados. URLs remotas de imagem são recusadas por segurança.
Requisições com imagens usam o modelo selecionado no campo `model`. `VISION_MODEL`
é opcional e, quando preenchido, força esse modelo somente para mensagens com imagens.

## OpenAI Tool Calling

`POST /chat/completions` e `POST /v1/chat/completions` aceitam `tools`, `tool_choice`,
`parallel_tool_calls`, mensagens `role=tool` e `assistant.tool_calls`. Quando `tools` não
é enviado (ou é uma lista vazia), o fluxo legado permanece inalterado.

O servidor apenas permite que o modelo **solicite** funções. Ele não executa as ferramentas
recebidas e não as conecta automaticamente ao `/mcp`. O cliente executa a função ou MCP e
envia o resultado em uma nova requisição.

Exemplo de solicitação:

```json
{
  "model": "gemini-3.7-flash-high",
  "messages": [
    { "role": "user", "content": "Qual é a hora atual? Use a ferramenta." }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_current_time",
        "description": "Returns the current time",
        "parameters": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        }
      }
    }
  ]
}
```

Resposta quando o modelo solicita a função:

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_ID_UNICO",
            "type": "function",
            "function": {
              "name": "get_current_time",
              "arguments": "{}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

Depois de executar a função, o cliente deve preservar a mensagem `assistant` acima e
acrescentar o resultado com o mesmo ID:

```json
{
  "model": "gemini-3.7-flash-high",
  "messages": [
    { "role": "user", "content": "Qual é a hora atual? Use a ferramenta." },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_ID_UNICO",
          "type": "function",
          "function": { "name": "get_current_time", "arguments": "{}" }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_ID_UNICO",
      "content": "2026-08-31T10:30:00-03:00"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_current_time",
        "parameters": { "type": "object", "properties": {} }
      }
    }
  ]
}
```

O modelo poderá responder normalmente ou solicitar outra função. Os nomes são limitados às
ferramentas da requisição e os argumentos são validados novamente contra o JSON Schema.
No streaming, as chamadas aparecem em `choices[0].delta.tool_calls` e o último chunk usa
`finish_reason: "tool_calls"`.

## Saúde e disponibilidade

```bash
curl https://SEU_DOMINIO/health
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/provider/status
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/gemini/status
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/models
curl -X POST -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/models/refresh
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/usage
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/provider/maintenance
```

`authenticated: true` indica que há credencial OAuth em cache; a validade efetiva é confirmada ao fazer uma geração. Todos os slugs retornados em `/api/models`, inclusive Claude, podem ser usados no campo `model` da API e no argumento `model` de `goal_run` no MCP.

## Conversas

Criar:

```bash
curl -X POST https://SEU_DOMINIO/api/conversations \
  -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.1-pro-high"}'
```

Listar e obter detalhes:

```bash
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/conversations
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/conversations/CONVERSATION_ID
```

Excluir conversa, histórico e anexos:

```bash
curl -X DELETE -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" \
  https://SEU_DOMINIO/api/conversations/CONVERSATION_ID
```

## Upload

Tipos aceitos: JPG/JPEG, PNG, WEBP, PDF e extensões comuns de texto/código. O servidor valida a assinatura real de binários, limita tamanho/quantidade, troca o nome por UUID e não devolve o caminho local.

```bash
curl -X POST "https://SEU_DOMINIO/api/files?conversationId=CONVERSATION_ID" \
  -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" \
  -F "files=@imagem1.jpg" \
  -F "files=@imagem2.jpg" \
  -F "files=@documento.pdf"
```

Resposta:

```json
{
  "attachments": [
    { "id": "uuid", "original_name": "imagem1.jpg", "mime_type": "image/jpeg", "size": 12345, "storedName": "uuid.jpg" }
  ]
}
```

## Mensagem sem streaming

```bash
curl -X POST https://SEU_DOMINIO/api/chat \
  -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId":"CONVERSATION_ID",
    "message":"Analise estas duas imagens e este PDF.",
    "model":"gemini-3.1-pro-high",
    "attachmentIds":["ID_1","ID_2","ID_3"]
  }'
```

Também existe `POST /api/conversations/:id/message`, com o mesmo corpo sem `conversationId`.

## Mensagem em streaming SSE

```bash
curl -N -X POST https://SEU_DOMINIO/api/chat/stream \
  -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId":"CONVERSATION_ID",
    "message":"Analise estas duas imagens e este PDF.",
    "attachmentIds":["ID_1","ID_2","ID_3"]
  }'
```

Cada frame possui uma linha `data: JSON`:

```json
{"type":"start","conversationId":"...","model":"...","sessionId":"..."}
{"type":"delta","text":"Primeiro trecho"}
{"type":"tool","name":"read_many_files","status":"running"}
{"type":"complete","text":"Resposta completa","conversationId":"..."}
```

Erros durante o stream também são eventos:

```json
{"type":"error","code":"GEMINI_AUTH_REQUIRED","message":"O Antigravity CLI precisa ser autenticado novamente no servidor."}
```

Fechar a conexão cancela o subprocesso. Para cancelamento explícito:

```bash
curl -X DELETE -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" \
  https://SEU_DOMINIO/api/conversations/CONVERSATION_ID/generation
```

## Skills no servidor MCP

O endpoint `/mcp` oferece `skill_catalog`, `skill_install_catalog`, `skill_list`, `skill_read`, `skill_resources`, `skill_install` e `skill_remove`. Por padrão, cada workspace recebe todas as skills compatíveis do catálogo em `.agents/skills/`.

O catálogo possui 18 skills: 13 cópias não modificadas das skills oficiais Apache 2.0 da Anthropic e cinco implementações independentes para `anki-apkg`, `document-pdf`, `document-docx`, `document-xlsx` e `document-pptx`. O servidor não inclui skills cuja licença restringe o uso aos serviços Anthropic.

As skills orientam o agente interno de `goal_run`; elas não se tornam ferramentas OpenAI nem recebem acesso às credenciais do servidor. Instruções específicas do Claude são adaptadas semanticamente para as ferramentas locais, e o agente é proibido de instalar ou chamar APIs pagas.

Variáveis relacionadas:

- `SKILL_CATALOG_DIR`: diretório somente leitura do catálogo empacotado.
- `MCP_AUTO_INSTALL_SKILLS`: com `true`, instala skills ausentes em workspaces novos e existentes sem sobrescrever personalizações.

## Códigos de erro relevantes

- `UNAUTHORIZED` — token do NumIA inválido
- `HTTPS_REQUIRED` — produção acessada sem HTTPS
- `MODEL_NOT_ALLOWED` — modelo não está na allowlist
- `GEMINI_MODEL_UNAVAILABLE` — Google/CLI não disponibilizou o modelo
- `GEMINI_AUTH_REQUIRED` — faça novamente o login no servidor
- `GEMINI_QUOTA_EXCEEDED` — quota/limite atingido
- `AI_TIMEOUT` — geração excedeu o tempo configurado
- `CONVERSATION_BUSY` — já existe geração nessa conversa
- `FILE_TOO_LARGE` / `UNSUPPORTED_FILE_TYPE` — upload recusado
