/**
 * TOMADA HUMANA DURANTE O TURNO DA IA — a corrida que o veto da porta de saída fecha.
 *
 * Invariante: mensagem da IA NÃO é despachada se a conversa entrou em takeover
 * / pausa (`conversations.bot_silenced_until` — o campo autoritativo gravado por
 * telefone, `pause-ai`, claim, resposta manual e handoff) DEPOIS que o turno
 * começou e ANTES de o envio sair do servidor.
 *
 * O gate de início de turno já barava silêncio vigente. O que este arquivo mede
 * é a VIRADA DE CHAVE no meio do envio: a leitura da entrada da mensagem ainda
 * vê a conversa ativa para a IA, e a releitura FRESCO — última checagem de
 * `checkBoundary`, chamada logo antes de `adapter.send` e de novo como
 * `beforeSend` dentro do adapter, uma linha antes da chamada HTTP — encontra o
 * `'infinity'` e derruba o envio com `human_takeover_stale`.
 *
 * O veto só existe para quem armar `enforceHumanTakeoverCheck` (os quatro
 * pontos de envio de TURNO: inbound-turn ×3, followup-turn ×1). Os casos "sem
 * flag" provam a fronteira: avisos, entregas aprovadas/transacionais, campanhas,
 * automação e chamadores MCP/REST seguem exatamente como antes.
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { StaleServiceBoundaryError, HumanTakeoverStaleError } from "@/lib/atendimento/fronteira";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONV_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;

function conversationRow(botSilencedUntil: string | null, id: string = CONV): Row {
  return {
    id,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: botSilencedUntil,
    provider_conversation_id: null,
    last_inbound_at: new Date().toISOString(),
    contacts: {
      phone_number: "+5531999998888",
      wa_identity: null,
      wa_lid: null,
      is_blocked: false,
      is_personal: false,
    },
    channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING" },
  };
}

const boundaryDe = (conversationId: string) => ({
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: conversationId,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
});

const RPC_PADRAO = { ...boundaryDe(CONV), status: "open", demanda_fechada_em: null };

/** O ctx de um envio de TURNO da IA: flag armado (é ele que liga o veto). */
function ctxTurno(opts: { conversationId?: string; comFlag?: boolean } = {}): HandlerCtx {
  const { conversationId = CONV, comFlag = true } = opts;
  return {
    organization_id: ORG,
    actor: { type: "ai_agent", id: "agent-engine", role: "manager" },
    requestId: `req-takeover-${conversationId}`,
    serviceBoundary: boundaryDe(conversationId),
    ...(comFlag ? { enforceHumanTakeoverCheck: true } : {}),
  };
}

const inputDe = (conversationId: string = CONV): SendMessageInput =>
  ({ conversation_id: conversationId, type: "text", body: "oi" }) as SendMessageInput;

/**
 * Receiver WAHA real em porta aleatória: o que importa é a contagem de
 * `/sendText` — o veto precisa provar que NENHUMA mensagem saiu, não que o
 * adapter não tentou (leituras de provider podem ocorrer antes do disparo).
 */
async function comReceiver<T>(fn: (hits: string[]) => Promise<T>): Promise<T> {
  const hits: string[] = [];
  const receiver = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: { id: "REAL1" } }));
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("receiver");
    vi.stubEnv("WAHA_API_BASE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("WAHA_API_KEY", "local-test");
    return await fn(hits);
  } finally {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}

