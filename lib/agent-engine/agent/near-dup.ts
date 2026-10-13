/**
 * Detecção de DUPLICATA PRÓXIMA de conteúdo — puro, sem I/O, sem dependência.
 *
 * ## Por que existe (medido ao vivo no piloto Apex PathLabs, 2026-10-12)
 *
 * Uma única pergunta do paciente recebeu 4 respostas do agente. Três vieram do
 * caminho de recuperação do "turno mudo": o primeiro `agent_turn` terminou sem
 * candidato enviável, a correção do turno mudo re-perguntou ao modelo, e o modelo
 * chamou `send_message` três vezes com corpos quase idênticos — cada um passou
 * pelas cadeias de guardrails e virou uma bolha separada no WhatsApp. A quarta
 * veio de um follow-up de promessa agendado que re-respondeu a mesma pergunta.
 *
 * O contrato do produto é UMA resposta adequada e completa por turno. Restatemente
 * imediato da mesma ideia é redundância, não informação nova. Este módulo é a régua
 * pura que decide se um candidato é repetição do que já saiu — onde "já saiu" é
 * decidido por quem chama (turno em memória ou histórico recente via banco).
 *
 * ## Escopo deliberado (não suprimir resposta legítima)
 *
 * A comparação é CONTEÚDO, não tópico. Dois textos que falam do mesmo exame com
 * redação diferente passam (semelhança baixa); o mesmo texto (ou quase) é
 * redundância. A janela temporal é responsabilidade de quem chama: o turno guarda
 * só o que saiu NOSTE turno; o follow-up olha uma janela recente do banco. Isso
 * mantém "não suprimir resposta futura legítima sobre o mesmo tópico" fora da
 * régua — a régua só vê similaridade de texto, nunca assunto.
 *
 * ## Forma
 *
 * Normalização (NFC + zero-width + colapso de espaço + caixa) seguida do
 * coeficiente de Dice sobre bigramas de código-fonte. Bigramas de `Array.from`
 * iteram por ponto de código, então Devanagari (e pares substitutos) não quebram.
 * Igualdade normalizada é duplicata por construção; semelhança >= limiar é
 * duplicata próxima. Padrão de limiar alto (0.9): só quase-idênticos suprimem,
 * para preservar mensagens genuinamente distintas.
 */

/** Zero-width e BOM — invisíveis, mas quebram a igualdade ingênua. */
const INVISIVEIS = /[\u200B\u200C\u200D\uFEFF]/g;

/**
 * Normaliza um corpo para comparação: NFC, remove invisíveis, colapsa qualquer
 * sequência de espaço em um espaço só, trim, caixa baixa. Devanagari não tem
 * caixa (toLowerCase é no-op); latin/pt colapsa variações de capitalização.
 */
export function normalizarParaComparacao(body: string): string {
  return body
    .normalize('NFC')
    .replace(INVISIVEIS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Multicontagem de bigramas de código-fonte (Array.from respeita pontos de código). */
function bigramas(s: string): Map<string, number> {
  const chars = Array.from(s);
  const m = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * Coeficiente de Dice sobre bigramas: 2 * interseção / (|A| + |B|), com
 * interseção contada por multicontagem (min por bigrama). 1 = idêntico.
 * Strings com menos de 2 caracteres só são iguais por igualdade exata.
 */
export function similaridadeDice(a: string, b: string): number {
  if (a === b) return 1;
  const charsA = Array.from(a);
  const charsB = Array.from(b);
  if (charsA.length < 2 || charsB.length < 2) return 0;
  const A = bigramas(a);
  const B = bigramas(b);
  let interseccao = 0;
  for (const [g, ca] of A) {
    const cb = B.get(g);
    if (cb !== undefined) interseccao += Math.min(ca, cb);
  }
  let totalA = 0;
  for (const v of A.values()) totalA += v;
  let totalB = 0;
  for (const v of B.values()) totalB += v;
  return (2 * interseccao) / (totalA + totalB);
}

/** Limiar padrão: quase-idêntico. Abaixo disso é redação distinta — passa. */
export const LIMIAR_DUPLICADO_PROXIMO = 0.9;

/**
 * `true` quando `candidato` é duplicata (igual normalizada) ou duplicata próxima
 * (semelhança >= `limiar`) de `jaEnviado`. Comparação em branco nunca suprime.
 */
export function ehDuplicadoOuProximo(
  candidato: string,
  jaEnviado: string,
  limiar: number = LIMIAR_DUPLICADO_PROXIMO,
): boolean {
  const c = normalizarParaComparacao(candidato);
  const e = normalizarParaComparacao(jaEnviado);
  if (c === e) return c.length > 0;
  if (c.length < 2 || e.length < 2) return false;
  return similaridadeDice(c, e) >= limiar;
}

/**
 * Primeiro corpo de `jaEnviados` do qual `candidato` é duplicata (ou `null`).
 * Ordem = ordem de envio; devolver o primeiro mantém a PRIMEIRA resposta e
 * suprime o restatemente — é o que "retendo a primeira resposta adequada" pede.
 */
export function encontraDuplicado(
  candidato: string,
  jaEnviados: readonly string[],
  limiar: number = LIMIAR_DUPLICADO_PROXIMO,
): string | null {
  for (const previo of jaEnviados) {
    if (ehDuplicadoOuProximo(candidato, previo, limiar)) return previo;
  }
  return null;
}
