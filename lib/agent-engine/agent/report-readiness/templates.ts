/**
 * TEXTOS do fluxo de consulta de laudo, nos três idiomas do piloto (inglês,
 * hindi em devanagari, hinglish em latino). São frases DETERMINÍSTICAS: o
 * motor manda estas frases direto, sem modelo — por isso são factualmente
 * fechadas (status verificado, valor verificado, pergunta de dado) e sem
 * promessa de retorno humano no futuro ("vou te falar depois"), que o
 * guardrail de caso vetaria. Cada pergunta que se repete entre leads tem
 * variantes sorteadas por hash do contato (mesma disciplina do aviso de
 * escalação): o spinning gate conta frases idênticas por NÚMERO e vetaria a
 * terceira pessoa a perguntar a mesma coisa na janela.
 */
import { createHash } from 'node:crypto';

import type { Idioma } from './intent';

/** Variante determinística por contato: sha256(lead) → índice. Mesma regra do aviso de escalação. */
export function variante<T>(leadId: string, opcoes: readonly T[]): T {
  const digest = createHash('sha256').update(leadId).digest();
  return opcoes[digest.readUInt32BE(0) % opcoes.length]!;
}

export interface TextosFluxo {
  /** Pergunta de categoria (Case C) — 3 variantes por idioma. */
  perguntarCategoria: readonly string[];
  /** Qmarksoft indisponível/sem casamento: o status PRECISA de checagem humana. */
  verificarPelaEquipe: string;
  /** Laudo confirmado pronto pela resposta verificada do sistema. */
  pronto: string;
  /** Laudo confirmado NÃO pronto; `eta` só quando o sistema informou prazo. */
  naoPronto: (eta: string | null) => string;
  /** Valor pendente verificado; `pronto` = o laudo já está pronto e sai após o pagamento. */
  divida: (valor: string, pronto: boolean) => string;
  /** Legenda da imagem do QR (o QR é fixo; o valor NUNCA vai na imagem). */
  legendaQr: string;
  perguntarNome: string;
  perguntarBiopsy: Record<'nome' | 'data_cirurgia' | 'medico', string>;
  perguntarRadiologia: Record<'nome' | 'data_exame' | 'exame', string>;
  detalhesAnotados: string;
  naoEntendi: string;
  identificacaoFalhou: string;
  falhaDoSistema: string;
}

const EN: TextosFluxo = {
  perguntarCategoria: [
    'Which service is this report for? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Which service does this report belong to? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Please tell me which service this report is for: 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
  ],
  verificarPelaEquipe:
    'Your report status needs a manual check at the lab. I am passing this to a colleague at the front desk now.',
  pronto: 'Yes — your report is ready.',
  naoPronto: (eta) =>
    eta === null
      ? 'Your report is not ready yet.'
      : `Your report is not ready yet. The lab's expected time is ${eta}.`,
  divida: (valor, pronto) =>
    pronto
      ? `There is an outstanding amount of ${valor} for this patient. Once the payment is complete, the report is shared on WhatsApp.`
      : `There is an outstanding amount of ${valor} for this patient. Please complete the payment.`,
  legendaQr: 'Payment QR code',
  perguntarNome: "May I have the patient's full name as given at registration?",
  perguntarBiopsy: {
    nome: 'Patient name, as on the registration?',
    data_cirurgia: 'Date of surgery?',
    medico: "Doctor's name or hospital name?",
  },
  perguntarRadiologia: {
    nome: 'Patient name, as on the record?',
    data_exame: 'Date of the test?',
    exame: 'Which test? (Ultrasound, 2D Echo, TMT or ECG)',
  },
  detalhesAnotados:
    'Thank you. The details are noted and I am passing this to a colleague at the front desk now.',
  naoEntendi:
    'I could not understand that. I am passing this to a colleague at the front desk now.',
  identificacaoFalhou:
    "I could not match the patient unambiguously in the lab system. I am passing this to a colleague at the front desk now.",
  falhaDoSistema:
    'I could not reach the lab system right now. I am passing this to a colleague at the front desk now.',
};

