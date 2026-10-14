/**
 * O fluxo de consulta de laudo (Apex PathLabs) — testes FOCADOS das decisões
 * do workflow, com todas as bordas externas mockadas: Qmarksoft (fetch),
 * histórico de mensagens, envio (inclui mídia do QR) e entrega para humano.
 * Nenhum envio real, nenhum acesso real de rede/banco — o "banco" é um fake
 * das três consultas de estado em `conversations.metadata`.
 *
 * Cobertura (spec de readiness do piloto):
 *  1. detecção EN / hindi / hinglish (+ "miltajulta") e negativos de preço;
 *  2-4. patologia verificada: pronta / não pronta / valor + QR em 2 mensagens;
 *  5. Qmarksoft indisponível + registro prévio → checagem humana (Caso B);
 *  6. sem histórico → pergunta de categoria (Caso C) e escolha guardada;
 *  7/9. biopsy e radiologia sem API → coleta campo a campo até a entrega;
 * 10. valor de biopsy verificado + QR de biopsy (nunca o de patologia);
 * 11. QR pendente → sem placeholder, sem imagem errada;
 * 12/13. timeout/ambíguo/indisponível → nunca status nem valor inventado;
 * 14. retry da mesma mensagem → nada duplicado; turno interrompido → reexecuta;
 * 15. preço e outros intents que já funcionam continuam com o modelo.
 * + ativação: chave vazia = `null` sem UMA consulta no banco.
 * + segurança: nenhum texto dos 3 idiomas passa no detector de promessa humana;
 * + ordem no motor: o bloco entra depois do opt-out e antes do roteiro.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { detectHumanPromise } from '../../guardrails/human-promise';
import type { Queryable } from '../../queue/queue';
import type { FotoParaEnvio } from '../fotos-do-produto';
import {
  detectarIdioma,
  detectarServico,
  ehPerguntaDeLaudo,
  ehOutraIntencao,
  respostaDeServico,
  servicoDaMensagemDeRegistro,
} from './intent';
import { executarFluxoDeProntoAtendimento, organizacaoNoFluxo, type FluxoDeLaudoDeps } from './workflow';
import { textosDoFluxo, variante } from './templates';
import type { EstadoFluxo } from './state';

const ORG = 'b90aaaba-4dd9-40a8-95f2-c876689488fe';
const CONV = 'conv-teste';
const LEAD = 'lead-teste';
const ENV_QM = { QMARKSOFT_BASE_URL: 'https://qm.teste', QMARKSOFT_LOOKUP_URL: '/api/lookup' };

const PRONTO = textosDoFluxo('en').pronto;
const VERIFICAR_EQUIPE = textosDoFluxo('en').verificarPelaEquipe;
const FALHA_SISTEMA = textosDoFluxo('en').falhaDoSistema;
const IDENTIFICACAO_FALHOU = textosDoFluxo('en').identificacaoFalhou;
const PERGUNTA_NOME = textosDoFluxo('en').perguntarNome;

/** Fake das três consultas de estado (ler / claim / salvar) sobre `conversations.metadata`. */
function fakeDb(estadoInicial: EstadoFluxo | null = null) {
  let estado: EstadoFluxo | null = estadoInicial;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('as estado')) return { rows: [{ estado }], rowCount: 1 };
    if (sql.includes('and not (')) {
      // claim: falha só quando a mensagem já está COMPLETA (mesma msg, sem processo)
      const proposto = JSON.parse(params[2] as string) as EstadoFluxo;
      const completo = estado !== null && estado.msg === proposto.msg && estado.processando === false;
      if (completo) return { rows: [], rowCount: 0 };
      estado = proposto;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('- $3::text')) {
      estado = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('jsonb_build_object($3')) {
      estado = JSON.parse(params[3] as string) as EstadoFluxo;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`sql não previsto no fake do teste: ${sql.slice(0, 90)}`);
  });
  return {
    db: { query } as unknown as Queryable,
    query,
    ler: () => estado,
    seed: (e: EstadoFluxo | null) => {
      estado = e;
    },
  };
}

function resposta(status: number, corpo: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => corpo,
  } as unknown as Response;
}

