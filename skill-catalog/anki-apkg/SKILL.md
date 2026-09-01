---
name: anki-apkg
description: Cria, valida e publica baralhos Anki no formato .apkg. Use quando o usuário pedir flashcards, cartões de estudo, perguntas e respostas para Anki ou conversão de conteúdo, texto ou questões em um arquivo importável pelo Anki.
---

# Anki APKG

Criar um arquivo `.apkg` real e importável, não um arquivo de texto renomeado.

## Fluxo obrigatório

1. Reunir o conteúdo fornecido pelo usuário e preservar a resposta correta.
2. Organizar os cartões em um JSON UTF-8 dentro do workspace antes de gerar o pacote.
3. Usar `genanki` em Python para criar o baralho.
4. Usar identificadores estáveis derivados do nome do baralho para evitar duplicações desnecessárias.
5. Escapar HTML inserido nos campos. Usar HTML somente quando melhorar fórmulas, listas ou imagens.
6. Quando houver imagens, copiá-las para o workspace e incluí-las em `media_files`.
7. Validar o `.apkg` como arquivo ZIP e confirmar a presença do banco de dados e do manifesto de mídia.
8. Publicar o resultado com `artifact_publish` e devolver a URL HTTPS.

## Modelo mínimo

Criar campos `Pergunta`, `Resposta` e, quando útil, `Explicação`. A frente mostra a pergunta; o verso mostra resposta e explicação. Não inserir números de alternativa na resposta quando o enunciado já indicar a opção correta por texto.

## Verificação

Executar um script que abra o pacote com `zipfile`, liste os membros e falhe se não existir `collection.anki2` ou `collection.anki21`. Confirmar que o arquivo tem tamanho maior que zero. Nunca afirmar compatibilidade sem realizar essa verificação.

