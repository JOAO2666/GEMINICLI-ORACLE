[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Read-WithDefault {
    param([string]$Message, [string]$Default)
    $answer = Read-Host "$Message [$Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Assert-Match {
    param([string]$Value, [string]$Pattern, [string]$Message)
    if ($Value -notmatch $Pattern) { throw $Message }
}

function Invoke-Native {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "O comando $Program terminou com codigo $LASTEXITCODE."
    }
}

Write-Host 'Este assistente renova somente a sessao Google do Agy no servidor.' -ForegroundColor Cyan
Write-Host 'A chave do NumIA, o MCP, os arquivos, os volumes e o faturamento nao serao alterados.' -ForegroundColor Yellow
Write-Host ''

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw 'OpenSSH nao foi encontrado. Instale o recurso Cliente OpenSSH do Windows.'
}

$server = Read-Host 'IP publico da VM Oracle'
$server = $server.Trim()
Assert-Match $server '^[A-Za-z0-9.-]+$' 'Informe apenas um IPv4 ou nome de host valido.'

$sshUser = Read-WithDefault 'Usuario SSH' 'opc'
Assert-Match $sshUser '^[a-z_][a-z0-9_-]*$' 'Usuario SSH invalido.'

$defaultKey = Join-Path $HOME '.ssh\numia_oracle_ed25519'
$keyPath = Read-WithDefault 'Caminho completo da chave SSH privada' $defaultKey
$keyPath = [Environment]::ExpandEnvironmentVariables($keyPath)
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "Chave SSH nao encontrada: $keyPath"
}
$keyPath = (Resolve-Path -LiteralPath $keyPath).Path

$suggestedDomain = ($server -replace '\.', '-') + '.nip.io'
$domain = Read-WithDefault 'Dominio HTTPS da API' $suggestedDomain
Assert-Match $domain '^[A-Za-z0-9.-]+$' 'Dominio invalido.'

$installDir = Read-WithDefault 'Pasta do projeto na VM' "/home/$sshUser/numia-gemini"
Assert-Match $installDir '^/[A-Za-z0-9._/-]+$' 'Pasta remota invalida.'

Write-Host ''
Write-Host "Servidor: $sshUser@$server"
Write-Host "API:      https://$domain"
Write-Host "Pasta:    $installDir"
$confirmation = Read-Host 'Iniciar a recuperacao? Digite SIM'
if ($confirmation -cne 'SIM') {
    Write-Host 'Operacao cancelada.'
    exit 0
}

$target = "$sshUser@$server"
$sshCommon = @('-i', $keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')

Write-Host ''
Write-Host '1/4 Verificando a instalacao remota...' -ForegroundColor Cyan
$checkCommand = "test -f '$installDir/docker-compose.yml' && cd '$installDir' && sudo docker compose version"
Invoke-Native 'ssh.exe' ($sshCommon + @('-t', $target, $checkCommand))

Write-Host ''
Write-Host '2/4 Abrindo o login oficial do Google...' -ForegroundColor Cyan
Write-Host 'Abra a URL exibida, autorize a conta correta e cole o codigo temporario.' -ForegroundColor Yellow
$loginCommand = "cd '$installDir' && sudo docker compose --profile login run --rm antigravity-login"
Invoke-Native 'ssh.exe' ($sshCommon + @('-t', $target, $loginCommand))

Write-Host ''
Write-Host '3/4 Reiniciando somente o backend...' -ForegroundColor Cyan
$restartCommand = "cd '$installDir' && sudo docker compose restart server && sudo docker compose ps server"
Invoke-Native 'ssh.exe' ($sshCommon + @('-t', $target, $restartCommand))

Write-Host ''
Write-Host '4/4 Testando HTTPS e a descoberta de modelos...' -ForegroundColor Cyan
$keyCommand = "sed -n 's/^NUMIA_SERVER_TOKEN=//p' '$installDir/.env'"
$accessKeyLines = & ssh.exe @sshCommon $target $keyCommand
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel validar a instalacao remota.' }
$accessKey = ($accessKeyLines | Select-Object -Last 1).Trim()
if ($accessKey.Length -lt 32) { throw 'A chave interna da instalacao parece invalida.' }

$models = Invoke-RestMethod -Uri "https://$domain/api/models" -Headers @{ Authorization = "Bearer $accessKey" } -TimeoutSec 90
if (-not $models.models -or $models.models.Count -lt 1) {
    throw 'O login foi concluido, mas nenhum modelo foi retornado.'
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host 'Sessao Google recuperada e API testada com sucesso.' -ForegroundColor Green
Write-Host "API:     https://$domain"
Write-Host "Modelos: $($models.models -join ', ')"
Write-Host 'A chave do NumIA e a conexao MCP nao foram modificadas.'
Write-Host '============================================================' -ForegroundColor Green
