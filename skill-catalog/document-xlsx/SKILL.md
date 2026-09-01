---
name: document-xlsx
description: Cria, lê, edita e valida planilhas Excel .xlsx usando ferramentas locais gratuitas. Use quando a entrada ou entrega principal for uma planilha, tabela, CSV ou XLSX.
---

# Planilhas XLSX

Usar `openpyxl` para arquivos Excel e o módulo `csv` para CSV. Não usar APIs pagas.

## Regras

- Manter os dados em células, nunca como uma imagem de tabela.
- Usar cabeçalhos claros, filtros, painéis congelados e formatos numéricos adequados.
- Inserir fórmulas quando o resultado precisar continuar atualizável pelo usuário.
- Evitar fórmulas recentes que possam falhar em versões antigas do Excel.
- Não sobrescrever um arquivo existente sem autorização explícita.
- Para gráficos, definir título, eixos e intervalo de dados corretamente.

## Verificação

Salvar, reabrir com `openpyxl` usando `data_only=False` e conferir nomes das abas, dimensões, fórmulas e células essenciais. Procurar fórmulas com erros óbvios e publicar o resultado com `artifact_publish`.

