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

Write-Host 'Este instalador requer:' -ForegroundColor Cyan
Write-Host '  - uma VM Linux ja criada na Oracle e marcada como Always Free;'
Write-Host '  - portas 22, 80 e 443 liberadas;'
Write-Host '  - o arquivo da chave SSH privada da VM.'
Write-Host ''
Write-Host 'Ele nao acessa a area de cobranca e nao converte a conta para Pay As You Go.' -ForegroundColor Yellow
Write-Host ''

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw 'OpenSSH nao foi encontrado. Instale o recurso Cliente OpenSSH do Windows.'
}
if (-not (Get-Command scp.exe -ErrorAction SilentlyContinue)) {
    throw 'SCP nao foi encontrado. Instale o recurso Cliente OpenSSH do Windows.'
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
$domain = Read-WithDefault 'Dominio HTTPS (nip.io funciona sem registro)' $suggestedDomain
Assert-Match $domain '^[A-Za-z0-9.-]+$' 'Dominio invalido.'

$installDir = Read-WithDefault 'Pasta de instalacao na VM' "/home/$sshUser/numia-gemini"
Assert-Match $installDir '^/[A-Za-z0-9._/-]+$' 'Pasta remota invalida.'

Write-Host ''
Write-Host 'Resumo:' -ForegroundColor Cyan
Write-Host "  Servidor: $sshUser@$server"
Write-Host "  Dominio:  https://$domain"
Write-Host "  Pasta:    $installDir"
Write-Host '  Cobranca: nenhuma configuracao de faturamento sera alterada'
$confirmation = Read-Host 'Continuar? Digite SIM'
if ($confirmation -cne 'SIM') {
    Write-Host 'Operacao cancelada.'
    exit 0
}

$remoteInstaller = Join-Path $PSScriptRoot 'setup-remoto.sh'
if (-not (Test-Path -LiteralPath $remoteInstaller)) {
    throw 'Arquivo scripts\setup-remoto.sh nao encontrado. Baixe o repositorio completo.'
}

$target = "$sshUser@$server"
$sshCommon = @('-i', $keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')
$remoteTemp = "/tmp/numia-setup-$PID.sh"

Write-Host ''
Write-Host '1/4 Testando a conexao SSH...' -ForegroundColor Cyan
Invoke-Native 'ssh.exe' ($sshCommon + @($target, 'printf conexao-ok'))

Write-Host ''
Write-Host '2/4 Enviando e executando o instalador na VM...' -ForegroundColor Cyan
Invoke-Native 'scp.exe' (@('-i', $keyPath, '-o', 'StrictHostKeyChecking=accept-new', $remoteInstaller, "${target}:$remoteTemp"))
$remoteCommand = "bash '$remoteTemp' '$domain' '$installDir'; code=`$?; rm -f '$remoteTemp'; exit `$code"
Invoke-Native 'ssh.exe' ($sshCommon + @('-t', $target, $remoteCommand))

Write-Host ''
$doLogin = Read-WithDefault '3/4 Fazer agora o login oficial da conta Google? (S/N)' 'S'
if ($doLogin -match '^[Ss]') {
    Write-Host 'Abra a URL mostrada, autorize sua conta e cole o codigo temporario no terminal.' -ForegroundColor Yellow
    $loginCommand = "cd '$installDir' && sudo docker compose --profile login run --rm antigravity-login"
    Invoke-Native 'ssh.exe' ($sshCommon + @('-t', $target, $loginCommand))
    $restartCommand = "cd '$installDir' && sudo docker compose up -d --force-recreate server"
    Invoke-Native 'ssh.exe' ($sshCommon + @($target, $restartCommand))
} else {
    Write-Host 'O servidor foi instalado, mas a API de IA so funcionara depois do login Google.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '4/4 Conferindo o servidor e recuperando a chave do proprietario...' -ForegroundColor Cyan
$keyCommand = "sed -n 's/^NUMIA_SERVER_TOKEN=//p' '$installDir/.env'"
$accessKeyLines = & ssh.exe @sshCommon $target $keyCommand
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel ler a chave gerada na VM.' }
$accessKey = ($accessKeyLines | Select-Object -Last 1).Trim()
if ($accessKey.Length -lt 32) { throw 'A chave retornada pela VM parece invalida.' }

$health = 'nao confirmado externamente'
try {
    $response = Invoke-RestMethod -Uri "https://$domain/health" -TimeoutSec 20
    if ($response.status -eq 'ok') { $health = 'online' }
} catch {
    $health = 'containers iniciados; confirme DNS e portas 80/443'
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host 'Instalacao finalizada' -ForegroundColor Green
Write-Host "Status:       $health"
Write-Host "URL NumIA:    https://$domain"
Write-Host "URL MCP:      https://$domain/mcp"
Write-Host "Chave NumIA:  $accessKey" -ForegroundColor Yellow
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host 'Guarde a chave em um gerenciador de senhas. Nao envie prints e nao a publique no GitHub.' -ForegroundColor Yellow
Write-Host 'Para conectar no Gemini Spark, use a URL MCP acima e informe essa chave somente na pagina do seu servidor.'
