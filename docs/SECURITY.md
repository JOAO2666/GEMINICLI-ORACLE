# Revisão de segurança

Controles implementados:

- Bearer token comparado em tempo constante e mantido fora do Git;
- HTTPS obrigatório em produção e CORS por allowlist;
- rate limit por IP;
- uploads com limites, UUID, basename sanitizado, assinatura de binários e bloqueio de path traversal;
- diretório isolado por UUID de conversa e permissões restritas;
- `spawn()` com vetor de argumentos, sem shell e sem concatenação de comandos;
- modelo validado contra allowlist;
- execução do CLI em `approval-mode plan` e prompt explícito de somente leitura;
- fila global, apenas uma geração simultânea por conversa, timeout e encerramento forçado;
- cancelamento em desconexão do SSE;
- logs estruturados com `Authorization` oculto, sem conteúdo de anexos;
- credenciais do Antigravity em volume separado do banco/arquivos;
- variáveis `GEMINI_API_KEY`, `GOOGLE_API_KEY` e `GOOGLE_APPLICATION_CREDENTIALS` removidas do ambiente do subprocesso.

Riscos residuais e operação recomendada:

1. O Antigravity CLI é um agente local. Mesmo em `plan` + sandbox, trate o container/VM como dedicado e não monte diretórios do host além dos volumes previstos.
2. Quem obtiver `NUMIA_SERVER_TOKEN` poderá gastar sua quota. Use um token aleatório, armazenamento seguro no Android e rotação após perda do aparelho.
3. OAuth dá acesso associado à conta. Proteja SSH com chave, desative login por senha e aplique atualizações de segurança.
4. Não publique a porta 3000. Exponha somente Caddy em 80/443.
5. Configure alertas de disco, CPU e reinícios. Anexos expiram, mas mensagens e banco crescem até a exclusão das conversas.
6. O conteúdo de arquivos pode conter prompt injection. O prompt marca anexos como dados e o modo é somente leitura, mas respostas ainda podem ser influenciadas; não conecte ferramentas mutáveis sem uma nova revisão.
7. Faça backup apenas de `numia-data`; proteja e não copie o volume `antigravity-auth`.

Checklist antes de publicar:

- [ ] DNS correto e certificado HTTPS válido
- [ ] firewall permite apenas 22 (restrito), 80 e 443
- [ ] token com pelo menos 256 bits e fora do repositório
- [ ] `ALLOWED_ORIGINS` restrito se houver cliente web
- [ ] `MAX_GEMINI_PROCESSES=1` em máquina pequena
- [ ] teste de cancelamento e timeout realizado
- [ ] backup/restore do volume de dados testado
- [ ] versão do Antigravity CLI verificada após rebuild
