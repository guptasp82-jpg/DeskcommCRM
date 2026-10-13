#!/usr/bin/env bash
# tests/shell/predeploy-oracle.test.sh — o preflight do piloto Oracle recusa
# os modos errados e NUNCA imprime valor de segredo.
#
#   bash tests/shell/predeploy-oracle.test.sh
#
# O QUE ESTA SOB PROVA:
#   1. env vazio => exit 1 citando os NOMEs que faltam;
#   2. NENHUMA saida do validador contem o valor de uma variavel de segredo
#      (sentinela plantada em todas elas — mesma familia do senha-do-cron-vazada);
#   3. COMPOSE_FILE apontando para o overlay single-server => recusa;
#   4. imagem em :latest => recusa;
#   5. WAHA_IMAGE de arquitetura errada para o host => recusa;
#   6. SUPABASE_DB_URL de outro projeto / loopback => recusa (Supabase hospedado);
#   7. NEXT_PUBLIC_APP_URL fora do dominio declarado => recusa;
#   8. WAHA_WEBHOOK_BASE_URL publico (que o Caddy bloqueia com 403) => recusa;
#   9. env completo e coerente => exit 0;
#  10. o compose de prod RENDERIZA com o env sintetico e nao sobe nada em :latest
#      (pulado quando nao ha docker).
#
# Nada aqui cria container, toca rede ou le valor real: tudo e env sintetico.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDADOR="$RAIZ/scripts/validar-predeploy-oracle.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
casos=0
ok()    { printf '  ok      %s\n' "$1"; }
falha() { printf '  FALHA   %s\n' "$1"; falhas=$((falhas + 1)); }

if [ ! -f "$VALIDADOR" ]; then
  echo "FALHA  validador nao encontrado: $VALIDADOR"
  exit 1
fi

# ── 0. sintaxe dos dois arquivos ────────────────────────────────────────────
casos=$((casos + 1))
printf 'caso 0: sintaxe bash\n'
if bash -n "$VALIDADOR"; then ok "sintaxe do validador"; else falha "sintaxe do validador"; fi

# Sentinela: valor sintetico que NUNCA pode aparecer na saida do validador.
SENTINELA="SEGREDO-SENTINELA-NAO-PODE-APARECER-98765"

# montar <nome> — env sintetico completo e coerente.
montar() {
  local wa_img
  case "$(uname -m)" in
    aarch64|arm64) wa_img="devlikeapro/waha:noweb-arm-2026.7.2" ;;
    *)             wa_img="devlikeapro/waha:latest-2026.7.2" ;;
  esac
  cat > "$TMP/$1" <<FIM
DOMAIN=piloto.teste.invalido
ACME_EMAIL=admin@piloto.teste.invalido
NEXT_PUBLIC_APP_URL=https://piloto.teste.invalido
APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:stable
WORKER_IMAGE=ghcr.io/melgarafael/deskcomm-worker:stable
SCHEDULER_IMAGE=ghcr.io/melgarafael/deskcomm-scheduler:stable
WAHA_IMAGE=$wa_img
COMPOSE_PROFILES=
NEXT_PUBLIC_SUPABASE_URL=https://sintetico123.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=$SENTINELA
SUPABASE_SERVICE_ROLE_KEY=$SENTINELA
SUPABASE_DB_URL=postgresql://postgres.sintetico123:$SENTINELA@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
UPSTASH_REDIS_REST_URL=http://srh:80
UPSTASH_REDIS_REST_TOKEN=$SENTINELA
SRH_TOKEN=$SENTINELA
INTERNAL_SECRET=$SENTINELA
CPF_ENCRYPTION_KEY=$SENTINELA
AI_CRED_AES_KEY=$SENTINELA
WAHA_API_BASE_URL=http://waha:3000
WAHA_API_KEY=$SENTINELA
WAHA_API_KEY_SHA512=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
WAHA_HMAC_SECRET=$SENTINELA
WAHA_WEBHOOK_BASE_URL=http://app:3000
WAHA_WEBHOOK_REQUIRE_SIGNATURE=true
WAHA_BYO_ENCRYPTION_KEY=$SENTINELA
AGENT_DISPATCH_CONSUMER=engine
INTERNAL_AGENT_RUN_STUB=false
FIM
}

