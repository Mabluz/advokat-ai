import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkDecision, decisionMeta, extractFileText, metaWarnings } from "./parse.js";

// Synthetic decision (fictional case number) mimicking the Lovdata page layout
const SAMPLE = [
  "Instans",
  "Norges Høyesterett – Dom",
  "Dato",
  "2099-01-15",
  "Publisert",
  "HR-2099-1-A",
  "Stikkord",
  "Naborett. Gjerde. Grannelova § 2.",
  "Sammendrag",
  "Saken gjaldt (fiktivt) om naboens gjerde var urimelig til skade.",
  ...Array.from({ length: 60 }, (_, i) => `(${i + 1}) ${"Avsnittstekst om gjerde og nabo. ".repeat(4)}`),
].join("\n");

test("metadata fra Lovdata-format", () => {
  const m = decisionMeta(SAMPLE, "x.html");
  assert.equal(m.saksnummer, "HR-2099-1-A");
  assert.equal(m.domstol, "Norges Høyesterett");
  assert.equal(m.avgjorelsestype, "Dom");
  assert.equal(m.dato, "2099-01-15");
  assert.equal(m.stikkord, "Naborett. Gjerde. Grannelova § 2.");
});

test("domstol utledes av saksnummer når Instans mangler", () => {
  assert.equal(decisionMeta("LB-2099-12345\nTekst", "a.txt").domstol, "Borgarting lagmannsrett");
  assert.equal(decisionMeta("TOSLO-2099-1234\nTekst", "a.txt").domstol, "Tingrett");
  assert.equal(decisionMeta("Ingen nummer her", "TRR-2099-77.pdf").saksnummer, "TRR-2099-77");
});

test("chunking med avsnittsnummer og stabile ID-er", () => {
  const a = chunkDecision(SAMPLE, "x.html", "h");
  assert.ok(a.length > 1);
  assert.match(a[1].payload.avsnitt!, /^\(\d+\)–\(\d+\)$/);
  assert.equal(a[0].payload.lovdata_url, "https://lovdata.no/frisok?q=HR-2099-1-A");
  assert.deepEqual(a.map((c) => c.id), chunkDecision(SAMPLE, "x.html", "h").map((c) => c.id));
});

test("HTML-uttrekk fjerner script og navigasjon", async () => {
  const html = `<html><body><nav>Meny</nav><main><p>HR-2099-1-A</p><p>Selve dommen.</p></main><script>x()</script></body></html>`;
  const t = await extractFileText("a.html", Buffer.from(html));
  assert.equal(t, "HR-2099-1-A\nSelve dommen.");
});

test("Lovdata PDF-utskrift: flerlinjefelt, Rt-referanse og URL", () => {
  const pdfText = [
    "HR-2099-7-U – Rt-2099-100 \u06C8\u0626",
    "Instans Norges Høyesteretts ankeutvalg – Kjennelse.",
    "Dato 2099-08-26",
    "Publisert HR-2099-7-U – Rt-2099-100",
    "Stikkord Tingsrett. Gjerdeskjønn.",
    "Sammendrag Første linje av sammendraget",
    "fortsetter på neste linje.",
    "Henvisninger: Grannegjerdelova (1961) §14",
    "Saksgang Tingrett TSOSU-2099-1 – Høyesterett HR-2099-7-U.",
    "Henvisninger i teksten Tvisteloven (2005) §20-2",
    "(1) Første avsnitt.",
    "22/10/2026, 00:01 Norges Høyesteretts ankeutvalg - Kjennelse.: HR-2099-7-U - Rt-2099-100 - Lovdata",
    "https://lovdata.no/dokument/HRSIV/avgjorelse/hr-2099-7-u/ 1/4",
    "(2) Andre avsnitt.",
  ].join("\n");
  const m = decisionMeta(pdfText, "x.pdf");
  assert.equal(m.rt_ref, "Rt-2099-100");
  assert.equal(m.domstol, "Norges Høyesteretts ankeutvalg");
  assert.equal(m.avgjorelsestype, "Kjennelse");
  assert.equal(m.sammendrag, "Første linje av sammendraget fortsetter på neste linje.");
  assert.equal(m.henvisninger, "Grannegjerdelova (1961) §14 | Tvisteloven (2005) §20-2");
  assert.equal(m.lovdata_url, "https://lovdata.no/dokument/HRSIV/avgjorelse/hr-2099-7-u");
});

test("lagmannsrettsdom uten avsnittsnummer: henvisninger stopper før domsteksten", () => {
  const text = [
    "LB-2099-12",
    "Instans Borgarting lagmannsrett – Dom",
    "Dato 2099-04-15",
    "Saksgang Follo tingrett TFOLL-2099-1 – Borgarting lagmannsrett LB-2099-12.",
    "Anke til Høyesterett ikke tillatt fremmet.",
    "Om rettskraft",
    "Sist oppdatert 2099-07-07",
    "Henvisninger i teksten Veglova (1963) §53 | Tvisteloven (2005) §19-8, §20-2 |",
    "Midlertidig lov om tilpasninger (2020)",
    "§8",
    "Saken gjelder tvist om veirett til en arealstripe på ca 7 m2.",
    "Sakens bakgrunn",
  ].join("\n");
  const m = decisionMeta(text, "x.pdf");
  assert.equal(m.henvisninger, "Veglova (1963) §53 | Tvisteloven (2005) §19-8, §20-2 | Midlertidig lov om tilpasninger (2020) §8");
  assert.equal(m.saksgang, "Follo tingrett TFOLL-2099-1 – Borgarting lagmannsrett LB-2099-12. Anke til Høyesterett ikke tillatt fremmet.");
});

test("advarsler ved manglende eller mistenkelig metadata", () => {
  assert.deepEqual(metaWarnings(decisionMeta(SAMPLE, "x.html"), SAMPLE), []);
  const bad = "Noe tekst uten saksnummer eller dato";
  const w = metaWarnings(decisionMeta(bad, "notat.txt"), bad);
  assert.ok(w.some((x) => x.includes("saksnummer")));
  assert.ok(w.some((x) => x.includes("dato")));
  assert.ok(w.some((x) => x.includes("lite tekst")));
});
