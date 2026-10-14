/**
 * WORKFLOW de consulta de laudo (Apex PathLabs) — o caminho DETERMINÍSTICO do
 * turno: mensagem casa "laudo pronto?" (EN/HI/Hinglish) → o fluxo de serviço
 * responde no lugar de uma FAQ genérica, um passo por vez, com estado na
 * conversa. Engajou → o modelo NÃO roda neste turno; não engajou → o modelo
 * roda exatamente como antes (preço, horário, osm intents que já funcionam).
 *
 * Braços (spec do piloto):
 *   Caso A — Qmarksoft configurado: lookup por telefone (+nome quando o
 *     primeiro não casa); resposta VERIFICADA do sistema é a única fonte de
 *     status/valor; valor pendente → texto + QR fixo do serviço; ambíguo →
 *     pergunta o nome mínimo e, se seguir ambíguo, humano; falha/timeout →
 *     humano, nunca status inventado.
 *   Caso B — Qmarksoft indisponível + mensagem de registro prévia no
 *     histórico: diz que o status precisa de checagem e entrega para humano.
 *   Caso C — nada disso: pergunta a categoria (1 pathology, 2 biopsy,
 *     3 radiology) e guarda a escolha; biopsy/radiologia sem API coletam
 *     nome → data → médico/exame (uma pergunta por vez, sem repetir o já
 *     respondido) e entregam para humano com o resumo.
 *
 * Confiabilidade: claim da mensagem em `conversations.metadata` (retry da
 * mesma mensagem = no-op), teto de envios por turno respeitado (o mesmo
 * MAX_SENDS_PER_TURN do motor; com teto 1 o QR adia para o próximo turno),
 * e falha de sistema → humano. PII (nome, datas) vai só para a passagem do
 * atendente — nunca para log.
 */
import { createHash } from 'node:crypto';

import type { FotoParaEnvio } from '../fotos-do-produto';
import type { Queryable } from '../../queue/queue';
import {
  coletarDoTexto,
  detectarIdioma,
  detectarServico,
  ehOutraIntencao,
  ehPerguntaDeLaudo,
  ehPreenchimentoUtil,
  formatarValor,
  proximoPendente,
  respostaDeServico,
  servicoDaMensagemDeRegistro,
  type CampoColetado,
  type Servico,
} from './intent';
import { configQmarksoft, consultarPaciente, type ResultadoQmarksoft } from './qmarksoft';
import type { TipoQr } from './qr';
import { lerEstado, reivindicarMensagem, salvarEstado, type EstadoFluxo } from './state';
import { textosDoFluxo, variante } from './templates';

