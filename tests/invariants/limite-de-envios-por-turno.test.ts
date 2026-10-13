import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * O turno COMPLETO — do 1º envio aceito ao pós-loop.
 *
 * DEFEITO MEDIDO EM PRODUÇÃO: um lead recebeu ~8 mensagens seguidas (variações
 * da mesma pergunta de qualificação) porque nenhum gate de `before-send.ts`
 * limita CONTAGEM por turno — `pacing` só limita RITMO. O teto
 * `MAX_SENDS_PER_TURN` (F2-15b) foi a resposta E PERMANECE aqui como
 * proteção secundária.
 *
 * STEP 3 (parada por 1º envio ACEITO): o `pararQuando` no call site de
 * `runModelCall` (inbound-turn.ts) agora vale para TODOS os caminhos —
 * predicado avaliado ao FIM da etapa, sinal = aceitação real de cada caminho
 * (prévia: candidato em `result.candidates` pós-cadeia; vivo: `seq > 0`,
 * que só avança quando o envio sai pro canal e nunca em veto). Consequência:
 * depois de um envio aceito o modelo NÃO tem 2ª iteração, então o teto não é
 * mais alcançável por insistência do modelo — ele segura envios dentro da
 * MESMA etapa e qualquer regressão da parada.
 *
 * SEMÂNTICA CENTRAL: ACEITO, e não chamado. Envio vetado (gate de conteúdo ou
 * o próprio teto) volta ao modelo como erro de ensino e NÃO encerra o turno —
 * é o 1º veto que ensina a reescrever.
 *
 * Harness igual a `agent-send-template-turn.test.ts`: `createInboundTurnHandler`
 * real, modelo fake via `createFakeRegistry`, canal que CAPTURA em vez de
 * enviar. `sleep` é no-op — o throttle de `pacing` "espera" sem esperar de
 * verdade, então não interfere na contagem que este arquivo mede.
 *
 * MAPEAMENTO DOS 3 CASOS ORIGINAIS (comportamento anterior, reescritos aqui):
 *  - "insiste 5x e só as 2 primeiras (o teto) saem"  → TESTE 1 abaixo (agora
 *    só a 1ª sai; o teto não é mais atingível por iteração);
 *  - "sem o knob, o teto padrão ainda protege"       → o caso
 *    DEFAULT_MAX_SENDS_PER_TURN (a parada vence o teto antes de ele ser
 *    consultado);
 *  - "dentro do teto, nada é bloqueado"              → TESTE 1 (nenhum
 *    bloqueio existe: `max_sends_per_turn` nem aparece).
 *  A prova DO TETO voltou como TESTE 5 (teto 0, veto determinístico antes
 *  dos gates) + a observação de que o teto ainda segura a mesma etapa.
 *
 * ⚠️ `tests/invariants/**` é congelado (loop/hooks/freeze-invariants.sh): estes
 * casos vigiavam o comportamento ANTES da parada e foram reescritos para a
 * semântica nova aprovada (Step 3). Commit destas mudanças exige
 * `DESKCOMM_GOV_INVARIANTS_EDIT=1` citando a virada no commit message.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "dddddddd-0000-4000-8000-000000000001";
const CONTACT = "dddddddd-0000-4000-8000-000000000002";
const SESSION = "dddddddd-0000-4000-8000-000000000003";
const CONV = "dddddddd-0000-4000-8000-000000000004";
const MSG = "dddddddd-0000-4000-8000-000000000005";

interface EnvioCapturado {
  body: string;
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
/** Todo resultado de tool que o modelo VIU — inclui repetição entre steps, de propósito
 * (o que importa é que o bloqueio apareceu em algum lugar, não em qual exatamente). */
let resultadosVistos: unknown[] = [];
/** Chamadas ao modelo COM tools = iterações do loop PRINCIPAL. As SEM tools são o
 * fechamento pós-loop (`fecharOTurno`, `purpose: 'checkpoint'`) — nunca re-entram
 * o loop. Contadas à parte para asserções de "zero iteração depois do aceito". */
let iteracoesDoLoop = 0;
let chamadasSemTools = 0;

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Uma resposta do modelo: pode combinar send_message e update_lead_state NA
 * MESMA etapa (`send` + `update`) — é o que o TESTE 2 usa para provar que as
 * duas tools da etapa completam antes da parada. */
interface Acao {
  send?: string;
  update?: unknown;
  text?: string;
}

/**
 * Modelo fake guiado por roteiro por ETAPA (chamada com tools). Chamada SEM
 * tools = fechamento pós-loop (`fecharOTurno`), que devolve sempre o JSON de
 * checkpoint — sob a parada por 1º envio aceito, o resto do roteiro nunca é
 * consumido, e é EXATAMENTE isso que os testes medem (`iteracoesDoLoop`).
 * Esgotado o roteiro no loop principal, o modelo encerra com texto simples.
 */
function modeloComRoteiro(roteiro: Acao[]) {
  let etapa = 0;
  return async (opts: { prompt?: unknown; tools?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") resultadosVistos.push(parte.output ?? parte);
      }
    }
    const temTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    if (!temTools) {
      chamadasSemTools += 1;
      return montaResposta([{ type: "text", text: CHECKPOINT }]);
    }
    iteracoesDoLoop += 1;
    const acao = roteiro[etapa] ?? {};
    etapa += 1;
    const content: Array<Record<string, unknown>> = [];
    if (acao.send !== undefined) {
      content.push({
        type: "tool-call",
        toolCallId: `c${etapa}-0`,
        toolName: "send_message",
        input: JSON.stringify({ body: acao.send }),
      });
    }
    if (acao.update !== undefined) {
      content.push({
        type: "tool-call",
        toolCallId: `c${etapa}-1`,
        toolName: "update_lead_state",
        input: JSON.stringify(acao.update),
      });
    }
    if (content.length === 0) content.push({ type: "text", text: acao.text ?? "Concluído." });
    return montaResposta(content);
  };
}

