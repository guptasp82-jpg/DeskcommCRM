#!/usr/bin/env bash
#
# scripts/validar-predeploy-oracle.sh — preflight SOMENTE-LEITURA do deploy do
# DeskcommCRM numa VPS Oracle fresh (Ubuntu/ARM64), pelo caminho suportado do
# repositorio: docker-compose.prod.yml + Caddy + Supabase HOSPEDADO.
# (Nada de docker-compose.single-server.yml, Traefik ou NPM neste piloto.)
#
# Caracteristicas:
#   * falha FECHADA — pre-requisito critico ausente ou ambiguo = exit 1;
#   * NUNCA imprime valor de segredo: so NOME de variavel e veredito;
#   * nao cria, nao altera e nao deleta nada (nem servidor, nem banco, nem Git);
#   * nao roda SQL, migration nem baseline — isso e decisao humana
#     (docs/deploy-selfhost/README.md §2 e docs/runbooks/oracle-pilot.md).
#
# Uso:
#   bash scripts/validar-predeploy-oracle.sh                  # valida ./.env
#   bash scripts/validar-predeploy-oracle.sh --env caminho/x.env
#   bash scripts/validar-predeploy-oracle.sh --manifestas     # + prova ARM64 no registry
#
# Escapas EXPLICITAS (quem roda decide e responde por elas):
#   PREDEPLOY_SOLO_ENV=1            so as checagens do .env (sem docker/portas; p/ testes)
#   PREDEPLOY_PULAR_PORTAS=1        re-validacao com o stack ja de pe (80/443 nossas)
#   PREDEPLOY_PULAR_REF_SUPABASE=1  aceita banco cujo host nao embute a ref do projeto
#
# Limitacao documentada (em vez de pular em silencio): sem `ss` no PATH
# (ex.: Windows) a checagem de portas vira `nota` — no servidor Ubuntu ela roda.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$RAIZ/.env"
MANIFESTAS=0

uso() {
  cat <<'FIM'
Uso: bash scripts/validar-predeploy-oracle.sh [--env <arquivo>] [--manifestas]

  --env <arquivo>   valida outro arquivo de env (o deploy usa ./.env)
  --manifestas      acrescenta a prova de arquitetura via registry (docker manifest)
  -h, --help        esta ajuda

Variaveis de escapao (opcionais, explicitas):
  PREDEPLOY_SOLO_ENV=1  so checagens de .env (sem docker/portas)
  PREDEPLOY_PULAR_PORTAS=1  ignora portas 80/443 ocupadas (stack ja de pe)
  PREDEPLOY_PULAR_REF_SUPABASE=1  nao exige a ref do projeto no host do banco

O validador e somente leitura: nao mexe em servidor, banco, Git ou imagens.
FIM
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [ $# -ge 2 ] || { echo "uso: --env <arquivo>" >&2; exit 2; }
      ENVFILE="$2"; shift 2 ;;
    --manifestas) MANIFESTAS=1; shift ;;
    -h|--help) uso; exit 0 ;;
    *) echo "opcao desconhecida: $1 (use --help)" >&2; exit 2 ;;
  esac
done

falhas=0
ok()     { printf '  ok       %s\n' "$1"; }
falha()  { printf '  FALHA    %s\n' "$1"; falhas=$((falhas + 1)); }
nota()   { printf '  nota     %s\n' "$1"; }
secao()  { printf '\n== %s ==\n' "$1"; }

