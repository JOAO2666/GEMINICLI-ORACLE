#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:-}"
INSTALL_DIR="${2:-}"
REPOSITORY="https://github.com/JOAO2666/GEMINICLI-ORACLE.git"

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Dominio invalido." >&2
  exit 2
fi
if [[ ! "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "Pasta de instalacao invalida." >&2
  exit 2
fi

echo "Preparando a VM sem alterar configuracoes de faturamento..."

install_prerequisites() {
  if command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then
    return
  fi

  echo "Instalando Git, curl, certificados e OpenSSL..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf -y install dnf-plugins-core git curl ca-certificates openssl
  else
    echo "Distribuicao nao suportada automaticamente. Instale Docker Compose, Git, curl e OpenSSL manualmente." >&2
    exit 3
  fi
}

install_docker() {
  install_prerequisites
  if command -v docker >/dev/null 2>&1 && sudo docker compose version >/dev/null 2>&1; then
    sudo systemctl enable --now docker >/dev/null 2>&1 || true
    return
  fi

  echo "Instalando Docker..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "Distribuicao nao suportada automaticamente. Instale Docker Compose manualmente." >&2
    exit 3
  fi
  sudo systemctl enable --now docker
}

install_docker

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Atualizando uma instalacao existente..."
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "A pasta $INSTALL_DIR existe, mas nao e um clone Git. Escolha outra pasta." >&2
  exit 4
else
  git clone "$REPOSITORY" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_secret() {
  local key="$1"
  local current
  current="$(sed -n "s/^${key}=//p" .env | tail -n 1)"
  if [[ ${#current} -lt 32 || "$current" == troque-* ]]; then
    current="$(openssl rand -hex 32)"
    set_env "$key" "$current"
  fi
}

if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL e necessario para gerar as chaves." >&2
  exit 5
fi

set_env NODE_ENV production
set_env DOMAIN "$DOMAIN"
set_env PUBLIC_BASE_URL "https://$DOMAIN"
set_env ALLOWED_ORIGINS "https://$DOMAIN"
set_env MCP_ENABLED true
set_env TRUST_PROXY true
set_env REQUIRE_HTTPS true
ensure_secret NUMIA_SERVER_TOKEN
ensure_secret MCP_WORKER_TOKEN

numia_token="$(sed -n 's/^NUMIA_SERVER_TOKEN=//p' .env | tail -n 1)"
worker_token="$(sed -n 's/^MCP_WORKER_TOKEN=//p' .env | tail -n 1)"
if [[ "$numia_token" == "$worker_token" ]]; then
  set_env MCP_WORKER_TOKEN "$(openssl rand -hex 32)"
fi

chmod 600 .env
echo "Construindo e iniciando os servicos. Isso pode levar alguns minutos..."
sudo docker compose up -d --build
sudo docker compose ps

echo
echo "Aplicacao instalada. O assistente do Windows continuara com o login Google."
