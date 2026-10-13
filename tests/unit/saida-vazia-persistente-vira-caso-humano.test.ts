/**
 * SAÍDA VAZIA PERSISTENTE vira falha terminal visível (piloto Apex PathLabs).
 *
 * O defeito que este gate cobre: o turno termina sem nenhuma mensagem ao
 * cliente (`messages_sent: 0`, sem veto, sem descarte), a correção limitada do
 * turno mudo (UMA) roda e AINDA ASSIM nada sai. Antes disso virava silêncio
 * mudo com um log — o cliente ficava sem resposta e ninguém era notificado.
 *
 * Cenários, na ordem em que o código os garante:
 *
 *  1. Recuperação limitada preservada: a correção continua sendo pedida sob as
 *     condições do próprio pedido (`turno-mudo.ts`) e continua sendo UMA.
 *  2. Decisão DEPOIS da correção: o desfecho terminal é avaliado com os flags
 *     e `outcomes` re-avalizados depois dela — correção que recuperou (mensagens
 *     saíram) nunca vira caso humano.
 *  3. Proteção por mensagem existente: `outcomes.length === 0` e
 *     `tentativasDeEnvio === 0` — turno que já despachou (ou tentou e levou
 *     veto, que já ensinou) não escala.
 *  4. Isenção de silêncio legítimo: descartado, handoff da equipe, teto de
 *     pacing e preview ficam de fora — mesma régua do truncamento.
 *  5. Desfecho distinto por causa: `empty_output_recovered_failed` +
 *     caso humano `saida_vazia_persistente` (truncamento preservado com
 *     `output_truncated_recovered_failed`/`saida_truncada` no MESMO bloco —
 *     um caso por turno, nunca duplicado).
 *  6. Nunca duplica: o bloco terminal não despacha nada (só registra e abre
 *     caso) e `caso.ok` gateia o move do funil.
 *
 * Por que contrato de fonte (mesma técnica de saida-truncada-nao-vai-parcial.test.ts):
 * o detect fica no meio do closure do turno, sem ponto de injeção barato; o que
 * dá pra prender com segurança é a estrutura — presença, ordem e condições.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const turno = ler("lib/agent-engine/agent/inbound-turn.ts");

// Posições de âncora (fonte única de verdade para as ordens abaixo).
const idxCorrecaoConst = turno.indexOf("const correcaoDoTurnoMudoPedida =");
const idxCorrecaoIf = turno.indexOf("if (correcaoDoTurnoMudoPedida) {");
const idxCorrecaoExec = turno.indexOf(
  "mensagensDoTurno = [...mensagensDoTurno, pedidoDeCorrecao, ...correcao.result.responseMessages];",
);
const idxSilencio = turno.indexOf("const silencioSemRazaoLegitima =");
const idxRoteiro = turno.indexOf("ROTEIRO: a pergunta pendente");

// O bloco que decide o desfecho terminal, do começo da decisão ao fim do bloco.
const blocoTerminal = () => {
  expect(idxSilencio).toBeGreaterThan(-1);
  expect(idxRoteiro).toBeGreaterThan(idxSilencio);
  return turno.slice(idxSilencio, idxRoteiro);
};
// O bloco da correção limitada, do `if` à decisão terminal.
const blocoCorrecao = () => {
  expect(idxCorrecaoIf).toBeGreaterThan(-1);
  expect(idxSilencio).toBeGreaterThan(idxCorrecaoIf);
  return turno.slice(idxCorrecaoIf, idxSilencio);
};

describe("recuperação limitada do turno mudo (preservada)", () => {
  it("a correção é pedida sob as condições do pedido e o valor é capturado ANTES de rodar", () => {
    expect(idxCorrecaoConst).toBeGreaterThan(-1);
    expect(idxCorrecaoConst).toBeLessThan(idxCorrecaoIf);
    // Reusa a régua do próprio pedido — razões legítimas de silêncio nem
    // chegam a corrigir (turno-mudo.ts é a definição única).
    const cabeca = turno.slice(idxCorrecaoConst, idxCorrecaoIf);
    expect(cabeca).toContain("turnoMudoPedeCorrecao({");
    expect(cabeca).toContain("enviadas: outcomes.length,");
    expect(cabeca).toContain("liveJob().kind === 'inbound_turn'");
  });

  it("a correção continua UMA só — um único runModelCall, steps limitados", () => {
    const bloco = blocoCorrecao();
    expect(bloco.split("await runModelCall(").length - 1).toBe(1);
    expect(bloco).toContain("Math.min(maxSteps, 3)");
    // O pedido de correção é a instrução canônica do motor.
    expect(bloco).toContain("CORRECAO_DO_TURNO_MUDO");
    // Nenhum desfecho terminal dentro da correção — decisão é separada.
    expect(bloco).not.toContain("empty_output_recovered_failed");
    expect(bloco).not.toContain("openCase(");
  });
});

describe("decisão terminal: DEPOIS da correção, com os flags re-avaliados", () => {
  it("a ordem é: pedir correção → executar → decidir o desfecho", () => {
    expect(idxCorrecaoConst).toBeLessThan(idxCorrecaoIf);
    expect(idxCorrecaoIf).toBeLessThan(idxCorrecaoExec);
    // A decisão lê `outcomes`/flags DEPOIS da correção rodar: recuperação
    // bem-sucedida (mensagens saíram) é vista como `outcomes.length > 0`.
    expect(idxCorrecaoExec).toBeLessThan(idxSilencio);
  });

  it("silêncio sem razão legítima: nada despachado, nada tentado, primeira passada", () => {
    const bloco = blocoTerminal();
    // Proteção por mensagem existente: quem já despachou (ou tentou e levou
    // veto — o veto é a razão e já ensinou) não escala a caso humano.
    expect(bloco).toContain("outcomes.length === 0");
    expect(bloco).toContain("tentativasDeEnvio === 0");
    expect(bloco).toContain("seq === 0");
    expect(bloco).toContain("!preview");
  });

  it("isenta silêncio legítimo: descartado, handoff da equipe e teto de pacing", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("!turnoDescartado");
    expect(bloco).toContain("!passouParaAEquipe");
    expect(bloco).toContain("!capDeEnvioAtingido()");
  });

  it("só escala com causa: truncamento NÃO recuperado OU correção pedida e sem sucesso", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain(
      "if (silencioSemRazaoLegitima && (saidaTruncada || correcaoDoTurnoMudoPedida)) {",
    );
  });
});

describe("desfecho distinto, caso humano único, nunca duplica", () => {
  it("causa vira código próprio: vazia persistente ≠ truncada (truncamento preservado)", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("const desfechoTerminal = saidaTruncada");
    expect(bloco).toContain("? 'output_truncated_recovered_failed'");
    expect(bloco).toContain(": 'empty_output_recovered_failed';");
    expect(bloco).toContain(
      "const kindDoCaso = saidaTruncada ? 'saida_truncada' : 'saida_vazia_persistente';",
    );
    // O mesmo mecanismo suportado de caso humano, com a causa no snapshot.
    expect(bloco).toContain("openCase(");
    expect(bloco).toContain("source: 'guardrail_autofallback'");
    expect(bloco).toContain("blocker: kindDoCaso");
    expect(bloco).toContain("kind: kindDoCaso");
    expect(bloco).toContain("correcao_limitada_rodou: correcaoDoTurnoMudoPedida");
  });

  it("um caso por turno: `caso.ok` gateia o move do funil e a falha fica visível", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("if (caso.ok) {");
    expect(bloco).toContain("openedCaseThisTurn = true;");
    expect(bloco).toContain("moverParaHandoffBestEffort(kindDoCaso);");
    // Caso já aberto → log distinto, sem segundo move; openCase que lançou
    // também fica visível (não engole a causa original).
    expect(bloco).toContain("caso humano não abriu (já existe)");
    expect(bloco).toContain("openCase lançou");
  });

  it("o bloco terminal não despacha nada — nunca duplica mensagem nem re-tenta envio", () => {
    const bloco = blocoTerminal();
    expect(bloco).not.toContain("await runModelCall(");
    expect(bloco).not.toContain("runBeforeSend");
    expect(bloco).not.toContain("sendTurnMessage");
  });
});