# valor <CHAVE> — le a CHAVE do ENVFILE para os checks INTERNOS.
# Nenhum chamador imprime o retorno: so saem daqui vereditos e nomes.
valor() {
  local linha
  linha="$(grep -E "^${1}=" "$ENVFILE" 2>/dev/null | tail -n 1)" || true
  [ -z "$linha" ] && return 0
  linha="${linha#*=}"
  linha="${linha%$'\r'}"
  case "$linha" in
    \"*\") linha="${linha#\"}"; linha="${linha%\"}" ;;
    \'*\') linha="${linha#\'}"; linha="${linha%\'}" ;;
  esac
  printf '%s' "$linha"
}

# ── 0. Os arquivos do caminho prod existem ──────────────────────────────────
secao "arquivos do caminho prod"
if [ ! -f "$RAIZ/docker-compose.prod.yml" ]; then falha "falta docker-compose.prod.yml na raiz"; fi
if [ ! -f "$RAIZ/Caddyfile" ]; then falha "falta Caddyfile na raiz (HTTPS + bloqueio do webhook global)"; fi
if [ ! -f "$ENVFILE" ]; then
  falha "arquivo de env nao encontrado: $ENVFILE (cp .env.oracle.example .env e preencha)"
  printf '\n%s falha(s) — preflight abortado: sem env nao ha mais nada seguro para checar.\n' "$falhas"
  exit 1
fi
ok "docker-compose.prod.yml + Caddyfile + env presentes"
if [ "$ENVFILE" != "$RAIZ/.env" ]; then
  nota "validando $ENVFILE, mas o compose de prod carrega automaticamente ./.env — no deploy, garanta que e o mesmo arquivo"
fi

# ── 1. Variaveis obrigatorias (so nomes; valores nunca aparecem) ────────────
secao "variaveis obrigatorias (so nomes aparecem aqui)"
OBRIGATORIAS="ACME_EMAIL AGENT_DISPATCH_CONSUMER AI_CRED_AES_KEY APP_IMAGE
  CPF_ENCRYPTION_KEY DOMAIN INTERNAL_AGENT_RUN_STUB INTERNAL_SECRET
  NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL
  SCHEDULER_IMAGE SRH_TOKEN SUPABASE_DB_URL SUPABASE_SERVICE_ROLE_KEY
  UPSTASH_REDIS_REST_TOKEN UPSTASH_REDIS_REST_URL WAHA_API_BASE_URL WAHA_API_KEY
  WAHA_API_KEY_SHA512 WAHA_BYO_ENCRYPTION_KEY WAHA_HMAC_SECRET WAHA_IMAGE
  WAHA_WEBHOOK_BASE_URL WAHA_WEBHOOK_REQUIRE_SIGNATURE WORKER_IMAGE"
faltando=""
n_total=0
for chave in $OBRIGATORIAS; do
  n_total=$((n_total + 1))
  if [ -z "$(valor "$chave")" ]; then faltando="$faltando $chave"; fi
done
if [ -n "$faltando" ]; then
  falha "ausentes ou vazias:$faltando"
else
  ok "$n_total variaveis obrigatorias presentes"
fi

# COMPOSE_PROFILES precisa existir como LINHA e com valor VAZIO no piloto.
if grep -qE '^COMPOSE_PROFILES=' "$ENVFILE"; then
  vcp="$(valor COMPOSE_PROFILES)"
  if [ -z "$vcp" ]; then
    ok "COMPOSE_PROFILES vazio (piloto sobe so os servicos base)"
  else
    falha "COMPOSE_PROFILES com valor ($vcp) — voz/telefonia ficam fora do piloto"
  fi
else
  falha "linha COMPOSE_PROFILES= ausente (copie do .env.oracle.example)"
fi

# ── 2. Placeholders esquecidos ──────────────────────────────────────────────
secao "placeholders nao trocados"
ph_ruim=0
for chave in DOMAIN ACME_EMAIL NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_URL APP_IMAGE; do
  v="$(valor "$chave")"
  case "$v" in
    *SEU-*|*SEU_*|*seudominio*|*example.invalid*|*CHANGE_ME*|*CHANGEME*|*TROQUE*)
      falha "$chave ainda esta com placeholder do template"; ph_ruim=1 ;;
  esac
done
[ "$ph_ruim" -eq 0 ] && ok "nenhum placeholder esquecido nos campos publicos"

# ── 3. Dominio e HTTPS ──────────────────────────────────────────────────────
secao "dominio e HTTPS"
vd="$(valor DOMAIN)"
if [ -n "$vd" ]; then
  if printf '%s' "$vd" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
    ok "DOMAIN com formato de FQDN"
  else
    falha "DOMAIN nao e um FQDN minusculo valido"
  fi
fi
vu="$(valor NEXT_PUBLIC_APP_URL)"
if [ -n "$vd" ] && [ -n "$vu" ]; then
  if [ "$vu" = "https://$vd" ]; then
    ok "NEXT_PUBLIC_APP_URL = https://DOMAIN (certificado e cookies fecham)"
  else
    falha "NEXT_PUBLIC_APP_URL difere de https://\$DOMAIN"
  fi
fi
ve="$(valor ACME_EMAIL)"
if [ -n "$ve" ]; then
  case "$ve" in
    *@*.*) ok "ACME_EMAIL com formato de e-mail" ;;
    *)     falha "ACME_EMAIL sem formato de e-mail" ;;
  esac
fi