export interface Log {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface FluxoDeLaudoDeps {
  db: Queryable;
  log: Log;
  tenantId: string;
  leadId: string;
  conversationId: string;
  /** Mensagem inbound deste turno (claim de retry); null ⇒ usa o hash do texto. */
  msgId: string | null;
  texto: string | null;
  telefone: string | null;
  env: Record<string, string | undefined>;
  /** Teto de mensagens físicas do turno (MAX_SENDS_PER_TURN). */
  maxSends: number;
  /** Últimas mensagens OUTBOUND da conversa (mais recente primeiro), para o Case B. */
  buscarHistorico: () => Promise<readonly string[]>;
  enviar: (corpo: string, media?: FotoParaEnvio) => Promise<boolean>;
  /** Copia o QR fixo do serviço para a conversa; null = ativo pendente de upload. */
  prepararQr: (tipo: TipoQr) => Promise<FotoParaEnvio | null>;
  handover: (o: { titulo: string; resumo: string }) => Promise<void>;
  fetchDeRede?: typeof fetch;
}

export interface ResultadoFluxo {
  /** false = o modelo roda como antes; true = o fluxo tomou o turno. */
  engajado: boolean;
  acoes: number;
}

/**
 * Chave de ativação — lista de organizações. VAZIA (default) = fluxo morto em
 * toda instalação: o código existe localmente, mas nada muda em produção até
 * o dono ligar explicitamente para a org do piloto.
 */
export function organizacaoNoFluxo(env: Record<string, string | undefined>, tenantId: string): boolean {
  return (env.APEX_REPORT_WORKFLOW_ORGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .includes(tenantId);
}

const TITULO_DA_ENTREGA = 'Consulta de laudo — verificar manualmente';

function resumoDaEntrega(estado: EstadoFluxo, extra: string): string {
  const detalhes = estado.detalhes !== undefined && Object.keys(estado.detalhes).length > 0
    ? ` detalhes coletados: ${JSON.stringify(estado.detalhes)};`
    : ' sem detalhes coletados;';
  return `Fluxo de consulta de laudo (workflow determinístico). serviço=${estado.servico ?? 'desconhecido'};${detalhes} ${extra}`;
}

export async function executarFluxoDeProntoAtendimento(
  deps: FluxoDeLaudoDeps,
): Promise<ResultadoFluxo | null> {
  if (!organizacaoNoFluxo(deps.env, deps.tenantId)) return null;
  const ids = { tenantId: deps.tenantId, conversationId: deps.conversationId };
  const cfgQ = configQmarksoft(deps.env);
  const tiposDeQr: Record<Servico, TipoQr | null> = {
    pathology: 'pathology',
    biopsy: 'biopsy',
    // Radiologia não reusa QR de serviço nenhum (regra do piloto).
    radiology: null,
  };

  let acoes = 0;
  let estado = await lerEstado(deps.db, ids);
  const texto = (deps.texto ?? '').trim();

  // Mídia sem texto legível: não responde pergunta nenhuma. Com estado, o
  // turno é do fluxo (silêncio deliberado, sem gastar envio); sem estado, o
  // modelo responde como antes (transcrição de áudio já mora no histórico).
  if (texto === '') {
    return estado === null ? { engajado: false, acoes: 0 } : { engajado: true, acoes: 0 };
  }

  // Retry de uma mensagem JÁ concluída: nem efeito, nem modelo — é a trava
  // "sem reply/handover duplicado" do spec.
  if (estado !== null && !estado.processando && estado.msg === (deps.msgId ?? hashDoTexto(texto))) {
    return { engajado: true, acoes: 0 };
  }

  // Outra intenção nítida (preço, desconto...) no meio do fluxo: o estado é
  // marcado encerrado e a mensagem segue para o modelo — o pricing que já
  // funciona não pode ser engolido por uma pergunta pendente de laudo. O
  // marcador fica (não apaga): ele é a trava de retry da última mensagem
  // tratada, e apagaria a memória junto.
  if (estado !== null && ehOutraIntencao(texto)) {
    await salvarEstado(deps.db, ids, {
      v: 1,
      msg: estado.msg,
      processando: false,
      etapa: 'encerrado',
      idioma: estado.idioma,
    });
    deps.log.info('fluxo de laudo: outra intenção detectada — fluxo encerrado, modelo responde', {});
    return { engajado: false, acoes: 0 };
  }

  const ehLaudo = ehPerguntaDeLaudo(texto);
  // Fluxo já encerrado e hoje não é pergunta de laudo: estado só guarda o
  // marcador de retry, e a mensagem é do modelo.
  if (estado !== null && estado.etapa === 'encerrado' && !ehLaudo) {
    return { engajado: false, acoes: 0 };
  }
  if (estado === null && !ehLaudo) return { engajado: false, acoes: 0 };

  // Reivindica a mensagem ANTES de qualquer efeito. Um turno interrompido
  // (`processando: true`) re-executa: os efeitos são idempotentes no motor.
  const msgId = deps.msgId ?? hashDoTexto(texto);
  const idioma = estado?.idioma ?? detectarIdioma(texto);
  const proximo: EstadoFluxo = {
    v: 1,
    msg: msgId,
    processando: true,
    etapa: estado?.etapa ?? 'inicio',
    idioma,
    ...(estado?.servico !== undefined ? { servico: estado.servico } : {}),
    ...(estado?.pendente !== undefined ? { pendente: estado.pendente } : {}),
    ...(estado?.detalhes !== undefined ? { detalhes: { ...estado.detalhes } } : {}),
    ...(estado?.tentativas !== undefined ? { tentativas: estado.tentativas } : {}),
    ...(estado?.qrPendente !== undefined ? { qrPendente: estado.qrPendente } : {}),
  };
  if (!(await reivindicarMensagem(deps.db, ids, proximo))) {
    return { engajado: true, acoes: 0 };
  }
  estado = proximo;

  const T = textosDoFluxo(estado.idioma);
  let enviadas = 0;
  let limpar = false;
  const enviar = async (corpo: string, media?: FotoParaEnvio): Promise<boolean> => {
    if (enviadas >= deps.maxSends) {
      deps.log.info('fluxo de laudo: teto de mensagens do turno atingido — envio adiado', {});
      return false;
    }
    enviadas += 1;
    acoes += 1;
    return deps.enviar(corpo, media);
  };
  const entregar = async (extra: string): Promise<void> => {
    acoes += 1;
    await deps.handover({ titulo: TITULO_DA_ENTREGA, resumo: resumoDaEntrega(proximo, extra) });
    limpar = true;
  };

  // ---- rotas ---------------------------------------------------------------

  const perguntaDe = (servico: 'biopsy' | 'radiology', campo: CampoColetado): string => {
    if (servico === 'biopsy' && (campo === 'nome' || campo === 'data_cirurgia' || campo === 'medico')) {
      return T.perguntarBiopsy[campo];
    }
    if (servico === 'radiology' && (campo === 'nome' || campo === 'data_exame' || campo === 'exame')) {
      return T.perguntarRadiologia[campo];
    }
    return T.naoEntendi; // inalcançável: `campo` vem de proximoPendente do MESMO serviço
  };

  const rotaDeColeta = async (servico: 'biopsy' | 'radiology', detalhesIniciais: Record<string, string>): Promise<void> => {
    proximo.etapa = 'coleta';
    proximo.servico = servico;
    proximo.detalhes = detalhesIniciais;
    proximo.tentativas = 0;
    const pendente = proximoPendente(servico, detalhesIniciais);
    if (pendente === null) {
      await enviar(T.detalhesAnotados);
      await entregar(`coleta completa no turno de entrada: ${JSON.stringify(detalhesIniciais)}`);
      return;
    }
    proximo.pendente = pendente;
    await enviar(perguntaDe(servico, pendente));
  };

  const rotaVerificada = async (r: Extract<ResultadoQmarksoft, { status: 'ok' }>): Promise<void> => {
    proximo.servico = r.servico;
    if (r.divida !== null) {
      const valor = formatarValor(r.divida);
      const tipoQr = tiposDeQr[r.servico];
      const textoDaDivida = T.divida(valor, r.relatorio.pronto);
      const enviouValor = await enviar(textoDaDivida);
      if (!enviouValor) {
        // Nem o texto de valor saiu (teto/veto): o caso é do humano, nunca
        // de um chute. QR não tenta — o valor em aberto não pode sumir.
        await entregar(`valor pendente ${valor} verificado, mas o texto não saiu do turno — pagamento manual.`);
        return;
      }
      if (tipoQr === null) {
        // Radiologia: valor verificado, mas NENHUM QR é reusado por padrão.
        await entregar(`valor pendente ${valor} verificado (radiologia — sem QR automático).`);
        return;
      }
      const qr = await deps.prepararQr(tipoQr);
      if (qr === null) {
        // QR fixo ainda não configurado/enviado: sem placeholder, sem imagem
        // errada — o pagamento vira acompanhamento humano, com a dependência
        // registrada na passagem.
        await entregar(`valor pendente ${valor} verificado; QR fixo de ${r.servico} pendente de configuração — pagamento manual.`);
        return;
      }
      if (await enviar(T.legendaQr, qr)) {
        limpar = true;
        return;
      }
      // QR não coube neste turno: sai no próximo, antes de qualquer outra coisa.
      proximo.etapa = 'qr';
      proximo.qrPendente = r.servico;
      return;
    }
    if (r.relatorio.pronto) {
      if (await enviar(T.pronto)) limpar = true;
      return;
    }
    if (await enviar(T.naoPronto(r.relatorio.eta))) limpar = true;
  };

  const rotaPathology = async (): Promise<void> => {
    proximo.servico = 'pathology';
    if (cfgQ === null) {
      // Qmarksoft indisponível: checagem é ato humano (Caso B/Section 3.5).
      await enviar(T.verificarPelaEquipe);
      await entregar('qmarksoft indisponível — status exige checagem manual.');
      return;
    }
    const r = await consultarPaciente(cfgQ, { telefone: deps.telefone }, { fetch: deps.fetchDeRede ?? fetch, log: deps.log });
    await resolverConsulta(r);
  };

  const resolverConsulta = async (r: ResultadoQmarksoft, jaTentouNome = false): Promise<void> => {
    if (r.status === 'ok') {
      await rotaVerificada(r);
      return;
    }
    if ((r.status === 'nao_encontrado' || r.status === 'ambiguo') && !jaTentouNome) {
      // Primeira tentativa não cashou: pede o MÍNIMO adicional (nome) uma vez.
      proximo.etapa = 'nome';
      proximo.tentativas = 0;
      await enviar(T.perguntarNome);
      return;
    }
    if (r.status === 'nao_encontrado' || r.status === 'ambiguo') {
      // Segunda tentativa (com nome) segue sem casamento inequívoco: nunca
      // perguntar o mesmo nome para sempre e nunca afirmar status — humano.
      await enviar(T.identificacaoFalhou);
      await entregar(`identificação segue ambígua após nome informado (${r.status}) — checagem manual.`);
      return;
    }
    // timeout / indisponível: NUNCA status inventado — humano.
    await enviar(T.falhaDoSistema);
    await entregar(`qmarksoft ${r.status}: sem resposta confiável — status não afirmado.`);
  };

  const rotaDeServico = async (servico: Servico): Promise<void> => {
    if (servico === 'pathology') {
      await rotaPathology();
      return;
    }
    // Biopsy/radiologia: o único candidato de API é o próprio Qmarksoft
    // (contrato com `service`). Sem ele — ou sem casamento para este serviço —
    // vale a coleta de dados → humano.
    if (cfgQ !== null) {
      const r = await consultarPaciente(cfgQ, { telefone: deps.telefone }, { fetch: deps.fetchDeRede ?? fetch, log: deps.log });
      if (r.status === 'ok' && r.servico === servico) {
        await rotaVerificada(r);
        return;
      }
    }
    await rotaDeColeta(servico, coletarDoTexto(texto, servico, estado.detalhes ?? {}, null));
  };

  const processarInicio = async (): Promise<void> => {
    const servicoExplicito = detectarServico(texto);
    if (servicoExplicito !== null) {
      await rotaDeServico(servicoExplicito);
      return;
    }
    if (cfgQ !== null) {
      const r = await consultarPaciente(cfgQ, { telefone: deps.telefone }, { fetch: deps.fetchDeRede ?? fetch, log: deps.log });
      await resolverConsulta(r);
      return;
    }
    // Qmarksoft indisponível: Case B — mensagem de registro prévia estabelece
    // a categoria; sem ela, Case C — pergunta a categoria.
    const registro = servicoDaMensagemDeRegistro(await deps.buscarHistorico());
    if (registro === null) {
      proximo.etapa = 'categoria';
      await enviar(variante(deps.leadId, T.perguntarCategoria));
      return;
    }
    if (registro === 'pathology') {
      await enviar(T.verificarPelaEquipe);
      await entregar('qmarksoft indisponível; histórico de registro estabelece paciente de patologia — checagem manual.');
      return;
    }
    await rotaDeColeta(registro, coletarDoTexto(texto, registro, {}, null));
  };

  // ---- máquina de etapas ---------------------------------------------------

  switch (estado.etapa) {
    case 'qr': {
      // O QR adiado sai PRIMEIRO; depois a mensagem de hoje segue o caminho
      // normal (se for só um "ok", o turno do QR encerra o fluxo).
      const tipo: TipoQr = estado.qrPendente === 'biopsy' ? 'biopsy' : 'pathology';
      const qr = await deps.prepararQr(tipo);
      if (qr !== null) await enviar(T.legendaQr, qr);
      delete proximo.qrPendente;
      if (ehLaudo || detectarServico(texto) !== null || respostaDeServico(texto) !== null) {
        proximo.etapa = 'inicio';
        await processarInicio();
      } else {
        limpar = true;
      }
      break;
    }
    case 'categoria': {
      const escolhido = respostaDeServico(texto);
      if (escolhido === null) {
        // Não é resposta de serviço: repete a pergunta UMA vez por mensagem
        // recebida (dentro do teto) — nunca a mesma frase se o paciente
        // respondeu e o campo já avançou.
        await enviar(variante(deps.leadId, T.perguntarCategoria));
        break;
      }
      if (escolhido === 'pathology') {
        await rotaPathology();
        break;
      }
      await rotaDeColeta(escolhido, coletarDoTexto(texto, escolhido, estado.detalhes ?? {}, null));
      break;
    }
    case 'nome': {
      if (!ehPreenchimentoUtil(texto)) {
        const tentativas = (estado.tentativas ?? 0) + 1;
        proximo.tentativas = tentativas;
        if (tentativas >= 3) {
          await enviar(T.naoEntendi);
          await entregar('nome não identificado após 3 tentativas — identificação ambígua, checagem manual.');
          break;
        }
        await enviar(T.perguntarNome);
        break;
      }
      if (cfgQ === null) {
        await enviar(T.falhaDoSistema);
        await entregar('qmarksoft deixou de responder entre turnos — checagem manual.');
        break;
      }
      const r = await consultarPaciente(
        cfgQ,
        { telefone: deps.telefone, nome: texto.slice(0, 120) },
        { fetch: deps.fetchDeRede ?? fetch, log: deps.log },
      );
      await resolverConsulta(r, true);
      break;
    }
    case 'coleta': {
      const servico = (estado.servico === 'biopsy' || estado.servico === 'radiology' ? estado.servico : null);
      if (servico === null) {
        await entregar('estado de coleta sem serviço — dado perdido, checagem manual.');
        break;
      }
      if (!ehPreenchimentoUtil(texto)) {
        const tentativas = (estado.tentativas ?? 0) + 1;
        proximo.tentativas = tentativas;
        if (tentativas >= 3) {
          await enviar(T.naoEntendi);
          await entregar(`respostas não úteis x3 na coleta de ${servico} — passagem com o que havia.`);
          break;
        }
        const pendente = (estado.pendente ?? null) as CampoColetado | null;
        if (pendente !== null) await enviar(perguntaDe(servico, pendente));
        break;
      }
      const detalhes = coletarDoTexto(texto, servico, estado.detalhes ?? {}, (estado.pendente ?? null) as CampoColetado | null);
      proximo.detalhes = detalhes;
      proximo.tentativas = 0;
      const pendente = proximoPendente(servico, detalhes);
      if (pendente === null) {
        await enviar(T.detalhesAnotados);
        await entregar(`coleta completa: ${JSON.stringify(detalhes)}`);
        break;
      }
      proximo.pendente = pendente;
      await enviar(perguntaDe(servico, pendente));
      break;
    }
    case 'inicio':
    case 'encerrado':
    default: {
      await processarInicio();
      break;
    }
  }

  // Encerrado NÃO apaga a chave: o marcador da mensagem é a trava de retry
  // (sem resposta/entrega duplicada), e os detalhes coletados vão junto na
  // passagem — no registro ficam só os campos sem PII.
  const final: EstadoFluxo = limpar
    ? { v: 1, msg: proximo.msg, processando: false, etapa: 'encerrado', idioma: proximo.idioma }
    : { ...proximo, processando: false };
  await salvarEstado(deps.db, ids, final);
  deps.log.info('fluxo de laudo: turno processado', {
    etapa_final: limpar ? 'encerrado' : proximo.etapa,
    acoes,
    idioma: estado.idioma,
    // NUNCA texto do paciente nem valores coletados no log (PII-out-of-log).
  });
  return { engajado: true, acoes };
}

function hashDoTexto(texto: string): string {
  return `texto:${createHash('sha256').update(texto).digest('hex').slice(0, 24)}`;
}
