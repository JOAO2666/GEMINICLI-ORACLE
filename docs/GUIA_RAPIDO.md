# API privada do Antigravity CLI para NumIA e Gemini Spark

Este projeto transforma o modo headless do Antigravity CLI (`agy`) em uma API privada compatível com OpenAI e também oferece um servidor MCP para o Gemini Spark.

> **Limite importante:** isto não cria uma Gemini API oficial, gratuita e ilimitada. As chamadas usam a sessão da conta Google autenticada no `agy` e continuam sujeitas à elegibilidade, cotas, limites, disponibilidade e termos do Google. Não há cobrança por chamada da Gemini API neste modo porque ele não usa uma API key, mas a assinatura Google AI e a hospedagem podem ter custos próprios. Na Oracle, mantenha apenas recursos marcados como Always Free e nunca atualize a conta para Pay As You Go se o objetivo for eliminar o risco de cobrança.

## O que fica disponível

- API de texto e imagem para o NumIA;
- rotas compatíveis com OpenAI em `/v1/models` e `/v1/chat/completions`;
- servidor MCP em `/mcp` com workspaces, arquivos, Git, terminal isolado, catálogo de 18 skills e publicação de artefatos;
- HTTPS automático com Caddy;
- autenticação Google persistente em um volume separado.

## Instalação automática pelo Windows

O método manual abaixo continua disponível. Para uma instalação assistida:

1. Crie primeiro uma VM Linux marcada como Always Free na Oracle e libere as portas 22, 80 e 443.
2. No Windows, baixe o repositório completo ou execute `git clone https://github.com/JOAO2666/GEMINICLI-ORACLE.git`.
3. Dê duplo clique em `INSTALAR_AUTOMATICO.bat`.
4. Informe IP da VM, usuário SSH, arquivo da chave privada e domínio. Para um IP como `129.148.23.167`, pode usar `129-148-23-167.nip.io`.
5. Confirme o login Google quando o assistente abrir o fluxo oficial do `agy`.
6. No final, guarde a chave NumIA exibida em um gerenciador de senhas.

O instalador pode ser executado novamente para atualizar o projeto. Ele preserva `.env`, chaves, autenticação e volumes existentes. Ele não cria a VM, não acessa a área de faturamento e não transforma a conta Oracle em Pay As You Go.

Se o projeto já está instalado e o problema é somente uma sessão Google expirada, use `RECONECTAR_AGY.bat`. Ele abre novamente o login oficial, reinicia somente o backend e testa a lista de modelos. A chave do NumIA, a conexão MCP, arquivos e volumes permanecem iguais.

## Instalação manual resumida na Oracle

Use uma VM Ampere A1 que apareça como Always Free, abra somente as portas 22, 80 e 443 e instale Docker com o plugin Compose. Depois:

```bash
git clone https://github.com/JOAO2666/GEMINICLI-ORACLE.git numia-gemini-server
cd numia-gemini-server
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Edite `.env` e use os dois valores aleatórios em:

- `NUMIA_SERVER_TOKEN`: chave privada usada pelo NumIA e pela tela de autorização MCP;
- `MCP_WORKER_TOKEN`: chave interna diferente, nunca enviada a aplicativos;
- `DOMAIN` e `PUBLIC_BASE_URL`: domínio HTTPS do servidor;
- `ALLOWED_MODELS`: deixe vazio para liberar automaticamente todos os modelos do CLI, ou informe uma lista para restringir.

Nunca envie essas chaves em conversas, prints ou no GitHub. O arquivo `.env` já está excluído do Git.

## Login na conta Google

Execute uma vez:

```bash
docker compose --profile login run --rm antigravity-login
```

Abra no seu navegador o endereço exibido, entre na conta Google autorizada e cole no terminal apenas o código temporário solicitado. Não compartilhe esse código.

As credenciais ficam no volume `antigravity-auth`. Reiniciar a VM, recriar o container ou atualizar o projeto normalmente **não exige novo login**. Será necessário entrar novamente se a sessão expirar, o Google revogar a autorização, houver uma mudança de segurança/senha que invalide a sessão, o volume for apagado ou a instalação for migrada sem esse volume.

Não use `docker compose down -v`: a opção `-v` apaga a autenticação e os dados persistentes.

### Recuperação rápida do login

No Windows, execute `RECONECTAR_AGY.bat` e informe os mesmos IP, usuário, chave SSH, domínio e pasta usados na instalação. Para recuperação manual:

```bash
cd /home/opc/numia-gemini
sudo docker compose --profile login run --rm antigravity-login
sudo docker compose restart server
sudo docker compose --profile login run --rm antigravity-login agy models
```

Se os modelos forem listados, a API voltou a usar a conta Google. Não é necessário trocar a chave no NumIA nem reconectar o MCP.

Confira a sessão e inicie:

```bash
docker compose --profile login run --rm antigravity-login agy models
docker compose up -d --build
docker compose ps
```

## Configurar o NumIA

Na tela de chave de API do NumIA:

1. Informe a base HTTPS, por exemplo `https://seu-dominio.example` sem `/v1` e sem `/mcp`.
2. Informe `NUMIA_SERVER_TOKEN` como chave.
3. Avance e escolha um dos modelos retornados pelo servidor.

