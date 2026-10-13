# Runbook — piloto Oracle Cloud (VPS ARM64, deploy controlado)

> **Status: PREPARADO, NAO EXECUTADO.** Nada deste runbook foi rodado pela
> preparação; o deploy começa só depois de revisão + aprovação do dono.
> Fronteira desta etapa: sem SQL, sem migration, sem installer, sem sessão de
> WhatsApp, sem mensagem a paciente, sem publicação de agente.

## 0. Arquitetura escolhida e por quê

| Peca | Escolha | Evidencia no repositorio |
| --- | --- | --- |
| Stack | `docker-compose.prod.yml` (caddy → app + waha + redis + srh + scheduler) | `docs/deploy-selfhost/README.md` §3 — caminho selfhost suportado |
| HTTPS/reverse proxy | **Caddy** do proprio repo (`Caddyfile`) — HTTPS automatico | compose sobe so o Caddy publica 80/443; webhook global publico bloqueado com 403 (`@waha_global`) |
| Banco | **Supabase hospedado existente** (nao ha container de banco) | `docker-compose.prod.yml` nao define servico de Postgres; `lib/env.ts` exige as variaveis do hospedado em prod |
| `SINGLE_SERVER=1` / `docker-compose.single-server.yml` | **Proibido** | decisao do piloto; o validador recusa |
| Traefik / NPM | Fora — VPS fresh, Caddy resolve sozinho | `docker-compose.traefik.yml` e overlay opcional; Caddy ja vem no prod |
| Recursos | Sem alteracao: `app mem_limit 768m`, `worker 512m`, log rotation 10m×3 | ja adequados a 12 GB / 2 OCPUs |
| Build no VPS | **Nenhum** — tudo puxa do GHCR/Docker Hub | `APP_IMAGE` etc. sao `image:` prontos; build seria `-f docker-compose.build.yml` (fogas deste piloto) |

### ARM64 — evidencia (verificada em 2026-10-10 via `docker manifest inspect`)

| Imagem | Tag pinada | Plataformas |
| --- | --- | --- |
| `ghcr.io/melgarafael/deskcommcrm` | `:stable` | linux/amd64, **linux/arm64** |
| `ghcr.io/melgarafael/deskcomm-worker` | `:stable` | linux/amd64, **linux/arm64** |
| `ghcr.io/melgarafael/deskcomm-scheduler` | `:stable` | linux/amd64, **linux/arm64** |
| `devlikeapro/waha` | `noweb-arm-2026.7.2` (ARM64) | **linux/arm64** (a tag `latest-2026.7.2` e so linux/amd64 — por isso `WAHA_IMAGE` tem de ser trocada) |
| `caddy:2-alpine`, `redis:7-alpine` | oficiais | multi-arch incl. arm64 |
| `hiett/serverless-redis-http` | digest `5b0bb923…` (pinado no compose) | linux/amd64, **linux/arm64** |

- `:stable` = canal de release proprio do repositorio (`docker-compose.prod.yml`
  documenta: `:stable` = ultima release, `:latest` = topo da main e proibido).
  Tag numerada (ex.: `:1.40.0`) pode ser usada para congelar versao — conferir
  antes com `docker manifest inspect <imagem>`.
- Prova repetivel no servidor: `bash scripts/validar-predeploy-oracle.sh --manifestas`.

## 1. Pre-requisitos (dependem do dono — 1 instrucao cada)

