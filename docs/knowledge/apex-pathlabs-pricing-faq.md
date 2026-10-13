---
locale: en
tags: [precos, pricing, apex]
---

# Apex PathLabs — Approved Pricing FAQ (source of truth)

<!--
Approved pricing knowledge for the WhatsApp agent. Every rupee figure below was
taken from the laboratory's own published website (www.apexpathlabs.com,
homepage + test detail pages) on the verification date in the answers. Never
add, change or extrapolate a price here without re-verifying it against the
website (or an owner approval) and updating the "checked on" date.

This file holds the PRICE-BEARING items of the live FAQ knowledge source
("Apex PathLabs - Patient FAQs"). The remaining non-price items (address,
hours, TAT, reports, safety, …) live only in the CRM and are not price claims.
The regression test at lib/ai/rag/ingest/faq-pricing.test.ts parses this file
with the SAME parser the ingestion pipeline uses and guards the exact
clarification scenario: "Lipid profile price only no CBC".

The live source is updated through the supported API:
PATCH /api/v1/ai/knowledge/sources/{id} (full items replace) + reindex.
-->

## Pergunta: What is the price of CBC? / CBC ka kitna charge hai? / सीबीसी का कितना चार्ज है?
## Resposta: CBC (Complete Blood Count) is Rs 400 and includes 14 parameters, as published on our website (checked on 2026-10-11). Free home collection applies within 10 km of the laboratory.

## Pergunta: What is the Lipid Profile price? / Lipid profile ka kitna charge hai? / लिपिड प्रोफाइल का कितना चार्ज है?
## Resposta: The Lipid Profile costs Rs 600 and includes 7 tests (Total Cholesterol, HDL-Cholesterol, LDL-Cholesterol, VLDL-Cholesterol, Triglycerides, Total Choles./H.D.L Ratio, and LDL/H.D.L Ratio), as published on our website (checked on 2026-10-11). This price is for the Lipid Profile only — it does not include CBC. If you also want CBC, it is Rs 400 (14 parameters). Free home collection applies within 10 km of the laboratory.

## Pergunta: What is the price of [test name]?
## Resposta: These prices are published on our website and can be quoted directly (checked on 2026-10-11): Lipid Profile Rs 600; CBC Rs 400; Kidney Function Test (KFT) Rs 600; Thyroid Profile Rs 550; Liver Function Test (LFT) Rs 550 (website shows MRP Rs 600); TORCH Profile Rs 2000 (website shows MRP Rs 2500). For any test not listed here, please check its test page on www.apexpathlabs.com or ask our team on WhatsApp for the current price — I don't want to quote you an old or wrong number.

## Pergunta: Do you have any discounts or offers? / Koi discount mil sakta hai?
## Resposta: Our website lists current promotional prices on some profiles and health packages. I cannot create or promise any additional discount; our team can confirm what applies to your booking.