interface Opcoes {
  env?: Record<string, string | undefined>;
  estadoInicial?: EstadoFluxo | null;
  texto?: string;
  historico?: string[];
  fetch?: ReturnType<typeof vi.fn>;
  prepararQr?: (tipo: string) => Promise<FotoParaEnvio | null>;
  maxSends?: number;
}

function criar(op: Opcoes = {}) {
  const banco = fakeDb(op.estadoInicial ?? null);
  const envios: Array<{ corpo: string; media?: FotoParaEnvio }> = [];
  const handovers: Array<{ titulo: string; resumo: string }> = [];
  const qrTipos: string[] = [];
  const deps: FluxoDeLaudoDeps = {
    db: banco.db,
    log: { info: vi.fn(), warn: vi.fn() },
    tenantId: ORG,
    leadId: LEAD,
    conversationId: CONV,
    msgId: 'm1',
    texto: op.texto ?? 'Is my report ready?',
    telefone: '+917897291703',
    env: { APEX_REPORT_WORKFLOW_ORGS: ORG, ...(op.env ?? {}) },
    maxSends: op.maxSends ?? 3,
    buscarHistorico: async () => op.historico ?? [],
    enviar: async (corpo: string, media?: FotoParaEnvio) => {
      envios.push(media !== undefined ? { corpo, media } : { corpo });
      return true;
    },
    prepararQr: async (tipo) => {
      qrTipos.push(tipo);
      if (op.prepararQr !== undefined) return op.prepararQr(tipo);
      return { storagePath: `${ORG}/${CONV}/qr-${tipo}.png`, mime: 'image/png' };
    },
    handover: async (o) => {
      handovers.push(o);
    },
    ...(op.fetch !== undefined ? { fetchDeRede: op.fetch as unknown as typeof fetch } : {}),
  };
  return { deps, envios, handovers, qrTipos, banco };
}

const fetchCorpoOk = (corpo: unknown) => vi.fn(async () => resposta(200, corpo));
const fetchStatus = (status: number, corpo: unknown = {}) =>
  vi.fn(async () => resposta(status, corpo));
const fetchTimeout = vi.fn(async () => {
  const e = new Error('aborted');
  e.name = 'AbortError';
  throw e;
});

describe('detecção de laudo pronto (spec 8.1) e escapes (spec 8.15)', () => {
  it('reconhece em inglês, hindi e hinglish, incluindo "miltajulta"', () => {
    expect(ehPerguntaDeLaudo('Is my report ready?')).toBe(true);
    expect(ehPerguntaDeLaudo('Mera report mil gaya?')).toBe(true);
    expect(ehPerguntaDeLaudo('Report kab milegi?')).toBe(true);
    expect(ehPerguntaDeLaudo('मेरी रिपोर्ट कब तक मिलेगी?')).toBe(true);
    expect(ehPerguntaDeLaudo('Where is my report?')).toBe(true);
    expect(ehPerguntaDeLaudo('Miltajulta')).toBe(true);
    expect(detectarIdioma('Report kab milegi?')).toBe('hinglish');
    expect(detectarIdioma('मेरी रिपोर्ट तैयार है?')).toBe('hi');
    expect(detectarIdioma('Is my report ready?')).toBe('en');
  });

  it('perguntas de preço/horário NÃO engajam o fluxo (intent existente intacto)', () => {
    expect(ehPerguntaDeLaudo('What is the price of CBC?')).toBe(false);
    expect(ehPerguntaDeLaudo('What time do you open?')).toBe(false);
    expect(ehPerguntaDeLaudo('share your report')).toBe(false);
    expect(ehOutraIntencao('How much is TSH test?')).toBe(true);
    expect(ehOutraIntencao('TSH ka kitna rate?')).toBe(true);
  });

  it('detecção de serviço e resposta de categoria', () => {
    expect(detectarServico('My ultrasound report kab milegi?')).toBe('radiology');
    expect(detectarServico('biopsy report ready?')).toBe('biopsy');
    expect(detectarServico('CBC report ready?')).toBe('pathology');
    expect(detectarServico('Is my report ready?')).toBeNull();
    expect(respostaDeServico('2')).toBe('biopsy');
    expect(respostaDeServico('3.')).toBe('radiology');
    expect(respostaDeServico('Pathology test')).toBe('pathology');
    expect(servicoDaMensagemDeRegistro(['nothing here'])).toBeNull();
    expect(servicoDaMensagemDeRegistro(['Your appointment is confirmed — token 45'])).toBe('pathology');
  });
});

