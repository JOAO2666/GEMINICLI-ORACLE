---
name: document-docx
description: Cria, lê e edita documentos Word .docx com formatação profissional usando ferramentas locais gratuitas. Use para relatórios, cartas, trabalhos, contratos, currículos e outros documentos Word.
---

# Documentos DOCX

Usar `python-docx`. Não usar serviços externos ou APIs pagas.

## Regras

- Configurar margens, estilo normal, títulos e espaçamento antes de inserir o conteúdo.
- Usar estilos de título para formar uma estrutura navegável.
- Definir larguras e alinhamento de tabelas de maneira consistente.
- Adicionar cabeçalhos, rodapés e numeração quando solicitado.
- Manter imagens proporcionais e dentro da área útil da página.
- Não simular um `.docx` renomeando HTML ou texto.

## Verificação

Reabrir o arquivo com `python-docx`, confirmar que parágrafos e tabelas esperados existem e verificar que o ZIP interno contém `[Content_Types].xml` e `word/document.xml`. Publicar o resultado com `artifact_publish`.

