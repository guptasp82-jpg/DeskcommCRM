/**
 * EVIDÊNCIA DE SEGURANÇA — regressões das superfícies sensiveis tocadas no
 * commit f9e2ac969 (gate ECC Tools / Security Evidence, PR #2828).
 *
 * O gate aponta `followup-turn.ts` e `inbound-turn.ts` como superfícies de
 * agente sem evidência de validação focada de segurança. As invariantes de
 * `inbound-turn.ts` têm suíte própria (send-message-duplicata-proxima,
 * saida-truncada-nao-vai-parcial, saida-vazia-persistente-vira-caso-humano);
 * o gate near-dup de `sendFixedOutbound` em `followup-turn.ts` — o caminho que
 * o piloto mediu disparando re-resposta redundante por follow-up de promessa —
 * NÃO tinha teste algum. Este arquivo fecha essa lacuna e consolida, nos dous
 * arquivos, as propriedades de SEGURANÇA transversais:
 *
 *  1. Supressão de duplicata NUNCA é marcada como entregue — nos dois caminhos
 *     (inbound: erro de ensino `ok:false` antes da cadeia; follow-up: desfecho
 *     distinto `duplicate_suppressed` completado como `skipped`, sem ledger).
 *  2. O gate do follow-up roda ANTES de qualquer preparo de despacho, só para
 *     corpo livre (template aprovado é isento — contrato próprio), e degrada
 *     de forma explícita e não-fatal se a memória estiver indisponível.
 *  3. Desfechos terminais (saída truncada / vazia persistente) não podem
 *     despachar mensagem: o bloco que abre caso humano não contém caminho de
 *     envio nenhum.
 *  4. A janela de supressão é limitada: só outbound desde a última inbound,
 *     com teto — nunca suprime a resposta futura a um cliente que falou de novo.
 *  5. Corpo vazio é estruturalmente indespachável (schema min(1)).
 *
 * Técnica: contrato de fonte (mesma das suítes irmãs) — os executes são
 * closures sem ponto de injeção barato; o que se prende é a estrutura real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const inbound = ler("lib/agent-engine/agent/inbound-turn.ts");
const followup = ler("lib/agent-engine/agent/followup-turn.ts");
const memoria = ler("lib/agent-engine/agent/memoria-envio.ts");

// ─── follow-up fixo: o gate que faltava cobertura ───────────────────────────
const gateInicio = followup.indexOf("if (!modelo) {");
const idxComparacao = followup.indexOf("encontraDuplicado(body, jaDito)");
const idxDespacho = followup.indexOf("const context = await getLeadContext(", idxComparacao);

describe("follow-up fixo: gate near-dup antes de qualquer preparo de despacho", () => {
  it("o módulo importa a régua pura e a memória de janela", () => {
    expect(followup).toContain("import { encontraDuplicado } from './near-dup';");
    expect(followup).toContain("import { corposEnviadosDesdeUltimaInbound } from './memoria-envio';");
  });

  it("a comparação e a supressão estão ANTES do despacho (getLeadContext)", () => {
    expect(gateInicio).toBeGreaterThan(-1);
    expect(idxComparacao).toBeGreaterThan(gateInicio);
    expect(idxDespacho).toBeGreaterThan(idxComparacao);
  });

  it("só corpo livre: template aprovado é isento (fora do `if (!modelo)`)", () => {
    const bloco = followup.slice(gateInicio, idxDespacho);
    expect(bloco).toContain("encontraDuplicado(body, jaDito)");
    expect(bloco).toContain('return { kind: "duplicate_suppressed" };');
    // Dentro do gate não há preparo nem ato de despacho: a supressão devolve
    // antes de qualquer envio, ledger ou mensagem.
    expect(bloco).not.toContain("getLeadContext");
    expect(bloco).not.toContain("runBeforeSend");
    expect(bloco).not.toContain("sendTurnMessage");
    expect(bloco).not.toContain(".insert(");
  });

  it("memória indisponível degrada explícito e NÃO-FATAL (sem throw)", () => {
    const inicioCatch = followup.indexOf("catch (err)", gateInicio);
    expect(inicioCatch).toBeGreaterThan(-1);
    expect(inicioCatch).toBeLessThan(idxDespacho);
    const cat = followup.slice(inicioCatch, idxDespacho);
    expect(cat).toMatch(/runLog\.warn\('mem.ria de duplicata do follow-up indispon.vel/);
    expect(cat).not.toContain("throw");
  });

  it("o desfecho `duplicate_suppressed` é distinto de `sent` e nunca conta como entregue", () => {
    // Tipo: quarto desfecho possível de EnvioFixoDesfecho, com o contrato
    // explícito de que não vira entrega.
    expect(followup).toMatch(/kind: "duplicate_suppressed";/);
    expect(followup).toMatch(/NUNCA conta como entregue/);
    // Consumidor: o enrollment completo como `skipped` com motivo distinto —
    // nunca `sent`, nenhuma ledger row de envio.
    const i = followup.indexOf("desfecho.kind === 'duplicate_suppressed'");
    expect(i).toBeGreaterThan(-1);
    const ramo = followup.slice(i, i + 700);
    expect(ramo).toMatch(/result:\{kind:'skipped'/);
    expect(ramo).toMatch(/reason:'duplicate_suppressed/);
    expect(ramo).not.toMatch(/kind:'sent'/);
  });
});

// ─── invariantes transversais nos dois arquivos sensiveis ───────────────────
describe("nunca entregue e nunca despachado fora do contrato, nos dois caminhos", () => {
  it("inbound: a supressão vem ANTES da cadeia de despacho e antes de qualquer outcome", () => {
    const gi = inbound.indexOf("encontraDuplicado(body, corposAceitosDoTurno)");
    expect(gi).toBeGreaterThan(-1);
    const ri = inbound.indexOf("runBeforeSend(", gi);
    expect(ri).toBeGreaterThan(gi);
    // Entre a supressão e a cadeia não há registro de outcome: um veto não é
    // resposta e não pode virar entrega (nem ledger, nem contagem de envio).
    expect(inbound.slice(gi, ri)).not.toContain("outcomes.push");
  });

  it("desfechos terminais (truncada / vazia persistente) não contêm caminho de envio", () => {
    // O MESMO bloco abre o caso humano das duas causas; ele só registra e abre
    // caso — se algum dia receber um runModelCall/sendTurnMessage aqui, um
    // silêncio de segurança viraria mensagem ao paciente sem cadeia de guards.
    const i = inbound.indexOf("const silencioSemRazaoLegitima");
    const j = inbound.indexOf("ROTEIRO: a pergunta pendente");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const bloco = inbound.slice(i, j);
    expect(bloco).not.toContain("await runModelCall(");
    expect(bloco).not.toContain("runBeforeSend");
    expect(bloco).not.toContain("sendTurnMessage");
    expect(bloco).toContain("openCase(");
  });

  it("corpo vazio é estruturalmente indespachável (schema min(1))", () => {
    expect(inbound).toMatch(/body: z\.string\(\)\.min\(1\)\.describe\(/);
  });

  it("a janela de supressão é limitada: outbound desde a última inbound, com teto", () => {
    // Corte na inbound mais nova: cliente que falou de novo sai da janela e a
    // resposta legítima dele nunca é suprimida; só outbound conta, com teto.
    expect(memoria).toContain("export async function corposEnviadosDesdeUltimaInbound(");
    expect(memoria).toContain("direction = 'inbound'");
    expect(memoria).toContain("direction = 'outbound'");
    expect(memoria).toContain("limit $4");
    expect(memoria).toMatch(/LIMITE_PADRAO = 15/);
  });
});
