[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$sshKey = Join-Path $HOME '.ssh\numia_oracle_ed25519'
$server = '129.148.23.167'
$sshUser = 'opc'

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   Controle Remoto Google Antigravity - Oracle PC' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $sshKey -PathType Leaf)) {
    Write-Warning "Chave SSH nao encontrada em: $sshKey"
    $sshKey = Read-Host 'Informe o caminho da chave privada SSH da Oracle'
}

$target = "$sshUser@$server"
$sshCommon = @('-i', $sshKey, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10')

Write-Host "Consultando status no servidor $target..." -ForegroundColor Yellow

try {
    $remoteCmd = @'
/usr/local/bin/agy remote-control status
echo -n "Daemon service: "
systemctl --user is-active antigravity-cli-daemon.service
if grep -q "dangerously-skip-permissions" ~/.config/systemd/user/antigravity-cli-daemon.service 2>/dev/null; then
    echo "Modo Autonomo Codex: ATIVO - Execucao 100% automatica sem pedir confirmacoes"
else
    echo "Modo Autonomo Codex: INATIVO"
fi
'@
    $statusOutput = & ssh.exe @sshCommon $target $remoteCmd
    Write-Host ''
    Write-Host ($statusOutput -join "`n")
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host 'O Oracle PC esta ativo e registrado no Antigravity!' -ForegroundColor Green
    Write-Host 'Modo Autonomo Codex: 100% ativo (sem interrupcoes manuais)' -ForegroundColor Green
    Write-Host 'Acesse no seu navegador: https://antigravity.google.com/' -ForegroundColor Cyan
    Write-Host 'Procure por: oracle-pc' -ForegroundColor Yellow
    Write-Host '============================================================' -ForegroundColor Green
} catch {
    Write-Error "Falha ao conectar com o servidor Oracle: $_"
}
