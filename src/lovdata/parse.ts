import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export type DocType = "lov" | "forskrift" | "delegering" | "instruks" | "stortingsvedtak";

export interface LawDoc {
  /** Lovdata datokode, e.g. LOV-1991-07-04-47 / FOR-2017-06-19-840 */
  dokId: string;
  /** e.g. lov/1991-07-04-47 — also the path on lovdata.no */
  refId: string;
  type: DocType;
  tittel: string;
  /** e.g. "Ekteskapsloven" (without the abbreviation) */
  korttittel: string;
  /** e.g. "el", "tvl", "TEK17" */
  forkortelse?: string;
  departement: string[];
  rettsomrade: string[];
  iKraftFra?: string;
  sisteEndringIKraft?: string;
  sistEndretVed?: string;
  hjemmel?: string;
  /** Language form of the text (many laws are written in nynorsk only) */
  sprak: "nb" | "nn";
  /** A second language version of a document that also exists in bokmål (Grunnlova: nl-18140517-000-nn.xml) */
  parallellversjon: boolean;
  /** "Lov om endringer i ..." etc. — the text describes changes to other documents */
  endringsdokument: boolean;
  url: string;
  sections: LawSection[];
}

export interface LawSection {
  /** Stable key within the document, used to derive the point ID */
  key: string;
  /** "§ 58" for legal articles, otherwise a heading or "Innledning" */
  paragraf: string;
  /** Normalised paragraph number for exact lookup: "58", "1a", "12-7" */
  paragrafNorm?: string;
  overskrift?: string;
  /** Chapter path, e.g. ["Del III. ...", "Kapittel 12. ..."] */
  kapittel: string[];
  tekst: string;
  /** Lovdata change history notes ("Endret ved lov ...") */
  endringshistorikk?: string;
  url: string;
}

const BLOCK = new Set([
  "article", "p", "li", "ol", "ul", "section", "footer", "table", "tr", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "br", "blockquote",
]);

export function normalisePara(p: string): string {
  return p.replace(/§/g, "").replace(/\s+/g, "").toLowerCase();
}

/** Plain text with line breaks between block elements and list labels preserved. */
export function nodeText(node: AnyNode, skip: (el: Element) => boolean): string {
  if (node.type === "text") return (node as unknown as { data: string }).data;
  if (!("children" in node)) return "";
  const el = node as Element;
  if (el.type === "tag" || el.type === "script" || el.type === "style") {
    if (skip(el)) return "";
    if (el.name === "br") return "\n";
  }
  let inner = el.children.map((c) => nodeText(c, skip)).join("");
  if (el.name === "li" && el.attribs?.["data-name"]) inner = `${el.attribs["data-name"]} ${inner.replace(/^\s+/, "")}`;
  if (el.name === "td" || el.name === "th") inner = `${inner} | `;
  return el.name && BLOCK.has(el.name) ? `\n${inner}\n` : inner;
}

