/**
 * QR FIXO de pagamento (Apex PathLabs): duas imagens ESTÁTICAS — uma de
 * pathology, uma de biopsy — referenciadas por configuração, nunca geradas a
 * partir do valor em aberto, nunca modificadas. O valor verificado sai em
 * mensagem de TEXTO separada; a imagem sai em seguida, sem legenda de valor
 * (o QR não "contém" o valor e escanear não prova pagamento — a política do
 * fluxo deixa isso explícito no texto).
 *
 * Configuração (pendente de upload pelos donos — sem ela nada é enviado, e
 * NUNCA se manda placeholder nem a imagem do outro serviço):
 *   APEX_QR_PATHOLOGY='bucket/caminho/qr-pathology.png'
 *   APEX_QR_BIOPSY='bucket/caminho/qr-biopsy.png'
 * Qualquer bucket serve: o arquivo é COPIADO para a pasta da conversa em
 * `whatsapp-media` (mesma mecânica das fotos de catálogo) e enviado por lá —
 * cópia falhou (arquivo ainda não existe) = imagem pendente, sem envio.
 */
import { mimeDaFoto } from '@/lib/catalogo/fotos';
import { createAdminClient } from '@/lib/supabase/admin';

import type { Log } from './workflow';

export interface AtivoQr {
  bucket: string;
  caminho: string;
  mime: string;
}

export type TipoQr = 'pathology' | 'biopsy';

const BUCKET_DA_CONVERSA = 'whatsapp-media';

function parseAtivo(valor: string | undefined): AtivoQr | null {
  const bruto = (valor ?? '').trim();
  const corte = bruto.indexOf('/');
  if (corte <= 0 || corte === bruto.length - 1) return null;
  return { bucket: bruto.slice(0, corte).trim(), caminho: bruto.slice(corte + 1).trim(), mime: mimeDaFoto(bruto) };
}

/** Lê os dois ativos da env. Ausente = null (imagem pendente de upload). */
export function ativosDeQr(env: Record<string, string | undefined>): Record<TipoQr, AtivoQr | null> {
  return {
    pathology: parseAtivo(env.APEX_QR_PATHOLOGY),
    biopsy: parseAtivo(env.APEX_QR_BIOPSY),
  };
}

/** Copia origem → pasta da conversa em `whatsapp-media`. true = arquivo pronto no destino. */
export type CopiarQr = (origem: { bucket: string; caminho: string }, destino: string) => Promise<boolean>;

export function copiarQrNoStorage(log: Log): CopiarQr {
  return async (origem, destino) => {
    const { error } = await createAdminClient()
      .storage.from(origem.bucket)
      .copy(origem.caminho, destino, { destinationBucket: BUCKET_DA_CONVERSA });
    if (!error) return true;
    // Já copiado antes nesta conversa: o arquivo que precisamos está lá.
    if (/already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === '409') {
      return true;
    }
    log.warn('qr: ativo não copiado para a conversa', {
      bucket: origem.bucket,
      detalhe: error.message.slice(0, 120),
    });
    return false;
  };
}

/**
 * Deixa o QR pronto na pasta da conversa. `null` = ativo não configurado ou
 * não copiado (arquivo ainda não enviado) — quem chama NÃO manda placeholder
 * nem imagem de outro serviço: fica registrado como dependência pendente.
 */
export async function prepararQrNaConversa(
  ativo: AtivoQr | null,
  ids: { tenantId: string; conversationId: string },
  copiar: CopiarQr,
): Promise<{ storagePath: string; mime: string } | null> {
  if (ativo === null) return null;
  const arquivo = ativo.caminho.split('/').pop() ?? 'qr.png';
  // Destino determinístico (mesma disciplina das fotos de catálogo): replay do
  // job ou reenvio na mesma conversa reaproveita o arquivo, sem duplicar quota.
  const destino = `${ids.tenantId}/${ids.conversationId}/qr-${arquivo}`;
  if (!(await copiar({ bucket: ativo.bucket, caminho: ativo.caminho }, destino))) return null;
  return { storagePath: destino, mime: ativo.mime };
}