# rodar <arquivo> — sempre em modo so-env (sem docker/portas).
rodar() {
  SAIDA="$(PREDEPLOY_SOLO_ENV=1 bash "$VALIDADOR" --env "$TMP/$1" 2>&1)"
  RC=$?
}

# ── 1. env vazio recusa citando nomes ──────────────────────────────────────
casos=$((casos + 1))
printf 'caso 1: env vazio recusa\n'
: > "$TMP/vazio"
rodar vazio
if [ "$RC" -eq 1 ]; then ok "exit 1"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *INTERNAL_SECRET*) ok "cita INTERNAL_SECRET (so o nome)" ;;
  *)                 falha "nao cita INTERNAL_SECRET" ;;
esac
case "$SAIDA" in
  *DOMAIN*) ok "cita DOMAIN" ;;
  *)        falha "nao cita DOMAIN" ;;
esac

# ── 2. nenhum valor de segredo na saida (sentinela) ────────────────────────
casos=$((casos + 1))
printf 'caso 2: saida nao vaza valor de segredo\n'
montar vazamento
# quebra proposital em outro eixo, para o validador processar os segredos todos
sed -i 's/^INTERNAL_AGENT_RUN_STUB=false$/INTERNAL_AGENT_RUN_STUB=true/' "$TMP/vazamento"
rodar vazamento
if [ "$RC" -eq 1 ]; then ok "exit 1 na quebra proposital"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *"$SENTINELA"*) falha "VAZOU valor de segredo na saida" ;;
  *)              ok "nenhum valor de segredo na saida" ;;
esac
case "$SAIDA" in
  *INTERNAL_AGENT_RUN_STUB*) ok "cita a chave do problema" ;;
  *)                         falha "nao cita INTERNAL_AGENT_RUN_STUB" ;;
esac

# ── 3. overlay single-server recusado ───────────────────────────────────────
casos=$((casos + 1))
printf 'caso 3: COMPOSE_FILE= single-server recusado\n'
montar single
printf 'COMPOSE_FILE=docker-compose.single-server.yml\n' >> "$TMP/single"
rodar single
if [ "$RC" -eq 1 ]; then ok "exit 1"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *single-server*) ok "cita o overlay single-server" ;;
  *)               falha "nao cita single-server" ;;
esac

# ── 4. imagem em :latest recusada ───────────────────────────────────────────
casos=$((casos + 1))
printf 'caso 4: APP_IMAGE em :latest recusada\n'
montar latest
sed -i 's|^APP_IMAGE=.*|APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:latest|' "$TMP/latest"
rodar latest
if [ "$RC" -eq 1 ]; then ok "exit 1"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *APP_IMAGE*) ok "cita APP_IMAGE" ;;
  *)           falha "nao cita APP_IMAGE" ;;
esac

# ── 5. WAHA_IMAGE de arquitetura errada recusada ────────────────────────────
casos=$((casos + 1))
printf 'caso 5: WAHA_IMAGE de arquitetura errada recusada\n'
case "$(uname -m)" in
  x86_64)
    montar waarm
    sed -i 's|^WAHA_IMAGE=.*|WAHA_IMAGE=devlikeapro/waha:noweb-arm-2026.7.2|' "$TMP/waarm"
    rodar waarm
    if [ "$RC" -eq 1 ]; then ok "exit 1 (tag ARM64 em host x86_64)"; else falha "esperava exit 1, veio $RC"; fi
    case "$SAIDA" in
      *WAHA_IMAGE*) ok "cita WAHA_IMAGE" ;;
      *)            falha "nao cita WAHA_IMAGE" ;;
    esac ;;
  *)
    montar waamd
    sed -i 's|^WAHA_IMAGE=.*|WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2|' "$TMP/waamd"
    rodar waamd
    if [ "$RC" -eq 1 ]; then ok "exit 1 (tag x86 em host ARM64)"; else falha "esperava exit 1, veio $RC"; fi ;;
esac

