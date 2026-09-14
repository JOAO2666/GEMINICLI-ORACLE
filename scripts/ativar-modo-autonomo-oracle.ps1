[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$sshKey = Join-Path $HOME '.ssh\numia_oracle_ed25519'
$server = '129.148.23.167'
$sshUser = 'opc'

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   Ativando Modo Autonomo (Estilo Codex) no Oracle PC' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path -LiteralPath $sshKey -PathType Leaf)) {
    Write-Warning "Chave SSH nao encontrada em: $sshKey"
    $sshKey = Read-Host 'Informe o caminho da chave privada SSH da Oracle'
}

$target = "$sshUser@$server"
$sshCommon = @('-i', $sshKey, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10')

$localScript = Join-Path $PSScriptRoot 'configurar-modo-autonomo-oracle.sh'
if (-not (Test-Path -LiteralPath $localScript -PathType Leaf)) {
    throw "Script local nao encontrado: $localScript"
}

$remoteTemp = '/tmp/configurar-modo-autonomo.sh'

Write-Host "Enviando configurador para $target..." -ForegroundColor Yellow
& scp.exe @sshCommon $localScript "${target}:$remoteTemp"
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao transferir o script via SCP para o servidor."
}

Write-Host "Executando configuracao autonoma no servidor..." -ForegroundColor Yellow
$remoteExec = "bash '$remoteTemp'; code=`$?; rm -f '$remoteTemp'; exit `$code"
& ssh.exe @sshCommon -t $target $remoteExec
if ($LASTEXITCODE -ne 0) {
    throw "Falha ao executar a configuracao no servidor Oracle."
}

Write-Host ''
Write-Host "Verificando status do daemon no servidor..." -ForegroundColor Cyan
$statusOutput = & ssh.exe @sshCommon $target '/usr/local/bin/agy remote-control status; systemctl --user is-active antigravity-cli-daemon.service'
Write-Host ($statusOutput -join "`n")
Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host 'Modo Autonomo Total (Estilo Codex) ativado com sucesso!' -ForegroundColor Green
Write-Host 'O Oracle-PC agora executa todas as tarefas sem pedir permissao.' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