const sendText = (hits: string[]) => hits.filter((url) => url.endsWith("/sendText"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("corrida de takeover humano: a IA não despacha se a conversa virou chave", () => {
  it("silêncio nasce ENTRE a leitura da entrada e a saída → vetado, zero /sendText, takeover intacto", async () => {
    await comReceiver(async (hits) => {
      const ativa = conversationRow(null);
      const assumida = conversationRow("infinity");
      const { supabase, capturas } = criarDubleDoHandler({
        // Entrada (select com o embed de contacts) ainda ativa; a releitura
        // FRESCO da porta de saída (`select("bot_silenced_until")`) encontra o
        // takeover — o estado mudou no meio do envio.
        conversation: (select) => (select === "bot_silenced_until" ? assumida : ativa),
        rpcData: RPC_PADRAO,
      });

      const erro = await sendMessageHandler(supabase, ctxTurno(), inputDe()).catch((e: unknown) => e);

      // O veto é fronteira vencida: classe herdada (mesmo trilho terminal do
      // worker, sem retry) com mensagem própria de diagnóstico.
      expect(erro).toBeInstanceOf(HumanTakeoverStaleError);
      expect(erro).toBeInstanceOf(StaleServiceBoundaryError);
      expect((erro as Error).message).toBe("human_takeover_stale");

      // A releitura fresca DE FATO aconteceu (uma consulta só com esta coluna).
      expect(capturas.selects.conversations).toContain("bot_silenced_until");

      // A entrada passou (linha chegou a nascer) mas o envio NUNCA foi aceito:
      // nada saiu e nenhuma linha virou `sent` — sem sucesso falso.
      expect(capturas.inserts.messages, "a entrada deveria ter passado antes do veto do sink")
        .toHaveLength(1);
      expect(sendText(hits), "mensagem da IA chegou ao canal apesar do takeover").toHaveLength(0);
      expect((capturas.patches.messages ?? []).filter((p) => p.status === "sent")).toHaveLength(0);

      // O takeover não foi reescrito nem encurtado por este veto.
      expect(
        (capturas.patches.conversations ?? []).filter((p) => p.bot_silenced_until !== undefined),
        "o veto tocou em bot_silenced_until",
      ).toHaveLength(0);
      expect(assumida.bot_silenced_until).toBe("infinity");
    });
  });

  it("porta final: o veto pega no beforeSend do adapter, uma linha antes do HTTP (2ª releitura de saída)", async () => {
    await comReceiver(async (hits) => {
      const ativa = conversationRow(null);
      const assumida = conversationRow("infinity");
      let leiturasDeSaida = 0;
      const { supabase, capturas } = criarDubleDoHandler({
        // 1ª releitura (chamada explícita antes de adapter.send) passa; a 2ª —
        // o `beforeSend` invocado DENTRO do adapter antes do POST — vê o
        // takeover. É a janela residual que só a última linha alcança.
        conversation: (select) => {
          if (select === "bot_silenced_until") {
            leiturasDeSaida += 1;
            if (leiturasDeSaida >= 2) return assumida;
          }
          return ativa;
        },
        rpcData: RPC_PADRAO,
      });

      const erro = await sendMessageHandler(supabase, ctxTurno(), inputDe()).catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(HumanTakeoverStaleError);
      expect(leiturasDeSaida, "o beforeSend não fez a releitura fresca").toBe(2);
      expect(capturas.inserts.messages).toHaveLength(1);
      expect(sendText(hits), "o disparo passou pelo veto do beforeSend").toHaveLength(0);
    });
  });

  it("controle positivo: flag ligado, sem silêncio → envia e a linha vira sent", async () => {
    await comReceiver(async (hits) => {
      const { supabase, capturas } = criarDubleDoHandler({
        conversation: conversationRow(null),
        rpcData: RPC_PADRAO,
      });

      const msg = await sendMessageHandler(supabase, ctxTurno(), inputDe());

      expect((msg as { status: string }).status).toBe("sent");
      expect(sendText(hits)).toHaveLength(1);
      // Mesmo no caso que passa, a releitura fresca rodou — a régua é a mesma.
      expect(capturas.selects.conversations).toContain("bot_silenced_until");
    });
  });

  it("takeover já ativo na ENTRADA → veta antes de nascer linha da mensagem", async () => {
    await comReceiver(async (hits) => {
      const { supabase, capturas } = criarDubleDoHandler({
        conversation: conversationRow("infinity"),
        rpcData: RPC_PADRAO,
      });

      const erro = await sendMessageHandler(supabase, ctxTurno(), inputDe()).catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(HumanTakeoverStaleError);
      expect(capturas.inserts.messages, "resquício queued numa conversa assumida").toHaveLength(0);
      // Sem releitura de saída: a entrada já matou o envio.
      expect(capturas.selects.conversations).not.toContain("bot_silenced_until");
      expect(sendText(hits)).toHaveLength(0);
    });
  });

  it("pausa humana finita VIGENTE (5min) → vetada; já VENCIDA → envia (sem redesenhar a régua)", async () => {
    await comReceiver(async (hits) => {
      const vigente = new Date(Date.now() + 60_000).toISOString();
      const dubleVigente = criarDubleDoHandler({
        conversation: conversationRow(vigente),
        rpcData: RPC_PADRAO,
      });
      const erro = await sendMessageHandler(dubleVigente.supabase, ctxTurno(), inputDe())
        .catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(HumanTakeoverStaleError);
      expect(sendText(hits)).toHaveLength(0);

      const vencido = new Date(Date.now() - 60_000).toISOString();
      const dubleVencido = criarDubleDoHandler({
        conversation: conversationRow(vencido),
        rpcData: RPC_PADRAO,
      });
      const msg = await sendMessageHandler(dubleVencido.supabase, ctxTurno(), inputDe());
      expect((msg as { status: string }).status).toBe("sent");
      expect(sendText(hits)).toHaveLength(1);
    });
  });

  it("sem flag (MCP, avisos, entregas deliberadas) → segue enviando conversa silenciada, como antes", async () => {
    await comReceiver(async (hits) => {
      const { supabase } = criarDubleDoHandler({
        conversation: conversationRow("infinity"),
        rpcData: RPC_PADRAO,
      });

      const msg = await sendMessageHandler(supabase, ctxTurno({ comFlag: false }), inputDe());

      expect((msg as { status: string }).status).toBe("sent");
      expect(sendText(hits)).toHaveLength(1);
    });
  });

  it("conversa A assumida veta; conversa B ativa segue enviando — o veto é por conversa", async () => {
    await comReceiver(async (hits) => {
      const dubleA = criarDubleDoHandler({
        conversation: conversationRow("infinity"),
        rpcData: RPC_PADRAO,
      });
      const erroA = await sendMessageHandler(dubleA.supabase, ctxTurno({ conversationId: CONV }), inputDe(CONV))
        .catch((e: unknown) => e);
      expect(erroA).toBeInstanceOf(HumanTakeoverStaleError);
      expect(sendText(hits)).toHaveLength(0);

      const dubleB = criarDubleDoHandler({
        conversation: conversationRow(null, CONV_B),
        rpcData: { ...RPC_PADRAO, conversation_id: CONV_B },
      });
      const msgB = await sendMessageHandler(
        dubleB.supabase,
        ctxTurno({ conversationId: CONV_B }),
        inputDe(CONV_B),
      );
      expect((msgB as { status: string }).status).toBe("sent");
      expect(sendText(hits)).toHaveLength(1);
    });
  });
});

describe("o flag nasce só nos pontos de envio do turno", () => {
  const RAIZ = process.cwd();
  const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");

  it("inbound-turn arma os 3 pontos (resposta, template, roteiro); followup-turn arma o 1", () => {
    expect(
      fonte("lib", "agent-engine", "agent", "inbound-turn.ts").match(/enforceHumanTakeoverCheck: true/g),
      "ponto de envio de turno sem o veto de takeover",
    ).toHaveLength(3);
    expect(
      fonte("lib", "agent-engine", "agent", "followup-turn.ts").match(/enforceHumanTakeoverCheck: true/g),
      "followup sem o veto de takeover",
    ).toHaveLength(1);
  });

  it("avisos de passagem, entregas deliberadas, campanhas, automação e MCP NÃO armam", () => {
    for (const arquivo of [
      ["lib", "agent-engine", "agent", "aviso-de-escalacao.ts"],
      ["lib", "agent-engine", "agent", "approved-reply.ts"],
      ["lib", "agent-engine", "agent", "meet-delivery.ts"],
      ["lib", "ai", "handoff", "aviso-ao-lead.ts"],
      ["lib", "campanhas", "rodada.ts"],
      ["lib", "automation", "actions", "send-ai-message.ts"],
      ["lib", "mcp", "tools", "messages.ts"],
      ["lib", "followup", "enviar-texto-fixo.ts"],
    ]) {
      expect(fonte(...arquivo), `${arquivo.join("/")} armando o veto`).not.toContain(
        "enforceHumanTakeoverCheck",
      );
    }
  });
});