1. **Dominio real**: registro `A` apontando para o IP da VPS, com 80/443
   resolvendo ANTES do primeiro `up` (senao o Let's Encrypt falha).
   *Instrucao: me diga o dominio e confirme o DNS respondendo.*
2. **Oracle (security list da subnet)**: ingress TCP 80 e 443 (0.0.0.0/0 para o
   ACME HTTP-01 + HTTPS) e **SSH so do IP do administrador** (`/32`, nao `0.0.0.0/0`).
   *Instrucao: no console OCI, Networking → Security Lists → regras acima.*
3. **No servidor**: Docker Engine + compose v2, clone do repositorio,
   `cp .env.oracle.example .env` e preenchimento dos vazios la (`chmod 600`).
   Segredos so no servidor: nunca em Git, log, chat ou comando colado.
4. **Estado do schema** do Supabase confirmado (o `baseline.sql` NAO roda na
   preparacao; aplicacao e passo humano — `docs/deploy-selfhost/README.md` §2).
   *Instrucao: confirme se o projeto hospedado ja tem o schema aplicado.*

## 2. Preflight (somente leitura; pode rodar quantas vezes quiser)

```bash
# no servidor, na raiz do clone:
bash scripts/validar-predeploy-oracle.sh              # valida ./.env
bash scripts/validar-predeploy-oracle.sh --manifestas  # + prova ARM64 no registry
```

Ele checa (e recusa fechado): Docker/compose; `docker compose config` render;
nomes/valores obrigatorios do `.env` (sem imprimir segredo); dominio coerente
com `NEXT_PUBLIC_APP_URL`; imagens sem `:latest` e WAHA da arquitetura certa;
banco apontando para o MESMO projeto hospedado; portas 80/443 livres; proibicao
de single-server/Traefik/NPM e de `WAHA_HOOK_BASE_URL` (var de dev); postura de
piloto (`INTERNAL_AGENT_RUN_STUB=false`, `AGENT_DISPATCH_CONSUMER=engine`,
`WAHA_WEBHOOK_REQUIRE_SIGNATURE=true`, `COMPOSE_PROFILES` vazio).
Ele **nao** mexe em nada: servidor, banco, Git e imagens ficam intocados.

## 3. Fase 1 — subir SEM o worker (nenhuma IA responde)

```bash
docker compose -f docker-compose.prod.yml config -q      # render final
docker compose -f docker-compose.prod.yml up -d caddy app waha redis srh scheduler
docker compose -f docker-compose.prod.yml ps             # tudo (healthy)
curl -fsS https://SEU_DOMINIO/api/v1/health              # saude (supabase/redis/waha)
docker compose -f docker-compose.prod.yml logs app --tail 50
```

- O `worker` fica **de fora de proposito**: sem ele nao ha resposta de IA —
  alavanca de seguranca do piloto (fase 4).
- `docker-compose.prod.yml` e o unico `-f` deste caminho (o `docs/runbooks/deploy.md`
  com dois `-f` e o caminho Traefik, NAO usado aqui).

## 4. Fase 2 — webhook inbound com numero de TESTE (worker ainda de fora)

1. `/app/connections` → conectar um **numero de teste dedicado** (QR ou pairing);
   contatos sinteticos apenas.
2. Enviar uma mensagem desse numero para o numero de teste.
3. **Prova de inbound**: linha nova chega no CRM (mensagens/inbound) e o
   `send_ledger` continua **vazio** (nenhuma saida foi gerada).
4. Se 401/403 no hook: `WAHA_HMAC_SECRET` igual dos dois lados (sem imprimir),
   `WAHA_WEBHOOK_BASE_URL=http://app:3000`. 403 vindo de FORA e **por design**
   (`Caddyfile` bloqueia o webhook global publico; rota por token e o caminho
   canonico para WAHA externo — fora do escopo deste piloto).

## 5. Fase 3 — ligar o worker so apos inbound provado

```bash
docker compose -f docker-compose.prod.yml up -d worker
docker compose -f docker-compose.prod.yml logs -f worker   # esperado: agent-engine pronto
```

Ai sim: resposta de IA, takeover humano, agendamento e recovery (ainda com
contatos de teste). Publicar agente / conectar pacientes reais / enviar
mensagens: **so com aprovacao explicita do dono**, etapa separada.

## 6. Saude e rollback

- **Saude**: `ps` tudo healthy; `/api/v1/health` com `waha configured`; `df -h`
  com folga; `logs --tail` sem erro repetido; `docker stats --no-stream` dentro
  dos limites (app 768m / worker 512m).
- **Rollback de versao**: no `.env`, volte `APP_IMAGE` (e `WORKER_IMAGE`/
  `SCHEDULER_IMAGE`) para a tag anterior conhecada e
  `docker compose -f docker-compose.prod.yml up -d app worker scheduler`
  (pull da tag antiga). Nunca use `:latest` para voltar.
- **Rollback total**: `docker compose -f docker-compose.prod.yml down`
  (nao apaga volumes nem o `.env`; nenhum dado do Supabase e tocado).
- **Banco**: NENHUM rollback automatico — schema/migrations sao passos humanos.

## 7. Firewall (documentado; nada foi alterado)

- **Oracle (security list)**: TCP 80 e 443 de 0.0.0.0/0 (ACME + HTTPS);
  TCP 22 **so do IP do administrador** (`/32`); mais nada. Redis, srh, WAHA e
  app nao publicam porta nenhuma — so o Caddy expoe 80/443.
- **No host (opcional)**: `ufw allow from <IP-ADMIN> to any port 22 proto tcp`,
  `ufw allow 80/tcp`, `ufw allow 443/tcp`, `ufw enable` — executar SO com
  aprovacao (mudanca de firewall).

## 8. Proximo comando (NAO executado aqui; roda apos aprovacao)

```bash
# servidor, depois do preflight verde e do DNS confirmado:
docker compose -f docker-compose.prod.yml up -d caddy app waha redis srh scheduler
```

## 9. O que NAO faz parte desta preparacao

`hostgator-setup-kit/install.sh` e `update.sh`, `ubuntu-production-installer.sh`,
qualquer SQL (`baseline.sql`, migrations), sessao WhatsApp antes da fase 4,
mensagem a paciente, publicacao de agente, integracao Qmarksoft.
