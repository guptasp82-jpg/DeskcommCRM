import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatFaqChunk, parseFaqMarkdown } from "./faq";

/**
 * Regression for the live-pilot clarification scenario
 * ("Lipid profile price only no CBC", 2026-10-11): the approved pricing FAQ
 * must answer the lipid question directly, keep every figure sourced, and
 * defer everything that is not on the approved list. The file is the source of
 * truth for the price-bearing items of the live FAQ knowledge source; it is
 * parsed here with the SAME parser the ingestion pipeline uses.
 */
const MD_PATH = fileURLToPath(
  new URL("../../../../docs/knowledge/apex-pathlabs-pricing-faq.md", import.meta.url),
);
const items = parseFaqMarkdown(readFileSync(MD_PATH, "utf8"));

/** Rupee figures verified on the laboratory's website on 2026-10-11. */
const APPROVED_RUPEE_FIGURES = new Set(["400", "550", "600", "2000", "2500"]);

describe("Apex PathLabs approved pricing FAQ (clarification-scenario regression)", () => {
  it("answers the lipid price question directly: Rs 600, 7 tests, CBC explicitly excluded", () => {
    const lipid = items.find((i) => /lipid profile/i.test(i.question));
    expect(lipid, "the Lipid Profile price item must exist").toBeDefined();
    expect(lipid!.answer).toContain("Rs 600");
    expect(lipid!.answer).toMatch(/7 tests/i);
    // "Lipid profile price only no CBC" — the answer pre-empts the mix-up.
    expect(lipid!.answer).toMatch(/does not include CBC/i);
  });

  it("keeps the test name and its price inside the SAME embedding chunk", () => {
    const lipid = items.find((i) => /lipid profile/i.test(i.question))!;
    const chunk = formatFaqChunk(lipid);
    expect(chunk).toContain("Lipid Profile");
    expect(chunk).toContain("Rs 600");
  });

  it("stamps the verification date on every price-bearing answer", () => {
    const priced = items.filter((i) => /\bRs\s?\d/.test(i.answer));
    expect(priced.length).toBeGreaterThanOrEqual(3);
    for (const item of priced) expect(item.answer).toContain("checked on 2026-10-11");
  });

  it("contains ONLY website-approved rupee figures", () => {
    const text = items.map((i) => `${i.question}\n${i.answer}`).join("\n");
    const figures = [...text.matchAll(/Rs\s?(\d+)/g)].map((m) => m[1]);
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(APPROVED_RUPEE_FIGURES.has(figure), `unapproved figure: Rs ${figure}`).toBe(true);
    }
  });

  it("defers every test NOT on the approved list to the website or the team", () => {
    const generic = items.find((i) => /\[test name\]/i.test(i.question));
    expect(generic, "the generic price item must exist").toBeDefined();
    expect(generic!.answer).toMatch(/not listed here/i);
    expect(generic!.answer).toContain("www.apexpathlabs.com");
  });

  it("uses locale en on every item", () => {
    for (const item of items) expect(item.locale).toBe("en");
  });
});