describe('Caso A — Qmarksoft responde (spec 8.2–8.4)', () => {
  it('status verificado PRONTO confirma sem handover (8.2)', async () => {
    const f = fetchCorpoOk({ patient: { name: 'A' }, service: 'pathology', report: { ready: true } });
    const t = criar({ env: ENV_QM, fetch: f });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toEqual({ engajado: true, acoes: 1 });
    expect(t.envios.map((e) => e.corpo)).toEqual([PRONTO]);
    expect(t.handovers).toHaveLength(0);
    expect(t.banco.ler()).toMatchObject({ etapa: 'encerrado', msg: 'm1', processando: false });
  });

  it('status verificado NÃO PRONTO: sem prazo inventado, prazo só quando veio do sistema (8.3)', async () => {
    const semPrazo = criar({
      env: ENV_QM,
      fetch: fetchCorpoOk({ patient: { name: 'A' }, service: 'pathology', report: { ready: false } }),
    });
    await executarFluxoDeProntoAtendimento(semPrazo.deps);
    expect(semPrazo.envios[0]?.corpo).toBe(textosDoFluxo('en').naoPronto(null));
    expect(semPrazo.envios[0]?.corpo).not.toMatch(/expected time/i);

    const comPrazo = criar({
      env: ENV_QM,
      fetch: fetchCorpoOk({
        patient: { name: 'A' },
        service: 'pathology',
        report: { ready: false, eta: '2–3 dias úteis' },
      }),
    });
    await executarFluxoDeProntoAtendimento(comPrazo.deps);
    expect(comPrazo.envios[0]?.corpo).toContain('2–3 dias úteis');
  });

  it('valor pendente verificado → TEXTO com o valor + imagem QR em mensagem separada (8.4)', async () => {
    const t = criar({
      env: ENV_QM,
      fetch: fetchCorpoOk({
        patient: { name: 'A' },
        service: 'pathology',
        report: { ready: false },
        outstanding: { amount: 400, currency: 'INR' },
      }),
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.acoes).toBe(2);
    expect(t.envios).toHaveLength(2);
    expect(t.envios[0]?.media).toBeUndefined();
    expect(t.envios[0]?.corpo).toMatch(/₹\s?400/);
    expect(t.envios[0]?.corpo).not.toMatch(/917897291703/);
    expect(t.envios[1]?.media).toBeDefined();
    expect(t.envios[1]?.corpo).toBe(textosDoFluxo('en').legendaQr);
    expect(t.qrTipos).toEqual(['pathology']);
    expect(t.handovers).toHaveLength(0);
  });

  it('ambíguo na primeira → pergunta o nome mínimo; ainda ambíguo → entrega sem status (8.12)', async () => {
    const f = fetchStatus(409, { candidates: 2 });
    const t = criar({ env: ENV_QM, fetch: f });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios.map((e) => e.corpo)).toEqual([PERGUNTA_NOME]);
    expect(t.banco.ler()?.etapa).toBe('nome');

    t.deps.msgId = 'm2';
    t.deps.texto = 'Ravi Kumar';
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(f).toHaveBeenCalledTimes(2);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.resumo).toContain('amb');
    const corpos = t.envios.map((e) => e.corpo);
    expect(corpos.some((c) => c === PRONTO || /not ready yet/.test(c))).toBe(false);
    expect(corpos).toContain(IDENTIFICACAO_FALHOU);
  });

  it('timeout → checagem humana, nunca status de laudo (8.12)', async () => {
    const t = criar({ env: ENV_QM, fetch: fetchTimeout });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(t.handovers).toHaveLength(1);
    expect(t.envios.map((e) => e.corpo)).toEqual([FALHA_SISTEMA]);
    expect(t.envios[0]?.corpo).not.toMatch(/ready/i);
  });

  it('indisponível (500) → sem valor e sem QR, entrega (8.13)', async () => {
    const t = criar({
      env: ENV_QM,
      fetch: fetchStatus(500, { error: 'boom' }),
      prepararQr: async () => {
        throw new Error('não deveria nem tentar QR sem valor verificado');
      },
    });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.handovers).toHaveLength(1);
    expect(t.envios[0]?.corpo).toBe(FALHA_SISTEMA);
    expect(t.envios[0]?.corpo).not.toMatch(/₹|outstanding|बकाया/i);
  });
});

