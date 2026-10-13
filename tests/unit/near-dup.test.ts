import { describe, it, expect } from 'vitest';
import {
  normalizarParaComparacao,
  similaridadeDice,
  ehDuplicadoOuProximo,
  encontraDuplicado,
  LIMIAR_DUPLICADO_PROXIMO,
} from '@/lib/agent-engine/agent/near-dup';

describe('normalizarParaComparacao', () => {
  it('colapsa espaços, trim e caixa', () => {
    expect(normalizarParaComparacao('  Ola,\n  mundo   ')).toBe('ola, mundo');
    expect(normalizarParaComparacao('OLA MUNDO')).toBe('ola mundo');
  });

  it('remove zero-width e BOM', () => {
    expect(normalizarParaComparacao('a\u200Bb\ufeff')).toBe('ab');
  });

  it('preserva script Devanagari (sem caixa, sem quebra)', () => {
    // "12 घंटे का उपवास" — normalização não deve corromper os glifos.
    const s = '१२ घंटे का उपवास';
    expect(normalizarParaComparacao(`  ${s}  `)).toBe(s);
  });
});

describe('similaridadeDice', () => {
  it('idênticos = 1', () => {
    expect(similaridadeDice('abc def', 'abc def')).toBe(1);
  });

  it('completamente diferentes = 0', () => {
    expect(similaridadeDice('aaaa', 'zzzz')).toBe(0);
  });

  it('quase-idênticos ficam altos', () => {
    const a = 'O preço do perfil de tireoide é R$ 550, agende com antecedência.';
    const b = 'O preço do perfil de tireoide é R$ 550, agende com antecedência agora.';
    expect(similaridadeDice(a, b)).toBeGreaterThan(LIMIAR_DUPLICADO_PROXIMO);
  });

  it('strings curtas (<2 chars) sem igualdade = 0', () => {
    expect(similaridadeDice('a', 'b')).toBe(0);
  });
});

describe('ehDuplicadoOuProximo', () => {
  it('duplicata exata após normalização', () => {
    expect(ehDuplicadoOuProximo('Sim, o exame custa R$550.', 'sim,  o exame custa r$550.')).toBe(true);
  });

  it('corpo em branco nunca suprime', () => {
    expect(ehDuplicadoOuProximo('', '')).toBe(false);
    expect(ehDuplicadoOuProximo('   ', '')).toBe(false);
  });

  it('redação genuinamente distinta passa (não suprime)', () => {
    expect(
      ehDuplicadoOuProximo(
        'Seu resultado do TSH fica pronto em 2 dias úteis.',
        'Para o exame de TSH é necessário 12 horas de jejum.',
      ),
    ).toBe(false);
  });

  it('restatemente quase idêntico suprime', () => {
    expect(
      ehDuplicadoOuProximo(
        'Jejum de 12 horas é necessário para o perfil da tireoide.',
        'Jejum de 12 horas é necessário para o perfil da tireoide, ok?',
      ),
    ).toBe(true);
  });

  it('Devanagari quase idêntico suprime; conteúdo distinto passa', () => {
    expect(
      ehDuplicadoOuProximo('१२ घंटे का उपवास आवश्यक है।', '१२ घंटे का उपवास आवश्यक है।'),
    ).toBe(true);
    expect(
      ehDuplicadoOuProximo('१२ घंटे का उपवास आवश्यक है।', 'रिपोर्ट तैयार है, कृपया संपर्क करें।'),
    ).toBe(false);
  });

  it('respeita limiar customizado', () => {
    const a = 'abcde fghij';
    const b = 'abcde fghix';
    // com limiar 1.0 só igualdade exata suprime
    expect(ehDuplicadoOuProximo(a, b, 1.0)).toBe(false);
    expect(ehDuplicadoOuProximo(a, b, 0.5)).toBe(true);
  });
});

describe('encontraDuplicado', () => {
  it('devolve o PRIMEIRO corpo do qual o candidato é duplicata', () => {
    const enviados = [
      'Jejum de 12 horas é necessário.',
      'Outra coisa completamente diferente aqui.',
    ];
    const alvo = 'Jejum de 12 horas é necessário, ok?';
    expect(encontraDuplicado(alvo, enviados)).toBe(enviados[0]);
  });

  it('devolve null quando nada é duplicata', () => {
    expect(encontraDuplicado('conteúdo novo e distinto', ['algo velho e diferente'])).toBeNull();
  });

  it('lista vazia = null', () => {
    expect(encontraDuplicado('qualquer coisa', [])).toBeNull();
  });
});
