/** Identidade capturada na origem do trabalho; nunca recompor com o estado atual. */
export interface ServiceBoundary {
  organization_id: string;
  contact_id: string;
  conversation_id: string;
  service_revision: number;
  demanda_id: string | null;
  demanda_revision: number | null;
}
export interface CurrentServiceBoundary extends ServiceBoundary {
  status: string;
  demanda_fechada_em: string | null;
}
export class StaleServiceBoundaryError extends Error {
  constructor() {
    super("service_boundary_stale");
    this.name = "StaleServiceBoundaryError";
  }
}
/**
 * A conversa entrou em TOMADA HUMANA / PAUSA (`conversations.bot_silenced_until`
 * gravado por telefone, `pause-ai`, claim ou resposta manual) DEPOIS que o turno
 * da IA começou e ANTES de o envio sair do servidor — o veto da corrida de
 * takeover.
 *
 * Estende `StaleServiceBoundaryError` de propósito: todo o trilho que já trata
 * fronteira vencida vale para este veto SEM uma linha de encanamento nova — o
 * handler reenvia o erro em vez de mascará-lo (`_handler.ts` catch), o ledger
 * fica `requested` e o worker encerra o job como terminal, sem retry e sem
 * Sentry (`workers/agent-worker/main.ts`). A mensagem distinta
 * (`human_takeover_stale`) mantém o diagnóstico preciso nos logs e no
 * `last_error` do job, e `instanceof StaleServiceBoundaryError` continua
 * verdadeiro em toda parte.
 */
export class HumanTakeoverStaleError extends StaleServiceBoundaryError {
  constructor() {
    super();
    this.message = "human_takeover_stale";
    this.name = "HumanTakeoverStaleError";
  }
}
/** `followup_stale` deixou de ser 40001 (serialization_failure): o cliente retentava para sempre. */
export function isFollowupCasRecusado(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "40001" || error?.message === "followup_stale";
}
/**
 * ABRIR A PRIMEIRA DEMANDA NÃO É ATENDIMENTO NOVO — e quem diz isso é o schema.
 *
 * A migration 0222 só incrementa `service_revision` quando TROCA de demanda
 * (`current_demanda_id is not null and current_demanda_id <> d.id`); ir de
 * "nenhuma demanda" para a primeira mantém a revisão de propósito, porque é o
 * mesmo atendimento. Comparar `demanda_id` por igualdade crua fazia o
 * TypeScript discordar do SQL sobre o que é "o mesmo atendimento".
 *
 * O custo disso não era só um teste vermelho: o gatilho de silêncio captura a
 * fronteira de um contato CALADO — que, por definição, não tem demanda aberta —
 * e o nó `ai_classify` fica em `waiting_reply` esperando o inbound do lead. Era
 * exatamente essa resposta que abria a primeira demanda e, pelo predicado
 * estrito, vencia o acompanhamento que ela acabara de acordar. O nó ficava
 * morto por construção, em produção e não só no e2e.
 *
 * O que continua vetando quando `expected.demanda_id` é nulo: a demanda fechar
 * (`current.demanda_fechada_em`), a conversa virar terminal (`status`), e
 * TROCAR de demanda ou reabrir — os dois incrementam `service_revision`. E o
 * estado sucessor admitido é exatamente UM: uma segunda demanda na mesma
 * revisão é impossível pela regra da 0222 acima.
 */
function demandaTrocou(expected: ServiceBoundary, current: CurrentServiceBoundary): boolean {
  if (expected.demanda_id === null) return false;
  return (
    expected.demanda_id !== current.demanda_id ||
    expected.demanda_revision !== current.demanda_revision
  );
}
export function assertCurrentServiceBoundary(
  expected: ServiceBoundary | null,
  current: CurrentServiceBoundary | null,
): void {
  if (
    !expected ||
    !current ||
    (expected.demanda_id !== null && !Number.isSafeInteger(expected.demanda_revision)) ||
    (current.demanda_id !== null && !Number.isSafeInteger(current.demanda_revision)) ||
    ["closed", "resolved", "archived"].includes(current.status) ||
    current.demanda_fechada_em ||
    expected.organization_id !== current.organization_id ||
    expected.contact_id !== current.contact_id ||
    expected.conversation_id !== current.conversation_id ||
    expected.service_revision !== current.service_revision ||
    demandaTrocou(expected, current)
  ) {
    throw new StaleServiceBoundaryError();
  }
}
/** Mesma identidade de atendimento: org, contato, conversa, revisão e demanda. */
export function mesmaFronteira(a: ServiceBoundary | null, b: ServiceBoundary | null): boolean {
  return (
    !!a &&
    !!b &&
    a.organization_id === b.organization_id &&
    a.contact_id === b.contact_id &&
    a.conversation_id === b.conversation_id &&
    a.service_revision === b.service_revision &&
    a.demanda_id === b.demanda_id &&
    a.demanda_revision === b.demanda_revision
  );
}
export function parseServiceBoundary(value: unknown): ServiceBoundary | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (
    typeof b.organization_id !== "string" ||
    typeof b.contact_id !== "string" ||
    typeof b.conversation_id !== "string" ||
    !Number.isSafeInteger(b.service_revision) ||
    Number(b.service_revision) < 1 ||
    !(b.demanda_id === null || typeof b.demanda_id === "string") ||
    !(b.demanda_revision === null || Number.isSafeInteger(b.demanda_revision))
  )
    return null;
  return b as unknown as ServiceBoundary;
}
