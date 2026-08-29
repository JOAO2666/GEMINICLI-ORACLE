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
Requisições do NumIA que contenham imagens são encaminhadas automaticamente ao modelo
definido em `VISION_MODEL` (por padrão, `gemini-3.7-flash-low`), mesmo quando o botão de
raciocínio estiver selecionado.

## Saúde e disponibilidade

```bash
curl https://SEU_DOMINIO/health
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/provider/status
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/gemini/status
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/models
```

`authenticated: true` indica que há credencial OAuth em cache; a validade efetiva é confirmada ao fazer uma geração.

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