# ── 4. Imagens: pin, sem :latest, arquitetura certa ─────────────────────────
secao "imagens (tag explicita, sem :latest, arquitetura do host)"
arch="$(uname -m)"
case "$arch" in
  aarch64|arm64) eh_arm=1 ;;
  *)             eh_arm=0 ;;
esac
nota "host detectado: $arch"
for chave in APP_IMAGE WORKER_IMAGE SCHEDULER_IMAGE WAHA_IMAGE; do
  vi="$(valor "$chave")"
  [ -z "$vi" ] && continue
  case "$vi" in
    *:latest) falha "$chave termina em :latest (release nao identificada)" ;;
    *:*)      ok "$chave com tag explicita" ;;
    *)        falha "$chave sem tag nenhuma" ;;
  esac
done
viwa="$(valor WAHA_IMAGE)"
if [ -n "$viwa" ]; then
  case "$viwa" in
    *noweb-arm*|*arm64*)
      if [ "$eh_arm" -eq 1 ]; then
        ok "WAHA_IMAGE e tag ARM64 em host ARM64"
      else
        falha "WAHA_IMAGE e tag ARM64 mas este host e x86_64 (o waha nao sobe)"
      fi ;;
    *latest-*)
      if [ "$eh_arm" -eq 1 ]; then
        falha "WAHA_IMAGE $viwa e so x86_64; em ARM64 use devlikeapro/waha:noweb-arm-<mesma data da versao>"
      else
        ok "WAHA_IMAGE tag x86 em host x86"
      fi ;;
    *) nota "WAHA_IMAGE fora do padrao noweb-arm/latest-<data>: confira a tag no compose" ;;
  esac
fi

# ── 5. Supabase hospedado: consistencia OFFLINE (host nunca e exibido) ──────
secao "Supabase hospedado (consistencia offline; nenhum valor sai daqui)"
vup="$(valor NEXT_PUBLIC_SUPABASE_URL)"
ref=""
if [ -n "$vup" ]; then
  if printf '%s' "$vup" | grep -Eq '^https://[a-z0-9-]+\.supabase\.(co|in)$'; then
    ok "URL publica com formato de projeto Supabase hospedado"
    hp="${vup#*://}"
    ref="${hp%%.*}"
  else
    falha "NEXT_PUBLIC_SUPABASE_URL fora do padrao https://<projeto>.supabase.co"
  fi
fi
vdb="$(valor SUPABASE_DB_URL)"
if [ -n "$vdb" ]; then
  if printf '%s' "$vdb" | grep -Eq '^[a-z]+://.*@[^:/?]+(:[0-9]+)?(/|$)'; then
    dbhost="$(printf '%s' "$vdb" | sed -E 's|^[a-z]+://.*@([^:/?]+).*|\1|')"
    # O host do Session pooler atual (aws-<N>-<regiao>.pooler.supabase.com) NAO
    # embute a ref do projeto — ela so existe no USUARIO (postgres.<ref>), que e
    # o criterio do install.sh:392-407. Por isso a comparacao e pelo usuario.
    dbuser="$(printf '%s' "$vdb" | sed -E 's|^[a-z]+://([^:/@]+).*|\1|')"
    dbref="${dbuser#postgres.}"
    case "$dbhost" in
      localhost|127.*|::1|0.0.0.0|postgres|db|pg|redis|supabase)
        falha "SUPABASE_DB_URL aponta para host local/interno — o piloto exige o Supabase hospedado (nao ha banco proprio no compose)" ;;
      *supabase.*)
        if [ -n "$ref" ]; then
          if [ "${PREDEPLOY_PULAR_REF_SUPABASE:-0}" = 1 ]; then
            nota "ref do banco PULADA por PREDEPLOY_PULAR_REF_SUPABASE=1 (aceitacao explicita)"
          elif [ "$dbref" = "postgres" ]; then
            falha "SUPABASE_DB_URL sem ref no usuario (postgres.<ref>) — nao da pra confirmar o projeto; copie a Session pooler (URI) do mesmo projeto da URL"
          elif [ "$dbref" = "$ref" ]; then
            ok "banco coerente com a URL publica (usuario postgres.<ref> confere; host e senha nao exibidos)"
          else
            falha "SUPABASE_DB_URL e de OUTRO projeto (ref no usuario divergente) — nao rode schema/bootstrap antes de corrigir"
          fi
        fi ;;
      *)
        falha "SUPABASE_DB_URL com host que nao e do Supabase hospedado" ;;
    esac
  else
    falha "SUPABASE_DB_URL sem formato postgres://user@host"
  fi
