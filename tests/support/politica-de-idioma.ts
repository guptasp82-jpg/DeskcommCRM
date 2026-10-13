/**
 * POLÍTICA DE IDIOMA CANÔNICA — detector semântico compartilhado pelos testes
 * de regressão da política de resposta em idioma.
 *
 * A política canônica (adotada na implementação do Step 2) é:
 *
 *   "Responda no mesmo idioma utilizado pelo paciente. Se o idioma não puder
 *    ser determinado com segurança, responda em português do Brasil."
 *
 * O que este módulo garante — e o que NÃO garante:
 *
 *   - NÃO proíbe português: pt-BR é o fallback obrigatório da política;
 *   - NÃO casa uma frase exata: a arquitetura permite redação equivalente;
 *   - PROÍBE regra INCONDICIONAL de resposta em português — a regra antiga da
 *     plataforma ("sempre em português do Brasil") e a do agente
 *     ("Responda … em pt-BR.") são sinalizadas por construção;
 *   - frase que impõe português MAS carrega marcador de exceção de idioma na
 *     MESMA frase (mesmo idioma / salvo quando / não puder ser determinado …)
 *     passa: é regra CONDICIONAL, não conflito.
 *
 * Sinalização por FRASE (split em fim de sentença), não por linha — playbook e
 * prompt quebram linha no meio da frase por estética, e a quebra não muda o
 * sentido.
 */

/** Frase que impõe português como língua. */
const IMPOE_PORTUGUES = /\bem pt-?br\b|\bem portugu[eê]s\b|\bportugu[eê]s\s+do\s+brasil\b/i;

/**
 * Frase que DIRECIONA a resposta do paciente (verbo de resposta) ou fala de
 * mensagem enviada ao paciente. Verbos de BUSCA/ENTRADA (buscar, resumir,
 * consultar) ficam de fora de propósito: "a pergunta ou termos a buscar, em
 * pt-br" é idioma de ENTRADA da tool, não regra de resposta.
 */
const DIRECIONA_RESPOSTA =
  /\bresponda|\bresponde|\bresponder|\bfale|\bescreva|\bconverse|\bredija|\bmensagem/i;

/** "sempre em português" é incondicional por construção — pega até linha quebrada no meio. */
const SEMPRE_EM_PORTUGUES = /\bsempre\s+(?:em\s+)?(?:portugu[eê]s|pt-?br)\b/i;

/** Marcador de exceção de idioma: torna a imposição CONDICIONAL. */
const EXCECOES_DE_IDIOMA: readonly RegExp[] = [
  /mesmo idioma/i,
  /outro idioma/i,
  /idioma do paciente/i,
  /idioma (?:utilizado|usado|adotado) pelo/i,
  /idioma de preferência/i,
  /salvo quando/i,
  /não puder ser determinad[oa]/i,
  /não for possível determinar/i,
  /na dúvida/i,
];

/** Frases do texto (fim de sentença; quebra de linha dentro da frase não separa). */
export function frases(texto: string): string[] {
  return texto.split(/(?<=[.!?])\s+/);
}

/**
 * Frases que impõem português INCONDICIONALMENTE — violam a política
 * canônica. Lista vazia = texto em conformidade.
 */
export function regrasIncondicionaisDeIdioma(texto: string): string[] {
  return frases(texto)
    .filter((frase) => {
      if (EXCECOES_DE_IDIOMA.some((excecao) => excecao.test(frase))) return false;
      if (SEMPRE_EM_PORTUGUES.test(frase)) return true;
      return IMPOE_PORTUGUES.test(frase) && DIRECIONA_RESPOSTA.test(frase);
    })
    .map((frase) => frase.trim());
}

/**
 * A política canônica está REPRESENTADA no texto — marcadores semânticos, não
 * frase exata: (a) resposta no idioma do paciente e (b) fallback pt-BR
 * condicionado à impossibilidade de determinar o idioma.
 *
 * Aceita as DUAS redações que a política já teve (português e inglês): as
 * descrições de tool do `inbound-turn.ts` foram traduzidas, e o contrato é o
 * MESMO — idioma do paciente → cautela de determinação → fallback pt-BR.
 */
export function temPoliticaCanonica(texto: string): boolean {
  const idiomaDoPaciente =
    /mesmo idioma|idioma do paciente|idioma (?:utilizado|usado) pelo (?:paciente|cliente|lead)|same language|language used by the (?:patient|customer|lead)/i;
  const cautelaDeDeterminacao =
    /não puder ser determinad[oa]|não for possível determinar|se (?:o )?idioma não (?:puder|for)|na dúvida|cannot be (?:safely )?determined|if the language cannot/i;
  const fallbackPtBr = /portugu[eê]s\s+do\s+brasil|\bpt-?br\b|brazilian portuguese/i;
  return (
    idiomaDoPaciente.test(texto) && cautelaDeDeterminacao.test(texto) && fallbackPtBr.test(texto)
  );
}
