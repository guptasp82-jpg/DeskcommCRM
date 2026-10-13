import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { regrasIncondicionaisDeIdioma, temPoliticaCanonica } from "../support/politica-de-idioma";

/**
 * A POLÍTICA DE IDIOMA CANÔNICA NA PILHA DE PROMPT DO PACIENTE.
 *
 * ## O defeito que fez este teste existir
 *
 * Três instruções de idioma conflitantes conviviam na mesma pilha — plataforma
 * ("sempre em português do Brasil"), agente ("Responda … em pt-BR.") e memória
 * da organização ("Responda em português, salvo quando o paciente utilizar
 * outro idioma"). Medido em produção (run 8f66e07d): o paciente perguntou em
 * inglês e o modelo mandou a MESMA resposta três vezes — C1 em português, C2 em
 * inglês, C3 reformulação em inglês — porque a regra incondicional da
 * plataforma brigava com a exceção da org e o modelo resolveu a tensão
 * reescrevendo a mensagem.
 *
 * ## A política canônica que este arquivo protege
 *
 *   "Responda no mesmo idioma utilizado pelo paciente. Se o idioma não puder
 *    ser determinado com segurança, responda em português do Brasil."
 *
 * Coerente com a resolução de idioma que o produto já usa em toda parte
 * (`contact_locale ?? "pt-BR"`): idioma do contato → idioma da organização →
 * fallback pt-BR.
 *
 * ## O que este teste NÃO prova
 *
 * Que o modelo obedece. Ele garante que a ordem contraditória saiu das FONTES
 * estáticas da pilha (platform.md + as descrições/blocos de inbound-turn.ts) e
 * que a política canônica está representada — sem depender de nenhuma frase
 * exata. As camadas que moram em banco (prompt do agente e memória da org)
 * são o teste irmão `linguagem-canonica-nas-camadas-ativas.test.ts`.
 *
 * Detector semântico compartilhado: `tests/support/politica-de-idioma.ts`.
 */
const RAIZ = process.cwd();
const PLATAFORMA = readFileSync(
  path.join(RAIZ, "lib", "agent-engine", "playbooks", "platform.md"),
  "utf8",
);
const TURNO = readFileSync(
  path.join(RAIZ, "lib", "agent-engine", "agent", "inbound-turn.ts"),
  "utf8",
);

// As três redações do conflito, como texto de referência do detector.
const REGRA_ANTIGA_PLATAFORMA =
  "Você conversa com o WhatsApp em nome da empresa da organização, sempre em português do Brasil, com naturalidade e respeito.";
const REGRA_ANTIGA_AGENTE = "Você é um atendente. Responda de forma educada e clara, em pt-BR.";
const POLITICA_CANONICA =
  "Responda no mesmo idioma utilizado pelo paciente. Se o idioma não puder ser determinado com segurança, responda em português do Brasil.";
const REGRA_CONDICIONAL_ORG =
  "Responda em português, salvo quando o paciente utilizar outro idioma.";

describe("detector semântico de regra incondicional de idioma", () => {
  it("sinaliza as regras incondicionais que produziram o conflito de idioma", () => {
    expect(regrasIncondicionaisDeIdioma(REGRA_ANTIGA_PLATAFORMA)).not.toHaveLength(0);
    expect(regrasIncondicionaisDeIdioma(REGRA_ANTIGA_AGENTE)).not.toHaveLength(0);
    expect(
      regrasIncondicionaisDeIdioma("Responda sempre em português do Brasil."),
    ).not.toHaveLength(0);
    expect(regrasIncondicionaisDeIdioma("Responderá sempre em pt-br.")).not.toHaveLength(0);
    expect(
      regrasIncondicionaisDeIdioma("Envie a mensagem em português para o lead."),
    ).not.toHaveLength(0);
  });

  it("deixa passar a política canônica e regras CONDICIONAIS de idioma", () => {
    expect(regrasIncondicionaisDeIdioma(POLITICA_CANONICA)).toHaveLength(0);
    expect(regrasIncondicionaisDeIdioma(REGRA_CONDICIONAL_ORG)).toHaveLength(0);
    expect(regrasIncondicionaisDeIdioma("Responda no mesmo idioma do paciente.")).toHaveLength(0);
  });

  it("não depende de frase exata: redação equivalente com exceção passa", () => {
    expect(
      regrasIncondicionaisDeIdioma(
        "Fale sempre no idioma do paciente; se não for possível determinar, use português do Brasil.",
      ),
    ).toHaveLength(0);
    expect(
      regrasIncondicionaisDeIdioma(
        "Escreva no idioma utilizado pelo cliente. Na dúvida, em português do Brasil.",
      ),
    ).toHaveLength(0);
  });

  it("palavras de busca/entrada de tool não contam como regra de resposta", () => {
    expect(regrasIncondicionaisDeIdioma("a pergunta ou termos a buscar, em pt-br")).toHaveLength(0);
    expect(regrasIncondicionaisDeIdioma("o que o lead precisa, em pt-br")).toHaveLength(0);
  });
});

describe("camadas de prompt em fonte (platform.md + inbound-turn.ts)", () => {
  it("platform.md: sem regra incondicional e com a política canônica representada", () => {
    expect(regrasIncondicionaisDeIdioma(PLATAFORMA)).toEqual([]);
    expect(temPoliticaCanonica(PLATAFORMA)).toBe(true);
    expect(PLATAFORMA).not.toMatch(/sempre em\s+português do Brasil/i);
  });

  it("inbound-turn.ts: nenhuma descrição/bloco impõe português incondicionalmente", () => {
    expect(regrasIncondicionaisDeIdioma(TURNO)).toEqual([]);
    expect(TURNO).not.toContain("em pt-br, pronto para envio");
  });

  it("send_message: o corpo da mensagem segue a política canônica", () => {
    const corpo = TURNO.match(/describe\('message body, ([^']+)'\)/)?.[1];
    expect(corpo).toBeDefined();
    expect(temPoliticaCanonica(corpo ?? "")).toBe(true);
    expect(regrasIncondicionaisDeIdioma(corpo ?? "")).toHaveLength(0);
  });

  it("temPoliticaCanonica detecta a política e rejeita o texto antigo", () => {
    expect(temPoliticaCanonica(POLITICA_CANONICA)).toBe(true);
    expect(temPoliticaCanonica(REGRA_ANTIGA_PLATAFORMA)).toBe(false);
    expect(temPoliticaCanonica(REGRA_ANTIGA_AGENTE)).toBe(false);
  });
});