fi
vadm="$(valor SUPABASE_DB_ADMIN_URL)"
if [ -n "$vadm" ] && [ -n "$ref" ]; then
  if printf '%s' "$vadm" | grep -Fq -- "$ref"; then
    ok "SUPABASE_DB_ADMIN_URL na mesma ref do projeto"
  else
    falha "SUPABASE_DB_ADMIN_URL aponta para outra ref"
  fi
fi

# ── 6. Segredos: so formato/tamanho — o valor nunca sai daqui ───────────────
secao "segredos (so formato e tamanho; nenhum valor e impresso)"
minimo() {
  local v
  v="$(valor "$1")"
  [ -z "$v" ] && return 0
  if [ "${#v}" -ge "$2" ]; then
    ok "$1 presente (tamanho minimo)"
  else
    falha "$1 curto demais — gere outro (openssl rand -base64 32), sem reutilizar"
  fi
}
minimo INTERNAL_SECRET 16
minimo CPF_ENCRYPTION_KEY 16
minimo AI_CRED_AES_KEY 16
minimo SRH_TOKEN 16
minimo UPSTASH_REDIS_REST_TOKEN 16
minimo WAHA_API_KEY 12
minimo WAHA_HMAC_SECRET 16
minimo WAHA_BYO_ENCRYPTION_KEY 16
vsha="$(valor WAHA_API_KEY_SHA512)"
if [ -n "$vsha" ]; then
  case "$vsha" in
    *[!0-9a-fA-F]*) falha "WAHA_API_KEY_SHA512 nao e hexadecimal" ;;
    *)
      # sha512 hex completo tem 128 chars — e o que geram install.sh:1476 e
      # local-env.sh:124 (openssl dgst -sha512 / sha512sum). 64 seria sha256.
      if [ "${#vsha}" -eq 128 ]; then
        ok "WAHA_API_KEY_SHA512 hex de 128 caracteres (sha512 completo)"
      else
        falha "WAHA_API_KEY_SHA512 com tamanho diferente de 128 (esperado sha512 hex)"
      fi ;;
  esac
fi

# ── 7. Postura do piloto: WAHA, IA, modo de deploy ──────────────────────────
secao "postura do piloto (webhook interno, IA off, single-server proibido)"
if [ "$(valor WAHA_WEBHOOK_BASE_URL)" = "http://app:3000" ]; then
  ok "WAHA_WEBHOOK_BASE_URL=http://app:3000 (topologia in-stack)"
else
  falha "WAHA_WEBHOOK_BASE_URL precisa ser http://app:3000 — o Caddy responde 403 no webhook global publico (Caddyfile, @waha_global)"
fi
if [ "$(valor WAHA_API_BASE_URL)" = "http://waha:3000" ]; then
  ok "WAHA_API_BASE_URL=http://waha:3000 (rede interna do compose)"
else
  falha "WAHA_API_BASE_URL precisa ser http://waha:3000 (waha e app na mesma rede compose)"
fi
if [ -n "$(valor WAHA_HOOK_BASE_URL)" ]; then
  falha "WAHA_HOOK_BASE_URL presente: e variavel do compose de DESENVOLVIMENTO — no servidor so vale WAHA_WEBHOOK_BASE_URL (.env misturado com dev?)"
fi
vss="$(valor SINGLE_SERVER)"
case "$vss" in
  ''|0|false|no) ok "SINGLE_SERVER ausente ou desligado (overlay single-server fora)" ;;
  *)             falha "SINGLE_SERVER=$vss — este piloto NAO usa o overlay single-server" ;;
esac
vcf="$(valor COMPOSE_FILE)"
if [ -n "$vcf" ] && [ "$vcf" != "docker-compose.prod.yml" ]; then
  falha "COMPOSE_FILE no env aponta para $vcf — piloto usa so docker-compose.prod.yml (traefik/npm/single-server fora)"
fi
if [ -n "${COMPOSE_FILE:-}" ] && [ "$COMPOSE_FILE" != "docker-compose.prod.yml" ]; then
  falha "COMPOSE_FILE exportado no ambiente aponta para $COMPOSE_FILE — ambiguidade; desexporte"
fi
if [ "$(valor INTERNAL_AGENT_RUN_STUB)" = "false" ]; then
  ok "INTERNAL_AGENT_RUN_STUB=false (sem resposta de IA falsa)"
else
  falha "INTERNAL_AGENT_RUN_STUB precisa ser false — stub liga respostas de IA falsas"
fi
if [ "$(valor AGENT_DISPATCH_CONSUMER)" = "engine" ]; then
  ok "AGENT_DISPATCH_CONSUMER=engine (valor de producao)"
