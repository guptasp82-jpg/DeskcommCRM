import { describe, expect, it } from "vitest";
import pg from "pg";

import { regrasIncondicionaisDeIdioma, temPoliticaCanonica } from "../support/politica-de-idioma";

/**
 * A POLÍTICA DE IDIOMA CANÔNICA NAS CAMADAS ATIVAS DESTA IMPLANTAÇÃO.
 *
 * O teste irmão `linguagem-de-resposta-canonica.test.ts` protege as FONTES em
 * arquivo. Este protege as camadas que só existem em banco — o que o run de
 * verdade LÊ:
 *
 *   1. camada platform do playbook (playbook_pointers → playbook_versions);
 *   2. memória da organização (org_memory_pointers → org_memory_versions);
 *   3. o prompt do rascunho do agente (ai_agent_versions.system_prompt).
 *
 * ## Por que a condicional de implantação
 *
 * As invariantes de banco deste repositório rodam num Postgres EFÊMERO
 * (`pnpm test:db`), sem os dados reais da implantação — e a suíte unitária não
 * tem banco próprio. Estas linhas só existem no banco da implantação, então o
 * arquivo inteiro salta quando (a) não há `SUPABASE_DB_URL`, ou (b) o rascunho
 * do agente desta implantação não está presente. Onde ele existe, as três
 * asserções rodam de verdade — inclusive contra rollback do ponteiro.
 */
const ORGANIZACAO = "b90aaaba-4dd9-40a8-95f2-c876689488fe";
const AGENTE = "a8c12e00-8bd9-46c3-9798-88b615751573";
const RASCUNHO = "e7282b0c-28d3-426f-a347-00696c3cf97f";

type CamadasAtivas = {
  ponteirosPlatform: number;
  platformConteudo: string;
  platformVersionId: string;
  orgVersionNumber: number;
  orgConteudo: string;
  orgTotalVersoes: number;
  promptAgente: string;
  statusAgente: string;
};

async function capturarCamadas(): Promise<CamadasAtivas | null> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) return null;
  const db = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const platform = await db.query<{ count: string }>(
      `select count(*)::text as count
         from playbook_pointers
        where organization_id is null and layer = 'platform'`,
    );
    const platformAtiva = await db.query<{ version_id: string; content: string }>(
      `select p.version_id, v.content
         from playbook_pointers p
         join playbook_versions v on v.id = p.version_id
        where p.organization_id is null and p.layer = 'platform'`,
    );
    const org = await db.query<{ version_number: number; content: string; total: string }>(
      `select v.version_number, v.content,
              (select count(*)::text from org_memory_versions where organization_id = $1) as total
         from org_memory_pointers p
         join org_memory_versions v on v.id = p.version_id
        where p.organization_id = $1`,
      [ORGANIZACAO],
    );
    const agente = await db.query<{ system_prompt: string; status: string }>(
      `select system_prompt, status from ai_agent_versions where id = $1 and agent_id = $2`,
      [RASCUNHO, AGENTE],
    );
    const linhaPlatform = platformAtiva.rows[0];
    const linhaOrg = org.rows[0];
    const linhaAgente = agente.rows[0];
    if (!linhaPlatform || !linhaOrg || !linhaAgente) {
      return null; // implantação com dados diferentes: fora do escopo deste teste
    }
    return {
      ponteirosPlatform: Number(platform.rows[0]?.count ?? 0),
      platformConteudo: linhaPlatform.content,
      platformVersionId: linhaPlatform.version_id,
      orgVersionNumber: linhaOrg.version_number,
      orgConteudo: linhaOrg.content,
      orgTotalVersoes: Number(linhaOrg.total),
      promptAgente: linhaAgente.system_prompt,
      statusAgente: linhaAgente.status,
    };
  } catch {
    return null; // sem banco alcançável: o teste irmão de fonte continua de pé
  } finally {
    await db.end();
  }
}

const camadas = await capturarCamadas();

describe.skipIf(!camadas)("política canônica nas camadas ativas desta implantação", () => {
  it("camada platform: exatamente um ponteiro ativo, com a política canônica", () => {
    expect(camadas!.ponteirosPlatform).toBe(1);
    expect(temPoliticaCanonica(camadas!.platformConteudo)).toBe(true);
    expect(regrasIncondicionaisDeIdioma(camadas!.platformConteudo)).toEqual([]);
  });

  it("memória da organização: política canônica ativa e histórico preservado", () => {
    expect(temPoliticaCanonica(camadas!.orgConteudo)).toBe(true);
    expect(regrasIncondicionaisDeIdioma(camadas!.orgConteudo)).toEqual([]);
    expect(camadas!.orgTotalVersoes).toBeGreaterThanOrEqual(2);
    expect(camadas!.orgVersionNumber).toBeGreaterThanOrEqual(2);
  });

  it("prompt do rascunho do agente: política canônica, ainda em draft", () => {
    expect(camadas!.statusAgente).toBe("draft");
    expect(temPoliticaCanonica(camadas!.promptAgente)).toBe(true);
    expect(regrasIncondicionaisDeIdioma(camadas!.promptAgente)).toEqual([]);
  });
});
