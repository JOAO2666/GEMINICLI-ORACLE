---
name: document-pptx
description: Cria, lê e edita apresentações PowerPoint .pptx usando ferramentas locais gratuitas. Use quando o usuário pedir slides, apresentação, pitch deck, aula ou arquivo PowerPoint.
---

# Apresentações PPTX

Usar `python-pptx`. Não usar APIs pagas.

## Regras de criação

- Definir primeiro narrativa, público e quantidade aproximada de slides.
- Manter uma ideia principal por slide e hierarquia visual clara.
- Evitar parágrafos longos; usar títulos objetivos e pontos essenciais.
- Preservar proporção de imagens e deixar margens seguras.
- Usar contraste suficiente e fontes legíveis.
- Adicionar notas do apresentador quando solicitado.

## Verificação

Reabrir o arquivo com `python-pptx`, confirmar quantidade de slides, títulos, imagens e ausência de caixas vazias inesperadas. Verificar que o ZIP contém `ppt/presentation.xml`. Publicar o arquivo final com `artifact_publish`.