describe('Caso B/C — sem Qmarksoft (spec 8.5–8.6)', () => {
  it('pergunta de laudo com teste de patologia explícito, sem API → checagem + entrega (rota direta)', async () => {
    // Sem QMARKSOFT_* configurado o braço verificado não existe: patologia
    // NUNCA responde status sozinha — mensagem para o time + entrega.
    const t = criar({ texto: 'CBC report ready?' });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(t.envios.map((e) => e.corpo)).toEqual([VERIFICAR_EQUIPE]);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.resumo).toContain('checagem manual');
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });

  it('Caso C → paciente escolhe patologia (1) sem API → checagem + entrega', async () => {
    const t = criar({ historico: [], texto: 'When will I get my report?' });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios[0]?.corpo).toContain('1) Pathology');

    t.deps.msgId = 'm2';
    t.deps.texto = '1';
    const segunda = await executarFluxoDeProntoAtendimento(t.deps);
    expect(segunda?.engajado).toBe(true);
    expect(t.envios.map((e) => e.corpo)).toEqual([
      variante(LEAD, textosDoFluxo('en').perguntarCategoria),
      VERIFICAR_EQUIPE,
    ]);
    expect(t.handovers).toHaveLength(1);
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });

  it('registro prévio identifica paciente de patologia → checagem + entrega, sem pergunta de categoria (8.5)', async () => {
    const t = criar({
      historico: ['Your appointment is confirmed — token 45, CBC test'],
      texto: 'Is my report ready?',
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(t.envios.map((e) => e.corpo)).toEqual([VERIFICAR_EQUIPE]);
    expect(t.handovers).toHaveLength(1);
    expect(t.envios[0]?.corpo).not.toMatch(/1\) Pathology/);
  });

  it('sem histórico → pergunta de categoria e a escolha alimenta a coleta (8.6)', async () => {
    const t = criar({ historico: [], texto: 'When will I get my report?' });
    const primeira = await executarFluxoDeProntoAtendimento(t.deps);
    expect(primeira?.engajado).toBe(true);
    expect(t.envios[0]?.corpo).toContain('1) Pathology');
    expect(t.banco.ler()).toMatchObject({ etapa: 'categoria' });

    t.deps.msgId = 'm2';
    t.deps.texto = '2';
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios[1]?.corpo).toBe(textosDoFluxo('en').perguntarBiopsy.nome);
    expect(t.banco.ler()).toMatchObject({ etapa: 'coleta', servico: 'biopsy', pendente: 'nome' });
  });
});

describe('Biopsy e radiologia sem API (spec 8.7, 8.9)', () => {
  it('biopsy: nome → data da cirurgia → médico/hospital, sem repetir campo, e entrega com o resumo (8.7)', async () => {
    // "kab milegi" → hinglish: as perguntas do fluxo saem em hinglish e o
    // idioma fica guardado no estado (turnos seguintes não trocam de idioma).
    const H = textosDoFluxo('hinglish');
    const t = criar({ texto: 'My biopsy report kab milegi?' });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios.map((e) => e.corpo)).toEqual([H.perguntarBiopsy.nome]);

    const passos: Array<['m2' | 'm3' | 'm4', string]> = [
      ['m2', 'Ravi Kumar'],
      ['m3', '12/03/2024'],
      ['m4', 'Dr. Sen'],
    ];
    for (const [msgId, texto] of passos) {
      t.deps.msgId = msgId;
      t.deps.texto = texto;
      await executarFluxoDeProntoAtendimento(t.deps);
    }
    expect(t.envios.map((e) => e.corpo)).toEqual([
      H.perguntarBiopsy.nome,
      H.perguntarBiopsy.data_cirurgia,
      H.perguntarBiopsy.medico,
      H.detalhesAnotados,
    ]);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.resumo).toContain('Ravi Kumar');
    expect(t.handovers[0]?.resumo).toContain('12/03/2024');
    expect(t.handovers[0]?.resumo).toContain('Dr. Sen');
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });

  it('radiologia em hinglish: nome → data → exame, e entrega (8.9)', async () => {
    const t = criar({ texto: 'Report kab milegi?' });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(textosDoFluxo('hinglish').perguntarCategoria).toContain(t.envios[0]?.corpo);

    const passos: Array<[string, string]> = [
      ['m2', '3'],
      ['m3', 'Ravi'],
      ['m4', '15/04/2024'],
      ['m5', 'Ultrasound abdomen'],
    ];
    for (const [msgId, texto] of passos) {
      t.deps.msgId = msgId;
      t.deps.texto = texto;
      await executarFluxoDeProntoAtendimento(t.deps);
    }
    expect(t.envios.map((e) => e.corpo)).toEqual([
      variante(LEAD, textosDoFluxo('hinglish').perguntarCategoria),
      textosDoFluxo('hinglish').perguntarRadiologia.nome,
      textosDoFluxo('hinglish').perguntarRadiologia.data_exame,
      textosDoFluxo('hinglish').perguntarRadiologia.exame,
      textosDoFluxo('hinglish').detalhesAnotados,
    ]);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.resumo).toContain('Ultrasound abdomen');
    expect(t.handovers[0]?.resumo).toContain('15/04/2024');
  });
});

