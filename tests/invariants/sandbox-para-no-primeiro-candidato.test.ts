/**
 * TESTE 6 — SANDBOX: PARADA NO 1º CANDIDATO ACEITO.
 *
 * O `pararQuando` da prévia era restrito ao rascunho assistido
 * (`preview?.kind === 'assisted'`); o Step 3 estendeu o MESMO predicado ao
 * sandbox, com o MESMO sinal: `result.candidates.length > 0`. O candidato só
 * entra em `candidates` depois da cadeia before_send do sandbox passar
 * (`applyPreviewPolicy`) — veto vira `impediments`, sem candidato, e o turno
 * continua (aquilo o modelo já podia consertar).
 *
 * Aqui o modelo NUNCA PARA de mandar `send_message` (o fake não tem texto de
 * fim): sem a parada, ele espraiaria candidatos por todas as etapas até o
 * `maxSteps`. O contrato medido: EXATAMENTE UM candidato e NENHUMA iteração
 * de modelo DEPOIS do candidato aceito. Nenhuma mensagem real sai — a prévia
 * não tem transporte (fetch proibido, mockado aqui como guarda).
 *
 * Arquivo próprio (e não um caso a mais em `autonomia-preview-core.test.ts`)
 * porque `tests/invariants/**` é congelado para edição
 * (loop/hooks/freeze-invariants.sh) — adicionar arquivo novo é o caminho.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { runAgentPreview } from "@/lib/agent-engine/agent/inbound-turn";
import { CHECKPOINT_INSTRUCTION } from "@/lib/agent-engine/agent/abertura/checkpoint";
import {
  scenarioContext,
  newPreviewResult,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createLogger } from "@/lib/agent-engine/obs/logger";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});
beforeAll(async () => {
  await seedGov();
  await pool.query(
    `with v as(insert into playbook_versions(organization_id,layer,content) select null,'platform','## Identidade: Assistente de teste.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id) insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`,
  );
});
afterAll(() => pool.end());

it("TESTE 6 — sandbox: modelo tenta mandar em toda etapa, mas só o 1º candidato existe e nada roda depois dele", async () => {
  const f = await replyFixture(pool);
  const agent = (await loadAgentVersionConfig(pool, f.org, f.agent, f.version))!;
  const prompts: string[] = [];

  const knobs = turnKnobsFromEnv(
    loadEnv({
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    }),
  );
  delete knobs.stageClassifier;
  delete knobs.jailbreak;
  delete knobs.promiseSemantic;
  delete knobs.compaction;

  const d = {
    crmCfg: { supabase: createClient("http://127.0.0.1:1", "test-key") },
    llmCfg: { anthropicApiKey: "fake-local" },
    knobs,
    log: createLogger(),
    clock: () => new Date("2026-09-07T15:00:00Z"),
    embed: async () => ({
      embedding: Array(1536).fill(0.1),
      promptTokens: 0,
      model: "text-embedding-3-small",
    }),
    registry: createFakeRegistry(async (options) => {
      const text = JSON.stringify(options.prompt);
      prompts.push(text);
      let content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
      >;
      if (!options.tools?.length) {
        // Sem tools = chamada interna sem loop: memória (prévia) ou
        // fechamento pós-loop (`fecharOTurno`) — nunca o loop principal.
        const value = text.includes("Turno interno de memória")
          ? { notes: [] }
          : {
              rolling_summary: "Fechamento do sandbox",
              commitments: [],
              objections: [],
              next_action: null,
            };
        content = [{ type: "text", text: JSON.stringify(value) }];
      } else {
        // O modelo INSISTE: toda etapa é um send_message novo, sem texto de
        // fim — só a parada do Step 3 impede N candidatos.
        content = [
          {
            type: "tool-call",
            toolCallId: randomUUID(),
            toolName: "send_message",
            input: JSON.stringify({ body: "O atendimento começa às nove horas (sandbox-step3)." }),
          },
        ];
      }
      return {
        content,
        finishReason: {
          unified: content[0]?.type === "tool-call" ? "tool-calls" : "stop",
          raw: undefined,
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    }),
  };

  const result = newPreviewResult();
  const preview: TurnPreview = {
    kind: "sandbox",
    organizationId: f.org,
    runId: randomUUID(),
    agent,
    contactId: null,
    channelId: f.channel,
    context: scenarioContext(
      Array.from({ length: 4 }, (_, i) => ({
        direction: "inbound" as const,
        body: `Qual o horário? ${i}`,
        sent_at: "2026-09-07T14:00:00Z",
      })),
    ),
    result,
  };
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("preview_network_forbidden"));
  try {
    await runAgentPreview(d, pool, preview);
    // Nenhuma mensagem real saiu: a prévia não tem transporte.
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }

  // EXATAMENTE UM candidato — apesar do modelo nunca parar de mandar.
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.body).toContain("sandbox-step3");

  // NENHUMA iteração de modelo DEPOIS do candidato aceito: todo prompt que
  // carrega o resultado do send_message é o do fechamento pós-loop (que tem
  // a instrução de checkpoint e não faz tools), nunca uma continuação do loop.
  // A instrução vai ESCAPEADA no prompt serializado (JSON), por isso o
  // `JSON.stringify(...).slice(1, -1)` e não o texto cru.
  const instrucaoEscapada = JSON.stringify(CHECKPOINT_INSTRUCTION).slice(1, -1);
  const depoisDoEnvio = prompts.filter(
    (p) =>
      p.includes('"toolName":"send_message"') &&
      p.includes('"tool-result"') &&
      !p.includes(instrucaoEscapada),
  );
  expect(depoisDoEnvio).toHaveLength(0);
});
