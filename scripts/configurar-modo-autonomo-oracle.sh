#!/usr/bin/env bash
set -Eeuo pipefail

echo "============================================================"
echo "  Configurando Modo Autônomo Total (Estilo Codex) no Oracle"
echo "============================================================"

# 1. Configurar config.json
python3 - << 'PYEOF'
import json, os

config_path = "/home/opc/.gemini/config/config.json"
if os.path.exists(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)
else:
    data = {}

us = data.setdefault("userSettings", {})
us["autoExecutionPolicy"] = "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER"
us["artifactReviewMode"] = "ARTIFACT_REVIEW_MODE_TURBO"
us["browserJsExecutionPolicy"] = "BROWSER_JS_EXECUTION_POLICY_TURBO"
us["nonWorkspaceFileAccessPolicy"] = "AGENT_SETTING_POLICY_ALLOW"
us["enableTerminalSandbox"] = False

gpg = us.setdefault("globalPermissionGrants", {})
allow_list = gpg.setdefault("allow", [])

wildcards = [
    "command(*)",
    "read_file(*)",
    "write_file(*)",
    "edit_file(*)",
    "view_file(*)",
    "run_command(*)",
    "list_dir(*)",
    "find_by_name(*)",
    "grep_search(*)",
    "*"
]

for w in reversed(wildcards):
    if w not in allow_list:
        allow_list.insert(0, w)

os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

print("[OK] config.json atualizado com autoExecutionPolicy EAGER e wildcard grants")
PYEOF

# 2. Configurar projects/outside-of-project.json e default-cli-project.json
python3 - << 'PYEOF'
import json, os

wildcards = [
    "command(*)",
    "read_file(*)",
    "write_file(*)",
    "edit_file(*)",
    "view_file(*)",
    "run_command(*)",
    "list_dir(*)",
    "find_by_name(*)",
    "grep_search(*)",
    "*"
]

os.makedirs("/home/opc/.gemini/config/projects", exist_ok=True)

for name in ["outside-of-project.json", "default-cli-project.json"]:
    p = f"/home/opc/.gemini/config/projects/{name}"
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {"id": name.replace(".json", ""), "name": name}
    
    pg = data.setdefault("permissionGrants", {}).setdefault("permissionGrants", {})
    allow = pg.setdefault("allow", [])
    for w in reversed(wildcards):
        if w not in allow:
            allow.insert(0, w)
            
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"[OK] {name} atualizado com wildcard grants")
PYEOF

# 3. Configurar settings.json
python3 - << 'PYEOF'
import json, os

settings_path = "/home/opc/.gemini/antigravity-cli/settings.json"
if os.path.exists(settings_path):
    with open(settings_path, "r", encoding="utf-8") as f:
        data = json.load(f)
else:
    data = {}

data["allowNonWorkspaceAccess"] = True
data["artifactReviewPolicy"] = "always-proceed"
data["toolPermission"] = "always-proceed"
data["commandAutoExecution"] = "always-allow"
data["autoExecutionPolicy"] = "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER"

tw = data.setdefault("trustedWorkspaces", [])
for path in ["/", "/home/opc", "/home/opc/numia-gemini", "/home/opc/.gemini/antigravity-cli/scratch", "/data", "/workspaces", "/tmp", "/app"]:
    if path not in tw:
        tw.append(path)

os.makedirs(os.path.dirname(settings_path), exist_ok=True)
with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

print("[OK] settings.json atualizado com permissoes totais e workspaces confiaveis")
PYEOF

# 4. Criar wrapper /usr/local/bin/agy para garantir flags autonomas permanentemente
if [[ -f /usr/local/bin/agy && ! -f /usr/local/bin/agy.real ]]; then
    sudo mv /usr/local/bin/agy /usr/local/bin/agy.real
fi

sudo tee /usr/local/bin/agy > /dev/null << 'WRAPPER_EOF'
#!/usr/bin/env bash
REAL_BIN="/usr/local/bin/agy.real"

if [[ ! -x "$REAL_BIN" ]]; then
    echo "Erro: $REAL_BIN nao encontrado." >&2
    exit 1
fi

HAS_SKIP=0
HAS_MODE=0

for arg in "$@"; do
    if [[ "$arg" == *"--dangerously-skip-permissions"* ]]; then HAS_SKIP=1; fi
    if [[ "$arg" == *"--mode"* ]]; then HAS_MODE=1; fi
done

EXTRA_ARGS=()
if [[ $HAS_SKIP -eq 0 ]]; then
    EXTRA_ARGS+=("--dangerously-skip-permissions")
fi
if [[ $HAS_MODE -eq 0 ]]; then
    EXTRA_ARGS+=("--mode" "accept-edits")
fi

exec "$REAL_BIN" "${EXTRA_ARGS[@]}" "$@"
WRAPPER_EOF

sudo chmod +x /usr/local/bin/agy
echo "[OK] Wrapper /usr/local/bin/agy ativo com --dangerously-skip-permissions e --mode accept-edits"

# 5. Atualizar servico systemd
SERVICE_FILE="/home/opc/.config/systemd/user/antigravity-cli-daemon.service"
if [[ -f "$SERVICE_FILE" ]]; then
    sed -i 's|ExecStart=.*|ExecStart=/usr/local/bin/agy --dangerously-skip-permissions --mode accept-edits remote-control serve|' "$SERVICE_FILE"
    systemctl --user daemon-reload
    systemctl --user restart antigravity-cli-daemon.service
    echo "[OK] antigravity-cli-daemon.service atualizado e reiniciado"
fi

# 6. Atualizar instrucoes globais de agente AGENTS.md e GEMINI.md
cat << 'AGENTS_EOF' > /home/opc/AGENTS.md
# Antigravity Autonomous Execution Protocol (Codex Mode)

## Diretrizes de Comportamento
1. **Autonomia Total (Estilo Codex/Agent Mode)**:
   - Execute as tarefas do inicio ao fim de forma proativa, direta e independente.
   - Nao interrompa o fluxo para pedir confirmacao para rodar comandos de terminal seguros, diagnosticos ou edicoes de arquivos. Execute-os diretamente.
   - Quando um erro ou falha acontecer, investigue a causa raiz, corrija e execute novamente por conta propria ate funcionar.
   - Evite perguntas triviais; se houver um caminho padrao ou melhor pratica recomendada, adote-a e execute.

2. **Execucao Direta**:
   - Va direto para a implementacao pratica sem criar barreiras ou esperas desnecessarias.
   - Entregue o resultado pronto e testado.
AGENTS_EOF

cp /home/opc/AGENTS.md /home/opc/GEMINI.md
if [[ -d /home/opc/numia-gemini ]]; then
    cp /home/opc/AGENTS.md /home/opc/numia-gemini/AGENTS.md
    cp /home/opc/AGENTS.md /home/opc/numia-gemini/GEMINI.md
fi
if [[ -d /home/opc/.gemini/antigravity-cli/scratch ]]; then
    cp /home/opc/AGENTS.md /home/opc/.gemini/antigravity-cli/scratch/AGENTS.md
    cp /home/opc/AGENTS.md /home/opc/.gemini/antigravity-cli/scratch/GEMINI.md
fi
echo "[OK] Protocolos de execucao autonoma (AGENTS.md / GEMINI.md) atualizados"

echo "============================================================"
echo "  Modo Autônomo Total (Codex Mode) ativado com sucesso!"
echo "============================================================"
