/**
 * CLIENTE QMARKSOFT — o lookup de paciente/laudo/balance do piloto Apex.
 *
 * A integração Qmarksoft NÃO existe nesta instalação (a policy draft do piloto
 * registra isso em letra miúda, e nada aqui a inventa): enquanto os donos não
 * fornecerem URL e credencial, `configQmarksoft` devolve `null` e o workflow
 * nunca faz chamada — o braço é "indisponível", que cai em checagem humana.
 *
 * Contrato pendente de confirmação (marcado aqui como assumido): POST JSON
 * `{ phone, patient_name? }` → 200 com
 * `{ patient: { name }, service: "pathology"|"biopsy"|"radiology",
 *    report: { ready: boolean, eta?: string }, outstanding?: { amount, currency } }`,
 * 404 = não encontrado, 409 = ambíguo (n pacientes no mesmo telefone).
 * TIMEOUT e erro de transporte viram `timeout`/`indisponivel` — NUNCA viram
 * status de laudo: sem resposta confiável, o fluxo entrega para humano.
 *
 * A chave (`QMARKSOFT_API_KEY`) entra no header e sai daqui nunca logada.
 */
import type { Servico } from './intent';

export interface ConfigQmarksoft {
  lookupUrl: string;
  apiKey: string | null;
  timeoutMs: number;
}

/** Limite razoável para um lookup inline no turno (não deixa o job morrer no socket). */
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 30_000;

export function configQmarksoft(env: Record<string, string | undefined>): ConfigQmarksoft | null {
  const baseUrl = (env.QMARKSOFT_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const lookup = (env.QMARKSOFT_LOOKUP_URL ?? '').trim();
  // Sem os DOIS endereços configurados não há contrato: integração indisponível.
  if (baseUrl === '' || lookup === '') return null;
  const lookupUrl = /^https?:\/\//i.test(lookup) ? lookup : `${baseUrl}/${lookup.replace(/^\/+/, '')}`;
  const bruto = Number(env.QMARKSOFT_TIMEOUT_MS ?? '8000');
  const timeoutMs = Number.isFinite(bruto)
    ? Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, bruto))
    : 8_000;
  const apiKey = (env.QMARKSOFT_API_KEY ?? '').trim();
  return { lookupUrl, apiKey: apiKey === '' ? null : apiKey, timeoutMs };
}

export type ResultadoQmarksoft =
  | {
      status: 'ok';
      paciente: string;
      servico: Servico;
      relatorio: { pronto: boolean; eta: string | null };
      divida: { amount: number; currency: string | null } | null;
    }
  | { status: 'nao_encontrado' }
  | { status: 'ambiguo'; candidatos: number }
  | { status: 'timeout' }
  | { status: 'indisponivel'; motivo: string };

type FetchDeRede = typeof fetch;

/**
 * Lookup com timeout. NUNCA lança: qualquer desfecho vira um dos estados
 * acima, e o workflow decide o braço seguro (falha → humano, nunca chute).
 */
export async function consultarPaciente(
  cfg: ConfigQmarksoft,
  params: { telefone: string | null; nome?: string },
  deps: { fetch: FetchDeRede; log?: { warn(msg: string, fields?: Record<string, unknown>): void } },
): Promise<ResultadoQmarksoft> {
  if (params.telefone === null || params.telefone.trim() === '') {
    return { status: 'indisponivel', motivo: 'telefone_do_contato_indisponivel' };
  }
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), cfg.timeoutMs);
  try {
    const resposta = await deps.fetch(cfg.lookupUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey !== null ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        phone: params.telefone,
        ...(params.nome !== undefined ? { patient_name: params.nome } : {}),
      }),
      signal: controlador.signal,
    });
    if (resposta.status === 404) return { status: 'nao_encontrado' };
    if (resposta.status === 409) {
      let candidatos = 0;
      try {
        const corpo = (await resposta.json()) as { candidates?: number };
        candidatos = typeof corpo.candidates === 'number' ? corpo.candidates : 0;
      } catch {
        candidatos = 0;
      }
      return { status: 'ambiguo', candidatos };
    }
    if (!resposta.ok) {
      return { status: 'indisponivel', motivo: `http_${resposta.status}` };
    }
    let corpo: unknown;
    try {
      corpo = await resposta.json();
    } catch {
      return { status: 'indisponivel', motivo: 'resposta_sem_json' };
    }
    return interpretarCorpo(corpo);
  } catch (err) {
    const abortado = err instanceof Error && err.name === 'AbortError';
    if (!abortado) {
      deps.log?.warn('qmarksoft: lookup falhou (transporte) — braço indisponível do workflow', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
    return abortado ? { status: 'timeout' } : { status: 'indisponivel', motivo: 'transporte' };
  } finally {
    clearTimeout(timer);
  }
}

const SERVICOS: readonly Servico[] = ['pathology', 'biopsy', 'radiology'];

/**
 * Parse do corpo com fechamento total: campo ausente/errado nunca vira
 * "laudo pronto" — vira indisponível (o fluxo entrega para humano).
 */
export function interpretarCorpo(corpo: unknown): ResultadoQmarksoft {
  if (corpo === null || typeof corpo !== 'object') return { status: 'indisponivel', motivo: 'corpo_invalido' };
  const c = corpo as Record<string, unknown>;
  const paciente = (c.patient as Record<string, unknown> | undefined)?.name;
  const servico = c.service;
  const relatorio = c.report as Record<string, unknown> | undefined;
  if (typeof paciente !== 'string' || paciente.trim() === '') return { status: 'indisponivel', motivo: 'paciente_ausente' };
  if (typeof servico !== 'string' || !SERVICOS.includes(servico as Servico)) {
    return { status: 'indisponivel', motivo: 'servico_desconhecido' };
  }
  if (relatorio === null || typeof relatorio !== 'object' || typeof relatorio.ready !== 'boolean') {
    return { status: 'indisponivel', motivo: 'status_de_laudo_ausente' };
  }
  const eta = typeof relatorio.eta === 'string' && relatorio.eta.trim() !== '' ? relatorio.eta.trim() : null;
  const dividaBruta = c.outstanding as Record<string, unknown> | undefined;
  let divida: { amount: number; currency: string | null } | null = null;
  if (dividaBruta !== undefined && dividaBruta !== null && typeof dividaBruta === 'object' && typeof dividaBruta.amount === 'number' && dividaBruta.amount > 0) {
    divida = {
      amount: dividaBruta.amount,
      currency: typeof dividaBruta.currency === 'string' ? dividaBruta.currency : null,
    };
  }
  return {
    status: 'ok',
    paciente: paciente.trim(),
    servico: servico as Servico,
    relatorio: { pronto: relatorio.ready, eta },
    divida,
  };
}