function montaResposta(content: Array<Record<string, unknown>>) {
  return {
    content,
    finishReason: {
      unified: content[0]?.type === "tool-call" ? ("tool-calls" as const) : ("stop" as const),
      raw: undefined,
    },
    usage: USO,
    warnings: [],
  };
}

function montaHandler(doGenerate: unknown, maxSendsPerTurn?: number) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      ...(maxSendsPerTurn !== undefined ? { maxSendsPerTurn } : {}),
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return {
            kind: "sent" as const,
            idempotencyKey: `k${enviados.length}`,
            messageId: `m${enviados.length}`,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Terça, 15h BRT: dentro da janela anti-ban (7h-22h) — sem isso o gate `pacing`
    // vetaria por horário, e o teste mediria o motivo errado.
    clock: () => new Date("2026-07-28T18:00:00Z"),
    sleep: async () => {},
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: "dddddddd-0000-4000-8000-000000000006",
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "sends-cap", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "sends-cap" });
    await m.queue.completeJob(pool, claimed!.id, "sends-cap");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "sends-cap", err);
    return err as Error;
  }
}

async function checkpointsDaLead(): Promise<number> {
  const { rows } = await pool.query(
    "select count(*)::int as n from lead_checkpoints where organization_id=$1 and contact_id=$2",
    [ORG, CONTACT],
  );
  return rows[0].n;
}

async function nextActionDaLead(): Promise<string> {
  const { rows } = await pool.query(
    "select next_action from lead_state where organization_id=$1 and contact_id=$2",
    [ORG, CONTACT],
  );
  return rows[0]?.next_action ?? "";
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'limite-envios-turno','Limite Envios','Limite Envios') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Insistido','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'limite-envios-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(() => {
  enviados = [];
  resultadosVistos = [];
  iteracoesDoLoop = 0;
  chamadasSemTools = 0;
});

describe("parada por 1º envio ACEITO — o loop do modelo não tem 2ª iteração", () => {
  it("TESTE 1 — o modelo insiste 5x em etapas separadas e só o 1º envio sai; zero iteração depois do aceito", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloComRoteiro([
          { send: "pergunta de qualificação número 1 (caso-a)" },
          { send: "pergunta de qualificação número 2 (caso-a)" },
          { send: "pergunta de qualificação número 3 (caso-a)" },
          { send: "pergunta de qualificação número 4 (caso-a)" },
          { send: "pergunta de qualificação número 5 (caso-a)" },
        ]),
        3,
      ),
    );
    expect(erro).toBeNull();

    // O 1º envio ACEITO é o único que sai — as 4 tentativas restantes do
    // roteiro nunca chegaram a ser pedidas ao modelo.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toBe("pergunta de qualificação número 1 (caso-a)");
    expect(iteracoesDoLoop).toBe(1);

    // E nada foi BLOQUEADO — nem `max_sends_per_turn` (o teto não é mais o
    // que decide: a parada vence antes de ele ser consultado por iteração).
    expect(JSON.stringify(resultadosVistos)).not.toMatch(/max_sends_per_turn/);
  });

  it("sem o knob explícito, a parada vence o teto padrão (DEFAULT_MAX_SENDS_PER_TURN) antes de ele ser alcançado", async () => {
    const { DEFAULT_MAX_SENDS_PER_TURN } = await import("@/lib/agent-engine/agent/inbound-turn");
    const roteiro = Array.from({ length: DEFAULT_MAX_SENDS_PER_TURN + 3 }, (_, i) => ({
      send: `pergunta de qualificação número ${i + 1} (caso-b)`,
    }));
    const erro = await rodaTurno(montaHandler(modeloComRoteiro(roteiro)));
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(iteracoesDoLoop).toBe(1);
  });

  it("TESTE 4 — envio VETADO não encerra: o modelo vê o veto, reescreve, e o 2º (aceito) é que encerra", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloComRoteiro([
          // 1ª tentativa vaza vocabulário interno → veto
          // `internal_vocabulary_leak` (a mesma trava do rascunho assistido).
          { send: "Chamei crm_list_leads e o atendimento começa às oito horas (caso-c)." },
          // Reescrita limpa → aceita → encerra o turno.
          { send: "O atendimento começa às nove horas (caso-c)." },
          // Não deve chegar a ser pedida.
          { send: "terceira tentativa que não deve ocorrer (caso-c)." },
        ]),
      ),
    );
    expect(erro).toBeNull();

    // VETO ≠ ACEITO: o 1º envio NÃO saiu, NÃO encerrou, e o modelo teve a
    // 2ª iteração para reescrever. Só o aceito encerra.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain("nove horas");
    expect(enviados[0]!.body).not.toContain("crm_list_leads");
    expect(iteracoesDoLoop).toBe(2);

    // O modelo RECEBEU o veto (senão "encerrou" não distingue de "engoliu").
    const vistos = JSON.stringify(resultadosVistos);
    expect(vistos).toMatch(/internal_vocabulary_leak/);
    expect(vistos).not.toMatch(/max_sends_per_turn/);
  });

  it("TESTE 7 — parada antecipada não muda o pós-loop: checkpoint gravado, fechamento único, nenhum envio novo", async () => {
    const antes = await checkpointsDaLead();
    const erro = await rodaTurno(
      montaHandler(modeloComRoteiro([{ send: "Confirmação final (caso-g)." }])),
    );
    expect(erro).toBeNull();
    expect(enviados).toHaveLength(1);
    // Loop principal: 1 iteração. Fechamento: exatamente 1 chamada SEM tools
    // (`fecharOTurno`, purpose 'checkpoint') — que NÃO re-entra o loop nem
    // nasce dele um envio novo.
    expect(iteracoesDoLoop).toBe(1);
    expect(chamadasSemTools).toBe(1);
    expect(await checkpointsDaLead()).toBe(antes + 1);
    expect(enviados).toHaveLength(1);
  });
});