export function clean(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function classIs(el: Element, ...names: string[]): boolean {
  const cls = (el.attribs?.class ?? "").split(/\s+/);
  return names.some((n) => cls.includes(n));
}

function typeFor(dokId: string, subdir: string): DocType {
  if (dokId.startsWith("LOV-")) return "lov";
  if (subdir === "del") return "delegering";
  if (subdir === "ins") return "instruks";
  if (subdir === "stv") return "stortingsvedtak";
  return "forskrift";
}

/**
 * Parses one Lovdata XML/HTML document.
 * @param subdir the dataset sub-directory (nl, sf, del, ins, stv)
 * @param fileName used to recognise parallel language versions ("…-nn.xml")
 */
export function parseLawDoc(xml: string, subdir: string, fileName = ""): LawDoc {
  const $ = cheerio.load(xml);
  const dd = (cls: string) => clean($(`header dd.${cls}`).first().text());
  const ddList = (cls: string) =>
    $(`header dd.${cls} li`)
      .map((_, li) => clean($(li).text()))
      .get()
      .filter(Boolean);

  const sprak = $("html").attr("lang") === "nn" ? "nn" : "nb";
  // a parallel version shares legacyID/refid with the bokmål document, so it needs an ID of its own
  const parallellversjon = /-nn\.xml$/.test(fileName);
  const dokId = parallellversjon ? `${dd("legacyID")}-nn` : dd("legacyID");
  const refId = dd("refid");
  const tittel = dd("title") || clean($("title").text());
  const short = dd("titleShort");
  const [korttittel, forkortelse] = short.includes(" – ")
    ? (short.split(" – ", 2) as [string, string])
    : [short || tittel, undefined];
  const tekPattern = /\(([A-ZÆØÅ0-9-]{2,})\)\s*$/; // "Byggteknisk forskrift (TEK17)"
  const url = `https://lovdata.no/${refId}`;

  const departement = ddList("ministry");
  const doc: LawDoc = {
    dokId,
    refId,
    type: typeFor(dokId, subdir),
    sprak,
    parallellversjon,
    tittel,
    korttittel,
    forkortelse: forkortelse ?? korttittel.match(tekPattern)?.[1],
    departement: departement.length ? departement : [dd("ministry")].filter(Boolean),
    rettsomrade: ddList("legalArea"),
    iKraftFra: dd("dateInForce") || undefined,
    sisteEndringIKraft: dd("lastChangeInForce") || undefined,
    sistEndretVed: dd("lastChangedBy") || undefined,
    hjemmel:
      $("header dd.basedOn a")
        .map((_, a) => clean($(a).text()))
        .get()
        .join(", ") || dd("basedOn") || undefined,
    endringsdokument: /^(Lov|Forskrift|Forskrifter)\s+om\s+(endring|oppheving|opphevelse)/i.test(tittel),
    url,
    sections: [],
  };

  const usedKeys = new Map<string, number>();
  const uniqueKey = (k: string) => {
    const n = usedKeys.get(k) ?? 0;
    usedKeys.set(k, n + 1);
    return n ? `${k}~${n + 1}` : k;
  };

  const skipHistory = (el: Element) => classIs(el, "changesToParent", "legalArticleHeader");

  const pushArticle = (el: Element, kapittel: string[]) => {
    const $el = $(el);
    const value = clean($el.find("> .legalArticleHeader .legalArticleValue").first().text());
    const title = clean($el.find("> .legalArticleHeader .legalArticleTitle").first().text()) || undefined;
    const dataName = el.attribs["data-name"] ?? value;
    const history = $el
      .children(".changesToParent")
      .map((_, c) => clean($(c).text()))
      .get()
      .join("\n");
    const anchor = (el.attribs["data-lovdata-url"] ?? el.attribs["data-lovdata-URL"] ?? "").split("/").pop();
    doc.sections.push({
      key: uniqueKey(`${kapittel.at(-1) ?? ""}|${dataName}`),
      paragraf: value || dataName,
      paragrafNorm: normalisePara(value || dataName),
      overskrift: title,
      kapittel,
      tekst: clean(nodeText(el, skipHistory)),
      endringshistorikk: history || undefined,
      url: anchor?.startsWith("§") ? `${url}/${anchor}` : url,
    });
  };

  const walk = (container: Element, kapittel: string[]) => {
    let loose: AnyNode[] = [];
    let looseIndex = 0;
    const flush = () => {
      const text = clean(loose.map((n) => nodeText(n, skipHistory)).join("\n"));
      loose = [];
      if (!text) return;
      const label = kapittel.at(-1) ?? "Innledning";
      doc.sections.push({
        key: uniqueKey(`${kapittel.join(" > ")}|tekst${looseIndex++}`),
        paragraf: label,
        kapittel,
        tekst: text,
        url,
      });
    };
    for (const child of container.children) {
      if (child.type !== "tag") {
        loose.push(child);
        continue;
      }
      const el = child as Element;
      if (el.name === "section") {
        flush();
        const heading = $(el).children("h1,h2,h3,h4,h5,h6").first();
        walk(el, heading.length ? [...kapittel, clean(heading.text())] : kapittel);
      } else if (classIs(el, "legalArticle")) {
        flush();
        pushArticle(el, kapittel);
      } else if (/^h[1-6]$/.test(el.name) && container.name === "section") {
        // section heading — already part of the chapter path
      } else if (el.name === "h1") {
        // document title
      } else {
        loose.push(el);
      }
    }
    flush();
  };

  const main = $("main.documentBody").get(0);
  if (main) walk(main as Element, []);
  return doc;
}
