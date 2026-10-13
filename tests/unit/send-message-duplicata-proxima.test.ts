/**
 * `send_message` recusa restatemente quase idêntico do que JÁ saiu no turno
 * (Workstream A — piloto Apex PathLabs, 2026-10-12).
 *
 * Defeito medido: uma única pergunta do paciente levou 4 respostas — 3 do
 * caminho de recuperação do "turno mudo" (o modelo chamou `send_message` 3× com
 * corpos quase idênticos) e 1 de um follow-up de promessa. O contrato é UMA
 * resposta adequada e completa por turno; restatemente imediato é redundância.
 *
 * Mesma técnica de `send-message-corpo-vazio.test.ts`: o `execute` é uma closure
 * dentro do turno, sem ponto de injeção barato, então o teste prende o `if` no
 * caminho que fala no canal — presença, ordem, e o fato de a recusa devolver erro
 * de ENSINO (`ok:false`) e NUNCA marcar nada como entregue (sem ledger row).
 *
 * A régua pura de similaridade (normalização + Dice) vive em `near-dup.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("send_message nunca reenvia restatemente do mesmo turno", () => {
  it("o execute recusa duplicata próxima com erro de ENSINO (ok:false, nunca entregue)", () => {
    // A recusa é um `ok:false` com code distinto — mesma forma de corpo_vazio/
    // resposta_obsoleta. Não há `outcomes.push`, ledger nem chamada de canal
    // dentro do ramo: nada é marcado como entregue.
    expect(corpoDoSend).toMatch(
      /const corpoRepetido = encontraDuplicado\(body, corposAceitosDoTurno\);\s*if \(corpoRepetido !== null\) \{\s*runLog\.info\('duplicate_suppressed/,
    );
    expect(corpoDoSend).toContain("code: 'duplicate_suppressed'");
    expect(corpoDoSend).toMatch(/code: 'duplicate_suppressed',\s*message:/);
  });

  it("a recusa vem antes do teto de envios — duplicata não gasta a cota do turno", () => {
    const dup = corpoDoSend.indexOf("'duplicate_suppressed'");
    const teto = corpoDoSend.indexOf("'max_sends_per_turn'");
    expect(dup).toBeGreaterThan(-1);
    expect(teto).toBeGreaterThan(-1);
    expect(dup).toBeLessThan(teto);
  });

  it("corpo vazio é checado primeiro — ordem vazio → duplicata → cota", () => {
    const vazio = corpoDoSend.indexOf("'corpo_vazio'");
    const dup = corpoDoSend.indexOf("'duplicate_suppressed'");
    expect(vazio).toBeGreaterThan(-1);
    expect(dup).toBeGreaterThan(vazio);
  });
});

describe("a memória de duplicata só cresce com envio REAL e é semeada por histórico", () => {
  it("candidato aceito (sent/already_sent/queued) entra na memória", () => {
    // O push está DEPOIS de `outcomes.push(outcome)` e sob os kinds que saíram.
    expect(FONTE).toMatch(
      /if \(outcome\.kind === 'sent' \|\| outcome\.kind === 'already_sent' \|\| outcome\.kind === 'queued'\) \{\s*corposAceitosDoTurno\.push\(body\);/,
    );
  });

  it("o turno semeia a memória com o que já saiu desde a última inbound (cobre follow-up)", () => {
    // Janela "desde a última inbound": vazia num turno fresco (não suprime
    // resposta legítima), cheia num follow-up que re-responde conversa calada.
    expect(FONTE).toContain("corposEnviadosDesdeUltimaInbound(");
    expect(FONTE).toMatch(/corposAceitosDoTurno\.push\(\.\.\.jaDito\)/);
  });
});
