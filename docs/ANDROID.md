# Integração Android NumIA (Kotlin)

O Android conhece somente `NUMIA_BACKEND_URL` e `NUMIA_SERVER_TOKEN`. Nunca recebe cookies, refresh token ou qualquer arquivo de `antigravity-auth`.

## Dependências

Use versões estáveis atuais de Retrofit, OkHttp, conversor Moshi e coroutines:

```kotlin
implementation("com.squareup.retrofit2:retrofit:<versao>")
implementation("com.squareup.retrofit2:converter-moshi:<versao>")
implementation("com.squareup.okhttp3:okhttp:<versao>")
implementation("com.squareup.moshi:moshi-kotlin:<versao>")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:<versao>")
```

## Modelos

```kotlin
data class CreateConversationRequest(val model: String = "gemini-3.1-pro-high")
data class ConversationDto(val id: String, val model: String)

data class ChatRequest(
    val conversationId: String,
    val message: String,
    val model: String? = null,
    val attachmentIds: List<String> = emptyList()
)

data class AttachmentDto(
    val id: String,
    val original_name: String,
    val mime_type: String,
    val size: Long
)

data class UploadResponse(val attachments: List<AttachmentDto>)

sealed interface StreamEvent {
    data class Start(val conversationId: String, val model: String?) : StreamEvent
    data class Delta(val text: String) : StreamEvent
    data class Tool(val name: String, val status: String) : StreamEvent
    data class Complete(val text: String, val conversationId: String) : StreamEvent
    data class Error(val code: String, val message: String) : StreamEvent
}
```

## Bearer e Retrofit

Guarde o token com Android Keystore/EncryptedSharedPreferences, não em código ou no repositório.

```kotlin
class BearerInterceptor(private val tokenProvider: () -> String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header("Authorization", "Bearer ${tokenProvider()}")
            .build()
        return chain.proceed(request)
    }
}

interface NumiaBackendApi {
    @POST("api/conversations")
    suspend fun createConversation(
        @Body request: CreateConversationRequest
    ): ConversationDto

    @GET("api/conversations/{id}")
    suspend fun getConversation(@Path("id") id: String): ConversationDto

    @Multipart
    @POST("api/files")
    suspend fun uploadFiles(
        @Query("conversationId") conversationId: String,
        @Part files: List<MultipartBody.Part>
    ): UploadResponse

    @DELETE("api/conversations/{id}/generation")
    suspend fun cancel(@Path("id") conversationId: String)
}

val okHttp = OkHttpClient.Builder()
    .addInterceptor(BearerInterceptor { secureTokenStore.read() })
    .readTimeout(0, TimeUnit.MILLISECONDS) // o stream tem timeout no servidor
    .build()

val retrofit = Retrofit.Builder()
    .baseUrl(BuildConfig.NUMIA_BACKEND_URL) // precisa terminar com /
    .client(okHttp)
    .addConverterFactory(MoshiConverterFactory.create())
    .build()

val api = retrofit.create(NumiaBackendApi::class.java)
```

## Upload de imagens e PDF

Copie o `content://` para memória/arquivo temporário sob controle do app e obtenha o MIME pelo `ContentResolver`. O servidor faz a validação final.

```kotlin
fun filePart(name: String, mime: String, bytes: ByteArray): MultipartBody.Part {
    val body = bytes.toRequestBody(mime.toMediaType())
    return MultipartBody.Part.createFormData("files", name, body)
}

val uploaded = api.uploadFiles(
    conversationId,
    listOf(
        filePart("imagem1.jpg", "image/jpeg", image1Bytes),
        filePart("imagem2.jpg", "image/jpeg", image2Bytes),
        filePart("documento.pdf", "application/pdf", pdfBytes)
    )
)
val attachmentIds = uploaded.attachments.map { it.id }
```

## SSE por POST com OkHttp

`EventSource` normalmente abre GET; esta API usa POST para não colocar o prompt na URL. Leia o corpo como stream e processe cada frame `data:`.

```kotlin
class GeminiStreamClient(
    private val client: OkHttpClient,
    private val baseUrl: HttpUrl,
    private val moshi: Moshi
) {
    private val requestAdapter = moshi.adapter(ChatRequest::class.java)

    fun stream(request: ChatRequest): Flow<StreamEvent> = callbackFlow {
        val json = requestAdapter.toJson(request)
        val httpRequest = Request.Builder()
            .url(baseUrl.resolve("api/chat/stream")!!)
            .post(json.toRequestBody("application/json".toMediaType()))
            .header("Accept", "text/event-stream")
            .build()
        val call = client.newCall(httpRequest)

        val worker = launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) {
                        throw IOException("Backend HTTP ${response.code}: ${response.body.string()}")
                    }
                    val source = response.body.source()
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (!line.startsWith("data:")) continue
                        val payload = line.removePrefix("data:").trim()
                        trySend(parseStreamEvent(payload, moshi))
                    }
                }
                close()
            } catch (error: Throwable) {
                if (error !is CancellationException) close(error)
            }
        }

        awaitClose {
            call.cancel() // fecha HTTP; o servidor mata o Antigravity CLI
            worker.cancel()
        }
    }
}

fun parseStreamEvent(json: String, moshi: Moshi): StreamEvent {
    val map = moshi.adapter(Map::class.java).fromJson(json) as Map<*, *>
    return when (map["type"]) {
        "start" -> StreamEvent.Start(map["conversationId"].toString(), map["model"]?.toString())
        "delta" -> StreamEvent.Delta(map["text"].toString())
        "tool" -> StreamEvent.Tool(map["name"].toString(), map["status"].toString())
        "complete" -> StreamEvent.Complete(map["text"].toString(), map["conversationId"].toString())
        "error" -> StreamEvent.Error(map["code"].toString(), map["message"].toString())
        else -> error("Evento SSE desconhecido")
    }
}
```

Na ViewModel, acrescente cada `Delta.text` ao texto da mensagem atual. Isso dá o efeito de resposta aparecendo progressivamente:

```kotlin
viewModelScope.launch {
    streamClient.stream(chatRequest).collect { event ->
        when (event) {
            is StreamEvent.Delta -> _uiState.update { it.appendAssistant(event.text) }
            is StreamEvent.Complete -> _uiState.update { it.finishAssistant(event.text) }
            is StreamEvent.Error -> _uiState.update { it.showError(event.code, event.message) }
            else -> Unit
        }
    }
}
```

## conversationId, cancelamento e reconexão

- Crie uma conversa uma vez e persista seu ID no banco local do NumIA.
- Upload e mensagem devem usar o mesmo ID.
- Cancelar a coroutine cancela a chamada OkHttp; a desconexão encerra o subprocesso no servidor.
- O botão “Parar” pode cancelar a coroutine e também chamar o endpoint de cancelamento como garantia.
- Faça retry exponencial automático para GETs e upload somente antes de receber uma resposta.
- **Não reenvie automaticamente `POST /api/chat/stream`** após uma queda: o servidor já pode ter persistido o turno do usuário, e outro POST criaria uma segunda geração. Mostre “Conexão interrompida” e ofereça um botão “Tentar novamente” explícito.
- Depois de recuperar rede, carregue `GET /api/conversations/:id` para sincronizar o histórico. Se não houver resposta do assistente, o usuário pode reenviar conscientemente.

Mapeie `401` para configuração/token inválido, `413/415` para problema no anexo, `429` para espera e `GEMINI_AUTH_REQUIRED` para uma mensagem administrativa: “Faça login novamente no servidor”.