describe('QR fixo (spec 8.10–8.11)', () => {
  it('valor de biopsy verificado usa o QR de BIOPSY (8.10)', async () => {
    const t = criar({
      env: ENV_QM,
      fetch: fetchCorpoOk({
        patient: { name: 'A' },
        service: 'biopsy',
        report: { ready: false },
        outstanding: { amount: 750, currency: 'INR' },
      }),
    });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.qrTipos).toEqual(['biopsy']);
    expect(t.envios).toHaveLength(2);
    expect(t.envios[1]?.media).toBeDefined();
    expect(t.handovers).toHaveLength(0);
  });

  it('QR pendente → sem placeholder e sem imagem errada; dependência vai na entrega (8.11)', async () => {
    const t = criar({
      env: ENV_QM,
      fetch: fetchCorpoOk({
        patient: { name: 'A' },
        service: 'pathology',
        report: { ready: false },
        outstanding: { amount: 400, currency: 'INR' },
      }),
      prepararQr: async () => null,
    });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios).toHaveLength(1);
    expect(t.envios.some((e) => e.media !== undefined)).toBe(false);
    expect(t.handovers).toHaveLength(1);
    expect(t.handovers[0]?.resumo).toContain('pendente');
    expect(t.handovers[0]?.resumo).toContain('₹400');
  });

  it('teto de 1 mensagem por turno (escudo MAX_SENDS_PER_TURN=1): texto sai, QR adia e sai no próximo turno', async () => {
    const t = criar({
      env: ENV_QM,
      maxSends: 1,
      fetch: fetchCorpoOk({
        patient: { name: 'A' },
        service: 'pathology',
        report: { ready: false },
        outstanding: { amount: 400, currency: 'INR' },
      }),
    });
    await executarFluxoDeProntoAtendimento(t.deps);
    expect(t.envios).toHaveLength(1);
    expect(t.banco.ler()).toMatchObject({ etapa: 'qr', qrPendente: 'pathology' });
    expect(t.handovers).toHaveLength(0);

    t.deps.msgId = 'm2';
    t.deps.texto = 'ok';
    const segunda = await executarFluxoDeProntoAtendimento(t.deps);
    expect(segunda?.engajado).toBe(true);
    expect(t.envios).toHaveLength(2);
    expect(t.envios[1]?.media).toBeDefined();
    expect(t.banco.ler()?.etapa).toBe('encerrado');
  });
});