# ── 6. banco de outro projeto / loopback recusados ──────────────────────────
casos=$((casos + 1))
printf 'caso 6: banco fora do projeto hospedado recusado\n'
montar outroref
sed -i 's|^SUPABASE_DB_URL=.*|SUPABASE_DB_URL=postgresql://postgres.outroref456:x@aws-0-ap-south-1.pooler.supabase.com:5432/postgres|' "$TMP/outroref"
rodar outroref
if [ "$RC" -eq 1 ]; then ok "exit 1 (ref divergente)"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *OUTRO*projeto*) ok "cita ref divergente" ;;
  *)               falha "nao explica a ref divergente" ;;
esac
montar loopback
sed -i 's|^SUPABASE_DB_URL=.*|SUPABASE_DB_URL=postgresql://postgres:x@127.0.0.1:5432/postgres|' "$TMP/loopback"
rodar loopback
if [ "$RC" -eq 1 ]; then ok "exit 1 (loopback = sem Supabase hospedado)"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *local/interno*) ok "cita host local/interno" ;;
  *)               falha "nao cita host local/interno" ;;
esac

# ── 7. URL publica fora do dominio declarado ────────────────────────────────
casos=$((casos + 1))
printf 'caso 7: NEXT_PUBLIC_APP_URL fora do dominio recusada\n'
montar urlerrada
sed -i 's|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=https://outro.dominio.invalido|' "$TMP/urlerrada"
rodar urlerrada
if [ "$RC" -eq 1 ]; then ok "exit 1"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *NEXT_PUBLIC_APP_URL*) ok "cita NEXT_PUBLIC_APP_URL" ;;
  *)                     falha "nao cita NEXT_PUBLIC_APP_URL" ;;
esac

# ── 8. webhook publico (que o Caddy bloqueia) recusado ──────────────────────
casos=$((casos + 1))
printf 'caso 8: WAHA_WEBHOOK_BASE_URL publico recusado\n'
montar hookpub
sed -i 's|^WAHA_WEBHOOK_BASE_URL=.*|WAHA_WEBHOOK_BASE_URL=https://piloto.teste.invalido|' "$TMP/hookpub"
rodar hookpub
if [ "$RC" -eq 1 ]; then ok "exit 1"; else falha "esperava exit 1, veio $RC"; fi
case "$SAIDA" in
  *Caddy*) ok "explica o bloqueio do Caddy" ;;
  *)       falha "nao explica o bloqueio do Caddy" ;;
esac

# ── 9. env completo e coerente passa ────────────────────────────────────────
casos=$((casos + 1))
printf 'caso 9: env completo coerente aprova\n'
montar valido
rodar valido
if [ "$RC" -eq 0 ]; then
  ok "exit 0"
else
  falha "esperava exit 0, veio $RC — vereditos:"
  printf '%s\n' "$SAIDA" | grep -E 'FALHA' | sed 's/^/         /'
fi
case "$SAIDA" in
  *APROVADO*) ok "resumo diz APROVADO" ;;
  *)          falha "resumo nao confirma aprovacao" ;;
esac

# ── 10. o compose de prod renderiza com o env sintetico (sem subir nada) ────
casos=$((casos + 1))
printf 'caso 10: docker compose config renderiza (so se ha docker)\n'
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  montar render
  if docker compose -f "$RAIZ/docker-compose.prod.yml" --env-file "$TMP/render" config -q >/dev/null 2>&1; then
    ok "compose config -q renderiza com o env sintetico"
  else
    falha "compose config -q falhou com o env sintetico"
  fi
  imgs="$(docker compose -f "$RAIZ/docker-compose.prod.yml" --env-file "$TMP/render" config --images 2>/dev/null | sort -u)"
  if [ -z "$imgs" ]; then
    falha "config --images vazio"
  elif printf '%s\n' "$imgs" | grep -Eq ':latest$'; then
    falha "imagem efetiva em :latest"
  else
    ok "nenhuma imagem efetiva em :latest"
  fi
else
  printf '  nota   docker compose indisponivel — subteste de render pulado\n'
fi

printf '\n%s caso(s), %s falha(s)\n' "$casos" "$falhas"
if [ "$falhas" -ne 0 ]; then
  echo "==> o preflight do piloto Oracle nao esta fechando como o esperado."
  exit 1
fi
echo "==> preflight do piloto Oracle: recusa os modos errados e nao vaza segredo."
