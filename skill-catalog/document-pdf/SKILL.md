---
name: document-pdf
description: Cria, lê, combina, divide e valida arquivos PDF usando ferramentas locais gratuitas. Use quando o principal arquivo de entrada ou saída for PDF.
---

# Documentos PDF

Trabalhar somente dentro do workspace e usar bibliotecas locais, sem APIs pagas.

## Criação

- Preferir `reportlab` para documentos novos.
- Definir tamanho de página, margens, estilos, cabeçalhos e rodapés explicitamente.
- Quebrar textos longos com componentes de layout, não com coordenadas fixas improvisadas.
- Inserir imagens preservando a proporção.

## Leitura e manipulação

- Usar `pypdf` para extrair texto, combinar, dividir, rotacionar e inspecionar metadados.
- Não considerar extração vazia como prova de PDF vazio; o documento pode ser digitalizado.
- Para conteúdo escaneado, informar que OCR é necessário e usar OCR local somente se estiver disponível.

## Verificação

Reabrir o arquivo produzido com `pypdf`, confirmar número de páginas, tamanho não zero e ausência de erros de leitura. Quando possível, renderizar páginas para inspeção visual. Publicar o arquivo final com `artifact_publish`.