const HI: TextosFluxo = {
  perguntarCategoria: [
    'यह रिपोर्ट किस सेवा की है? 1) पैथोलॉजी टेस्ट  2) बायोप्सी  3) रेडियोलॉजी (अल्ट्रासाउंड, 2D इको, TMT, ECG)',
    'यह रिपोर्ट किस सर्विस की है? 1) पैथोलॉजी टेस्ट  2) बायोप्सी  3) रेडियोलॉजी (अल्ट्रासाउंड, 2D इको, TMT, ECG)',
    'कृपया बताइए यह रिपोर्ट किस सेवा की है: 1) पैथोलॉजी टेस्ट  2) बायोप्सी  3) रेडियोलॉजी (अल्ट्रासाउंड, 2D इको, TMT, ECG)',
  ],
  verificarPelaEquipe:
    'रिपोर्ट की स्थिति लैब में चेक करनी होगी। मैं यह जानकारी अभी डेस्क के सहयोगी को भेज रहा हूँ।',
  pronto: 'जी हाँ — आपकी रिपोर्ट तैयार है।',
  naoPronto: (eta) =>
    eta === null
      ? 'अभी आपकी रिपोर्ट तैयार नहीं है।'
      : `अभी आपकी रिपोर्ट तैयार नहीं है। लैब का अनुमानित समय: ${eta}।`,
  divida: (valor, pronto) =>
    pronto
      ? `इस मरीज़ पर ${valor} की बकाया राशि है। भुगतान पूरा होने के बाद रिपोर्ट व्हाट्सएप पर भेजी जाती है।`
      : `इस मरीज़ पर ${valor} की बकाया राशि है। कृपया भुगतान पूरा करें।`,
  legendaQr: 'भुगतान का QR कोड',
  perguntarNome: 'रजिस्ट्रेशन में जो नाम है, मरीज़ का वही पूरा नाम बताइए?',
  perguntarBiopsy: {
    nome: 'मरीज़ का नाम?',
    data_cirurgia: 'ऑपरेशन की तारीख?',
    medico: 'डॉक्टर का नाम या अस्पताल का नाम?',
  },
  perguntarRadiologia: {
    nome: 'मरीज़ का नाम?',
    data_exame: 'टेस्ट की तारीख?',
    exame: 'कौन-सा टेस्ट? (अल्ट्रासाउंड, 2D इको, TMT या ECG)',
  },
  detalhesAnotados:
    'धन्यवाद। जानकारी नोट कर ली है, मैं इसे अभी डेस्क के सहयोगी को भेज रहा हूँ।',
  naoEntendi:
    'यह समझ नहीं आया। मैं यह अभी डेस्क के सहयोगी को भेज रहा हूँ।',
  identificacaoFalhou:
    'लैब सिस्टम में मरीज़ की पक्की पहचान नहीं हो पाई। मैं यह अभी डेस्क के सहयोगी को भेज रहा हूँ।',
  falhaDoSistema:
    'अभी लैब सिस्टम से जुड़ नहीं पा रहा हूँ। मैं यह अभी डेस्क के सहयोगी को भेज रहा हूँ।',
};

const HINGLISH: TextosFluxo = {
  perguntarCategoria: [
    'Yeh report kis service ki hai? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Yeh report kis service se related hai? 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
    'Bataiye yeh report kis service ki hai: 1) Pathology test  2) Biopsy  3) Radiology (Ultrasound, 2D Echo, TMT, ECG)',
  ],
  verificarPelaEquipe:
    'Report ka status lab mein manual check karna hoga. Main yeh abhi desk ke colleague ko bhej raha hoon.',
  pronto: 'Ji haan — aapki report taiyar hai.',
  naoPronto: (eta) =>
    eta === null
      ? 'Abhi aapki report taiyar nahi hai.'
      : `Abhi aapki report taiyar nahi hai. Lab ka anumaanit samay: ${eta}.`,
  divida: (valor, pronto) =>
    pronto
      ? `Is patient par ${valor} ki outstanding amount hai. Payment complete hone par report WhatsApp par bheji jaati hai.`
      : `Is patient par ${valor} ki outstanding amount hai. Kripya payment complete karein.`,
  legendaQr: 'Payment ka QR code',
  perguntarNome: 'Registration mein jo naam hai, patient ka poora naam wahi bataiye?',
  perguntarBiopsy: {
    nome: 'Patient ka naam?',
    data_cirurgia: 'Operation ki date?',
    medico: 'Doctor ka naam ya hospital ka naam?',
  },
  perguntarRadiologia: {
    nome: 'Patient ka naam?',
    data_exame: 'Test ki date?',
    exame: 'Kaunsa test? (Ultrasound, 2D Echo, TMT ya ECG)',
  },
  detalhesAnotados:
    'Shukriya. Details note kar li hain, main yeh abhi desk ke colleague ko bhej raha hoon.',
  naoEntendi:
    'Yeh samajh nahi aaya. Main yeh abhi desk ke colleague ko bhej raha hoon.',
  identificacaoFalhou:
    'Lab system mein patient ki pakki pehchaan nahi ho payi. Main yeh abhi desk ke colleague ko bhej raha hoon.',
  falhaDoSistema:
    'Abhi lab system se connect nahi ho pa raha. Main yeh abhi desk ke colleague ko bhej raha hoon.',
};

const TEXTOS: Record<Idioma, TextosFluxo> = { en: EN, hi: HI, hinglish: HINGLISH };

export function textosDoFluxo(idioma: Idioma): TextosFluxo {
  return TEXTOS[idioma] ?? EN;
}
