import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RAW_DIR } from "../config.js";
import { chunkDoc } from "../chunk.js";
import { normalisePara, parseLawDoc } from "./parse.js";

const file = (rel: string) => path.join(RAW_DIR, rel);
const EKTESKAPSLOVEN = "gjeldende-lover/nl/nl-19910704-047.xml";
const TEK17 = "gjeldende-sentrale-forskrifter/sf/sf-20170619-0840.xml";

test("normalisePara", () => {
  assert.equal(normalisePara("§ 1 a"), "1a");
  assert.equal(normalisePara("§12-7"), "12-7");
});

test("ekteskapsloven: metadata og paragrafer", { skip: !existsSync(file(EKTESKAPSLOVEN)) }, () => {
  const doc = parseLawDoc(readFileSync(file(EKTESKAPSLOVEN), "utf8"), "nl");
  assert.equal(doc.dokId, "LOV-1991-07-04-47");
  assert.equal(doc.korttittel, "Ekteskapsloven");
  assert.equal(doc.forkortelse, "el");
  assert.equal(doc.type, "lov");
  assert.equal(doc.endringsdokument, false);
  const p58 = doc.sections.find((s) => s.paragrafNorm === "58");
  assert.ok(p58, "§ 58 finnes");
  assert.match(p58.tekst, /deles likt/);
  assert.ok(p58.kapittel.some((k) => /Kapittel/.test(k)));
  assert.equal(p58.url, "https://lovdata.no/lov/1991-07-04-47/§58");
  // change history is kept out of the legal text
  assert.ok(!doc.sections.some((s) => /^Endret ved/m.test(s.tekst)));
});

test("TEK17: forkortelse, listepunkter og stabile ID-er", { skip: !existsSync(file(TEK17)) }, () => {
  const xml = readFileSync(file(TEK17), "utf8");
  const doc = parseLawDoc(xml, "sf");
  assert.equal(doc.forkortelse, "TEK17");
  assert.equal(doc.type, "forskrift");
  const p = doc.sections.find((s) => s.paragrafNorm === "12-7");
  assert.match(p!.tekst, /a\. Rom for varig opphold skal ha høyde minimum 2,4 m/);
  const a = chunkDoc(doc).map((c) => c.id);
  const b = chunkDoc(parseLawDoc(xml, "sf")).map((c) => c.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

const GRL_NB = "gjeldende-lover/nl/nl-18140517-000.xml";
const GRL_NN = "gjeldende-lover/nl/nl-18140517-000-nn.xml";
test("Grunnloven: bokmål og nynorsk får ulike ID-er", { skip: !existsSync(file(GRL_NN)) }, () => {
  const nb = parseLawDoc(readFileSync(file(GRL_NB), "utf8"), "nl");
  const nn = parseLawDoc(readFileSync(file(GRL_NN), "utf8"), "nl", path.basename(GRL_NN));
  assert.equal(nb.dokId, "LOV-1814-05-17");
  assert.equal(nn.dokId, "LOV-1814-05-17-nn");
  const ids = new Set(chunkDoc(nb).map((c) => c.id));
  assert.ok(!chunkDoc(nn).some((c) => ids.has(c.id)));
});

const OPPLARINGSLOVA = "gjeldende-lover/nl/nl-20230609-030.xml";
test("lover som bare finnes på nynorsk beholder sin ID", { skip: !existsSync(file(OPPLARINGSLOVA)) }, () => {
  const doc = parseLawDoc(readFileSync(file(OPPLARINGSLOVA), "utf8"), "nl", path.basename(OPPLARINGSLOVA));
  assert.equal(doc.dokId, "LOV-2023-06-09-30");
  assert.equal(doc.sprak, "nn");
  assert.equal(doc.parallellversjon, false);
});