describe("ferramentas na mesma etapa x etapa posterior", () => {
  it("TESTE 2 — send_message + update_lead_state NA MESMA etapa: os dois completam antes da parada", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloComRoteiro([
          {
            send: "Resposta enviada na mesma etapa (caso-d).",
            update: { next_action: "enviar o orçamento revisado (caso-d)" },
          },
        ]),
      ),
    );
    expect(erro).toBeNull();

    // O envio saiu…
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain("caso-d");
    // …E a update_lead_state da MESMA etapa sobreviveu à parada (predicado
    // avaliado só no fim da etapa, depois de todas as tools executarem)…
    expect(await nextActionDaLead()).toContain("caso-d");
    // …sem nenhuma iteração seguinte do modelo.
    expect(iteracoesDoLoop).toBe(1);
  });

  it("TESTE 3 — update_lead_state numa etapa POSTERIOR ao envio aceito NÃO executa (comportamento intencional)", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloComRoteiro([
          { send: "Resposta antes do update tardio (caso-e)." },
          // Este passo existiria sem a parada; com ela, o modelo nem é
          // consultado — documenta o trade-off arquitetural aceito: tool de
          // etapa posterior não é alcançada depois do envio aceito. A ordem
          // correta para o modelo é emitir as duas na MESMA etapa (TESTE 2).
          { update: { next_action: "não deve aparecer (caso-e)" } },
        ]),
      ),
    );
    expect(erro).toBeNull();

    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain("caso-e");
    // A 2ª etapa nunca foi pedida ao modelo…
    expect(iteracoesDoLoop).toBe(1);
    // …logo a update dela não gravou nada (o valor do TESTE 2 pode existir —
    // mesma lead — mas NUNCA o desta etapa posterior).
    expect(await nextActionDaLead()).not.toContain("caso-e");
  });
});

describe("MAX_SENDS_PER_TURN — proteção secundária intacta", () => {
  it("TESTE 5 — teto 0 veta ANTES dos gates: nada escapa, o modelo recebe o ensino, e o veto não encerra o turno", async () => {
    const erro = await rodaTurno(
      montaHandler(
        modeloComRoteiro([
          { send: "tentativa 1 que o teto barra (caso-f)" },
          { send: "tentativa 2 que o teto barra (caso-f)" },
        ]),
        0,
      ),
    );
    expect(erro).toBeNull();

    // O teto continua decidindo: nenhuma mensagem física sai.
    expect(enviados).toHaveLength(0);

    // E o modelo RECEBEU o motivo do bloqueio — a asserção central do
    // invariante original sobrevive à virada.
    const vistos = JSON.stringify(resultadosVistos);
    expect(vistos).toMatch(/max_sends_per_turn/);
    expect(vistos).toMatch(/encerre o turno/);

    // O veto do teto NÃO encerra o turno: 2 iterações com envio vetado +
    // 1 etapa de texto que encerra o loop naturalmente. (Com o teto 0 o
    // primeiro envio é barrado de forma determinística antes de qualquer
    // gate — sem a corrida de tools paralelas dentro da mesma etapa, que é
    // pré-existente e fica para fora do escopo do Step 3.)
    expect(iteracoesDoLoop).toBe(3);
  });
});