O envio de imagens usa o modelo escolhido na própria requisição. Defina `VISION_MODEL` somente se quiser forçar outro modelo para imagens.

## Conectar ao Gemini Spark

A conexão é criada pelo Gemini na web e depois pode ser usada no Spark web ou móvel:

1. Abra `gemini.google.com` no computador.
2. Vá a **Configurações e ajuda → Inteligência pessoal → Apps conectados**.
3. Em **Apps personalizados para o Spark**, escolha adicionar um app.
4. Informe `https://seu-dominio.example/mcp` e avance.
5. Na página **Autorizar conexão MCP**, digite `NUMIA_SERVER_TOKEN` e selecione **Autorizar**.
6. Aguarde o retorno automático ao Gemini e conclua a conexão.
7. Dentro de uma tarefa Spark, digite `@` e selecione **NumIA Workspace** para garantir o uso das ferramentas.

O servidor aceita cadastro dinâmico de cliente e PKCE; não preencha credenciais em “recursos avançados”. O Gemini pede confirmação antes das ações de escrita. Revise cada confirmação, principalmente comandos, edição e exclusão.

Se uma tentativa antiga terminou em erro, remova/desconecte o app incompleto e inicie uma nova conexão. O parâmetro `state` daquela tentativa é temporário e não deve ser reutilizado.

## Modelos e atualizações futuras

Liste os modelos liberados para a conta:

```bash
docker compose --profile login run --rm antigravity-login agy models
```

Os nomes mudam conforme o Google e a conta. O servidor executa a descoberta na inicialização e a cada 15 minutos. Atualmente o CLI oferece Gemini 3.8 Flash, versões Gemini anteriores, Claude Sonnet/Opus e GPT-OSS. Confira ou force a atualização:

```bash
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/models
curl -X POST -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/models/refresh
curl -H "Authorization: Bearer $NUMIA_SERVER_TOKEN" https://SEU_DOMINIO/api/usage
```

Deixe `ALLOWED_MODELS` vazio para atualização automática. Preencha-o apenas se quiser impedir modelos não aprovados.

## Sem risco de cobrança

Para minimizar o risco:

- mantenha a conta Oracle no Free Tier e não aceite upgrade para Pay As You Go;
- crie somente recursos explicitamente marcados como Always Free;
- não configure `GEMINI_API_KEY` nem `modelProvider: gemini` neste projeto;
- use a autenticação de conta já persistida pelo `agy`;
- acompanhe os limites da assinatura Google e da Oracle.

“Sem API key e sem cobrança por chamada adicional” não significa “ilimitado”: o Google pode aplicar cotas, limites de velocidade e mudanças de acesso.

## Fontes oficiais

- [Conectar apps personalizados ao Gemini Spark](https://support.google.com/gemini/answer/17209137)
- [Instalação e autenticação do Antigravity CLI](https://antigravity.google/docs/cli/install/)
- [Modo headless e lista de modelos do Antigravity CLI](https://antigravity.google/docs/cli/headless/)