else
  falha "AGENT_DISPATCH_CONSUMER precisa ser engine (native e obsoleto; o drain so existe no worker)"
fi
if [ "$(valor WAHA_WEBHOOK_REQUIRE_SIGNATURE)" = "true" ]; then
  ok "WAHA_WEBHOOK_REQUIRE_SIGNATURE=true (assinatura de webhook exigida)"
else
  falha "WAHA_WEBHOOK_REQUIRE_SIGNATURE precisa ser true neste piloto (false e so para dev)"
fi

# ── 8. Docker, render do compose, portas, manifestos (pulavel em testes) ────
if [ "${PREDEPLOY_SOLO_ENV:-0}" = 1 ]; then
  secao "docker/portas"
  nota "PREDEPLOY_SOLO_ENV=1 — checagens de docker, render e portas puladas (modo teste)"
else
  secao "docker, render do compose e portas"
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    ok "docker de pe"
  else
    falha "docker indisponivel ou parado (docker version falhou)"
  fi
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose v2 disponivel"
  else
    falha "docker compose v2 indisponivel"
  fi
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    # O render e a prova de sintaxe + interpolacao. Saida do compose em erro
    # cita arquivo/linha/nome de variavel — nunca o valor das chaves.
    if erro="$(docker compose -f "$RAIZ/docker-compose.prod.yml" --env-file "$ENVFILE" config 2>&1 1>/dev/null)"; then
      ok "docker compose config renderiza com este env"
    else
      falha "docker compose config nao renderizou — mensagens (so citam arquivo/linha/nome):"
      printf '%s\n' "$erro" | tail -n 6 | sed 's/^/         /'
    fi
    imgs="$(docker compose -f "$RAIZ/docker-compose.prod.yml" --env-file "$ENVFILE" config --images 2>/dev/null | sort -u)"
    if [ -z "$imgs" ]; then
      falha "config --images nao devolveu imagem nenhuma"
    elif printf '%s\n' "$imgs" | grep -Eq ':latest$'; then
      falha "imagem efetiva terminando em :latest no render"
    else
      ok "nenhuma imagem efetiva em :latest ($(printf '%s\n' "$imgs" | wc -l | tr -d ' ') imagens)"
    fi
    if [ "$MANIFESTAS" = 1 ]; then
      arch_esp="$([ "$eh_arm" -eq 1 ] && echo arm64 || echo amd64)"
      for img in "$(valor APP_IMAGE)" "$(valor WORKER_IMAGE)" "$(valor SCHEDULER_IMAGE)" "$viwa"; do
        [ -z "$img" ] && continue
        if man="$(docker manifest inspect "$img" 2>/dev/null)" && \
           printf '%s' "$man" | grep -q "\"architecture\":\"$arch_esp\""; then
          ok "manifest de $img tem $arch_esp"
        else
          falha "manifest de $img inacessivel ou sem $arch_esp (ou a tag nao existe)"
        fi
      done
    fi
  fi
  if [ "${PREDEPLOY_PULAR_PORTAS:-0}" = 1 ]; then
    nota "portas 80/443 puladas por PREDEPLOY_PULAR_PORTAS=1 (re-validacao com stack de pe)"
  elif command -v ss >/dev/null 2>&1; then
    ocupadas="$(ss -Hltn 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' || true)"
    if [ -n "$ocupadas" ]; then
      falha "porta(s) 80/443 em LISTEN neste host — ou ja ha um stack de pe, ou outro servico impede o Caddy (inspecione com: ss -ltnp | grep -E ':80|:443'; re-validacao legitima: PREDEPLOY_PULAR_PORTAS=1)"
    else
      ok "portas 80/443 livres para o Caddy"
    fi
  else
    nota "ss indisponivel neste host: checagem de portas pulada (no servidor Ubuntu ela roda)"
  fi
fi

# ── 9. Resumo ───────────────────────────────────────────────────────────────
printf '\n----------------------------------------\n'
if [ "$falhas" -eq 0 ]; then
  nota "primeiro up NAO inclui o worker de IA — ver docs/runbooks/oracle-pilot.md (fase 1)"
  echo "==> preflight APROVADO: $(basename "$ENVFILE") pronto para o deploy controlado."
  exit 0
fi
echo "==> preflight REPROVADO: $falhas falha(s). Corrija o .env pelos nomes acima e rode de novo."
echo "    Nenhum arquivo, container ou banco foi alterado."
exit 1