describe('idempotência de retry (spec 8.14)', () => {
  it('mesma mensagem já concluída → nenhuma ação, nenhum envio, nenhuma entrega', async () => {
    const t = criar({
      env: ENV_QM,
      fetch: fetchCorpoOk({ patient: { name: 'A' }, service: 'pathology', report: { ready: true } }),
    });
    const primeira = await executarFluxoDeProntoAtendimento(t.deps);
    expect(primeira?.acoes).toBe(1);

    const segunda = await executarFluxoDeProntoAtendimento(t.deps);
    expect(segunda).toEqual({ engajado: true, acoes: 0 });
    expect(t.envios).toHaveLength(1);
    expect(t.handovers).toHaveLength(0);
  });

  it('turno interrompido (processando: true) reexecuta e completa', async () => {
    const t = criar({
      estadoInicial: {
        v: 1,
        msg: 'm1',
        processando: true,
        etapa: 'categoria',
        idioma: 'en',
      },
      texto: '2',
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r?.engajado).toBe(true);
    expect(r?.acoes).toBeGreaterThan(0);
    expect(t.envios[0]?.corpo).toBe(textosDoFluxo('en').perguntarBiopsy.nome);
    expect(t.banco.ler()).toMatchObject({ etapa: 'coleta', processando: false });
  });
});

describe('intents existentes intactos (spec 8.15)', () => {
  it('sem estado e mensagem de preço → modelo responde (não engaja)', async () => {
    const t = criar({ texto: 'What is the price of CBC?' });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toEqual({ engajado: false, acoes: 0 });
    expect(t.envios).toHaveLength(0);
    expect(t.handovers).toHaveLength(0);
  });

  it('no meio da coleta, mensagem de preço larga o fluxo e devolve ao modelo', async () => {
    const t = criar({
      estadoInicial: {
        v: 1,
        msg: 'm0',
        processando: false,
        etapa: 'coleta',
        idioma: 'en',
        servico: 'biopsy',
        pendente: 'nome',
      },
      texto: 'How much is TSH test?',
    });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toEqual({ engajado: false, acoes: 0 });
    expect(t.envios).toHaveLength(0);
    expect(t.banco.ler()).toMatchObject({ etapa: 'encerrado' });
  });
});

describe('ativação (nada muda de produção sem o dono ligar)', () => {
  it('chave vazia → null sem UMA consulta no banco', async () => {
    const t = criar({ env: { APEX_REPORT_WORKFLOW_ORGS: '' } });
    const r = await executarFluxoDeProntoAtendimento(t.deps);
    expect(r).toBeNull();
    expect(t.banco.query).not.toHaveBeenCalled();
    expect(organizacaoNoFluxo({ APEX_REPORT_WORKFLOW_ORGS: ` , ${ORG} ` }, ORG)).toBe(true);
    expect(organizacaoNoFluxo({}, ORG)).toBe(false);
  });
});

describe('segurança dos textos (guardrails do motor)', () => {
  it('nenhum texto dos 3 idiomas passa no detector determinístico de promessa humana', () => {
    for (const idioma of ['en', 'hi', 'hinglish'] as const) {
      const T = textosDoFluxo(idioma);
      const textos = [
        ...T.perguntarCategoria,
        T.verificarPelaEquipe,
        T.pronto,
        T.naoPronto(null),
        T.naoPronto('2 hours'),
        T.divida('₹400', false),
        T.divida('₹400', true),
        T.legendaQr,
        T.perguntarNome,
        ...Object.values(T.perguntarBiopsy),
        ...Object.values(T.perguntarRadiologia),
        T.detalhesAnotados,
        T.naoEntendi,
        T.identificacaoFalhou,
        T.falhaDoSistema,
      ];
      for (const texto of textos) {
        expect(detectHumanPromise(texto), `${idioma}: ${texto}`).toBe(false);
      }
    }
  });
});

describe('ordem no motor (mesma vigilância do teste de ordem do roteiro)', () => {
  it('o bloco do fluxo entra DEPOIS do gate de opt-out e ANTES do roteiro', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
    const iOptOut = fonte.indexOf('return; // bot silencia: a confirmação já saiu');
    const iFluxo = fonte.indexOf('await executarFluxoDeProntoAtendimento(');
    const iRoteiro = fonte.indexOf('await prepararRoteiroDoTurno(');
    expect(iOptOut).toBeGreaterThan(0);
    expect(iFluxo).toBeGreaterThan(iOptOut);
    expect(iRoteiro).toBeGreaterThan(iFluxo);
  });

  it('a chave da organização é lida ANTES de qualquer consulta de estado', () => {
    const fonte = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/report-readiness/workflow.ts'), 'utf8');
    expect(fonte.indexOf('if (!organizacaoNoFluxo')).toBeGreaterThan(0);
    expect(fonte.indexOf('if (!organizacaoNoFluxo')).toBeLessThan(fonte.indexOf('await lerEstado'));
  });
});
