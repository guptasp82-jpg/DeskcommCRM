/**
 * Regressão de segurança CO-LOCADA de `inbound-turn.ts` (piloto Apex, 2026-10).
 *
 * Estes testes exercitam o COMPORTAMENTO REAL das fronteiras exportadas que o
 * Workstream B tornou inegociáveis — diferente das suítes em `tests/unit/`
 * (send-message-corpo-vazio, saida-truncada, saida-vazia), que prendem a
 * ESTRUTURA do fonte; aqui o contrato roda de verdade, pelo import do módulo:
 *
 *  1. O schema da ferramenta `send_message` é a fronteira física que torna
 *     DESPACHO VAZIO impossível: `body` tem `.min(1)`, então nem o modelo nem
 *     uma cadeia de recuperação conseguem expressar mensagem vazia — a recusa
 *     nasce no schema, antes de qualquer gate do turno.
 *  2. O teto de envios por turno (`DEFAULT_MAX_SENDS_PER_TURN`) é a régua que
 *     limita a recuperação de saída truncada/vazia a um envio de correção —
 *     nunca disparo ilimitado.
 *
 * O gate near-dup (`duplicate_suppressed`) mora dentro do `execute` da closure,
 * sem ponto de injeção barato — o contrato dele é pinçado por
 * `tests/unit/send-message-duplicata-proxima.test.ts` e
 * `tests/unit/seguranca-supressao-duplicata-e-desfecho-terminal.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { AGENT_TOOL_DEFS, DEFAULT_MAX_SENDS_PER_TURN } from './inbound-turn';

const send_message = AGENT_TOOL_DEFS.send_message.inputSchema;

describe('send_message: corpo vazio é estruturalmente indespachável', () => {
  it('recusa body vazio (despacho parcial/impossível nasce no schema)', () => {
    const r = send_message.safeParse({ body: '' });
    expect(r.success).toBe(false);
  });

  it('recusa body ausente', () => {
    const r = send_message.safeParse({});
    expect(r.success).toBe(false);
  });

  it('aceita uma mensagem real (o schema não vira guarda que bloqueia o contrato)', () => {
    const r = send_message.safeParse({ body: 'Olá, Ana! Respondendo sobre seu exame.' });
    expect(r.success).toBe(true);
  });

  it('aceita corpo com foto de produto (variação legítima do mesmo contrato)', () => {
    const r = send_message.safeParse({ body: 'Segue as fotos.', produto_codigo: 'P-104' });
    expect(r.success).toBe(true);
  });
});

describe('teto de envios por turno', () => {
  it('a recuperação de saída tem teto FIXO em 3 — nunca disparo ilimitado', () => {
    expect(DEFAULT_MAX_SENDS_PER_TURN).toBe(3);
  });
});
