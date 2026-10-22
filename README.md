# Advokat

En lokal kunnskapsbase over **gjeldende norsk lovverk** (alle lover og sentrale forskrifter fra Lovdata), gjort søkbar for Claude Code via MCP. Claude svarer på juridiske spørsmål med utgangspunkt i lovtekst den faktisk har slått opp, og siterer paragrafer med lenke til Lovdata. Reglene for hvordan Claude skal oppføre seg står i [`CLAUDE.md`](CLAUDE.md).

## Hva kan advokaten hjelpe med?
> - **Familie og arv:** skilsmisse, samboerbrudd, deling av formue, barnefordeling og samvær, testament, arveoppgjør
> - **Fast eiendom og bygg:** feil og mangler ved boligkjøp, naboforhold, husleie, håndverkertjenester, byggesaker og TEK17
> - **Arbeidsliv:** oppsigelse, avskjed, arbeidstid, lønn, permisjon, arbeidsavtaler
> - **Kontrakt og forbruker:** reklamasjon, kjøp av varer og tjenester, angrerett, inkasso
> - **Tvister:** forliksrådet, frister, hvordan du går fram og hva det kan koste
> - **Strafferett:** rettighetene dine som mistenkt eller fornærmet, og hvordan straffesaker foregår
> - **Forvaltning:** klage på vedtak fra kommunen, NAV eller andre etater, innsyn
> - **Skatt og selskap:** valg av selskapsform, styreansvar, enkle skattespørsmål

## Kom i gang

Krever Node 22+, Docker med Compose og [Ollama](https://ollama.com/download) (detaljer under [Forutsetninger](#forutsetninger)).

```bash
npm install
ollama pull bge-m3            # embedding-modellen (ca. 1,2 GB)
docker compose up -d          # Qdrant på http://localhost:6343
```

Fyll så databasen på én av to måter:

```bash
# A) Har du fått en eksport: legg innholdet i import/, så tar det et par minutter
npm run import
npm run sync                  # henter endringer hos Lovdata siden eksporten

# B) Bygg alt selv: ca. 50 min, og maskinen blir varm (bruk sync:rolig for å skåne den)
npm run sync
```

Start `claude` i prosjektmappa, godkjenn MCP-serveren `norsk-lov` (sjekk med `/mcp`), og still spørsmålet ditt.

## Hva som hentes ned

Kilden er Lovdatas åpne, offisielle API ([api.lovdata.no](https://api.lovdata.no/)). Lovdata oppdaterer datasettene hver natt, og all tekst er ajourført med endringer. To datasett brukes:

| Datasett | Størrelse (pakket) |
|---|---|
| `gjeldende-lover.tar.bz2` | ca. 6 MB |
| `gjeldende-sentrale-forskrifter.tar.bz2` | ca. 21 MB |

Til sammen gir det **5888 dokumenter** (tall per oktober 2026):

| Type | Antall | Eksempler |
|---|---|---|
| Lover | 754 | ekteskapsloven, tvisteloven, plan- og bygningsloven |
| Forskrifter | 3437 | byggteknisk forskrift (TEK17), byggesaksforskriften (SAK10) |
| Delegeringsvedtak | 1428 | overføring av myndighet mellom departementer og etater |
| Instrukser | 185 | |
| Stortingsvedtak | 84 | |

Hvert dokument deles i **én chunk per paragraf**. Lange paragrafer og tekst utenfor paragrafene (innledninger og vedlegg) blir egne biter. Det gir ca. **115 800 chunks**, og det er det tallet sync-loggen teller (`embeddet 640/111771 …`). Er synken avbrutt, gjenstår bare chunkene som mangler.

```
Lovdata publicData ──npm run sync──▶ Qdrant (Docker) ◀── MCP-server ◀── Claude Code
                                        ▲
                         Ollama + bge-m3 (embeddings, lokalt)
```

## Forutsetninger

| Verktøy | Hvorfor | Installasjon |
|---|---|---|
| **Node.js 22+** | kjører sync, søk og MCP-server | `brew install node` eller [nvm](https://github.com/nvm-sh/nvm) |
| **Docker med Compose** | kjører Qdrant (vektordatabasen) | [Docker Desktop](https://www.docker.com/products/docker-desktop/), [OrbStack](https://orbstack.dev), [Colima](https://github.com/abiosoft/colima) eller Docker Engine på Linux |
| **Ollama** | lager embeddings lokalt, både ved innlesing og ved hvert søk | se under |
| **Claude Code** | «advokaten» | [claude.com/claude-code](https://claude.com/claude-code) |

### Ollama og embedding-modellen

Ollama må kjøre **direkte på maskinen** (ikke i Docker), fordi Docker på Mac ikke får tilgang til GPU-en.

```bash
# 1. Installer Ollama (eller last ned appen fra https://ollama.com/download)
brew install ollama

# 2. Start Ollama (appen starter den automatisk; uten app:)
ollama serve            # la denne kjøre i et eget vindu, eller: brew services start ollama

# 3. Hent embedding-modellen prosjektet bruker (ca. 1,2 GB)
ollama pull bge-m3

# 4. Sjekk at den svarer
curl http://localhost:11434/api/embed -d '{"model":"bge-m3","input":"test"}' | head -c 100
```

Modellen **må** være `bge-m3`. Hele indeksen er bygget med den, og søk med en annen modell gir meningsløse treff. Kjører Ollama på en annen adresse, sett `OLLAMA_URL`.

Ollama trengs også når du **bare** importerer en ferdig indeks: hvert søk gjør spørsmålet om til en vektor med bge-m3.

## Oppsett

```bash
npm install
docker compose up -d          # Qdrant på http://localhost:6343 (dashboard: /dashboard)
```

Deretter har du to valg:

**A) Importer en ferdig indeks (anbefalt, tar et par minutter).** Har du fått en eksport fra noen, legg *hele* innholdet (snapshot-filene, `docs.json`, `state.json`, `manifest.json` og eventuelt `dommer/`) i `import/` og kjør:

```bash
npm run import
npm run sync                  # henter bare det som er endret hos Lovdata siden eksporten
```

**B) Bygg alt selv (ca. 50 minutter på M4 Pro, ca. 115 000 paragrafer).**

```bash
npm run sync                  # full fart, maskinen blir varm
npm run sync:rolig            # én batch om gangen med pauser, tar ca. dobbelt så lang tid
```

Avbrytes synken, er det bare å starte den igjen. Den fortsetter der den slapp.

## Bruk

Start Claude Code i prosjektmappa. MCP-serveren `norsk-lov` er definert i [`.mcp.json`](.mcp.json). Godkjenn den første gang (sjekk med `/mcp`), og spør i vei:

> Kona og jeg skal skille oss. Huset står på meg, men hun har betalt halve lånet. Hvordan deles det?

Manuelt søk fra terminalen:

```bash
npm run search -- "krav til romhøyde i bolig"
npm run search -- --lov tvisteloven "foreldelse av krav"
npm run search -- --paragraf TEK17 12-7
```

## Rettspraksis (dommer du lagrer selv)

Dommer er gratis å lese på lovdata.no (Høyesterett og lagmannsrettene fra 2008, tingrettene fra 2016), men de finnes ikke i Lovdatas gratis API. Både lovdata.no og domstol.no sperrer automatisk nedlasting i `robots.txt`. Derfor henter prosjektet **aldri** dommer selv. Slik fungerer det i stedet:

1. Når et spørsmål avhenger av rettspraksis, gir Claude deg søkelenker til Lovdata, f.eks. `https://lovdata.no/frisok?q=grannelova%20%C2%A7%202%20gjerde`.
2. Du åpner lenken, finner relevante avgjørelser og lagrer dem i `dommer/`. **Anbefalt: Cmd+P → «Lagre som PDF»** med standard topp- og bunntekst. Da kommer også den faste Lovdata-lenken til dommen med. HTML, TXT og MD fungerer også, og undermapper er lov.
3. `npm run dommer` leser dem inn i en egen Qdrant-collection, `rettspraksis`. Endrede filer leses inn på nytt, og filer du sletter fjernes fra indeksen.
4. Claude søker i dem med `sok_dommer` og siterer med saksnummer og avsnitt.

Saksnummer (f.eks. `HR-2010-1433-U`), Rt-referanse (`Rt-2010-972`), domstol, dato, stikkord, sammendrag, lovhenvisninger og saksgang hentes automatisk fra teksten, eller fra filnavnet hvis teksten ikke har dem. Skannede PDF-er uten tekstlag hoppes over.

## Holde lovverket oppdatert

Lovdata publiserer nye data hver natt. `npm run sync` sjekker først om noe har endret seg. Hvis ikke, avslutter den på sekunder. Ved endringer embedder den bare paragrafene som er nye eller endret, og sletter opphevede. Hva som ble endret logges i `data/changes/<tidspunkt>.json`.

Automatisk nattlig synk kl. 04 (macOS):

```bash
scripts/install-launchd.sh    # logg: data/sync.log
```

`npm run sync:reindex` leser de nedlastede dataene på nytt selv om Lovdata ikke har endret noe, og embedder bare det som er nytt eller endret. Den brukes etter endringer i parseren eller chunkingen. `npm run sync:full` sletter og bygger alt på nytt. Det trengs bare ved bytte av embedding-modell eller endret chunk-format.

## Dele indeksen med andre

```bash
npm run export                # → export/: norsk_lov.snapshot.gz, rettspraksis.snapshot.gz, docs.json, state.json, manifest.json, dommer/
```

Del hele innholdet i `export/`. Mottakeren følger «Oppsett A». Eksporten nekter å kjøre mens en synk pågår, og importen sjekker at embedding-modellen stemmer. Import **erstatter** en eventuell eksisterende `norsk_lov`-collection.

## Hva som er med, og hva som ikke er med

**Med:** alle gjeldende lover (ca. 750) og sentrale forskrifter (ca. 3400, blant annet TEK17 og SAK10), pluss delegeringsvedtak, instrukser og stortingsvedtak, ajourført med endringer. Lover som er vedtatt men ikke trådt i kraft, og rene endringslover, er merket med ⚠ i søkeresultatene.

**Bare det du legger inn selv:** rettspraksis (se over).

**Ikke med:** forarbeider (NOU, proposisjoner), rundskriv, veiledninger (f.eks. DiBKs veiledning til TEK17), lokale forskrifter og reguleringsplaner. Claude er instruert om å si fra når et svar avhenger av dette.

> Dette er et hjelpemiddel, ikke advokatbistand. Ved alvorlige saker eller frister som snart går ut: kontakt advokat.

## Feilsøking

- **`port is already allocated`:** en annen tjeneste bruker 6343. Endre porten i `docker-compose.yml` og sett `QDRANT_URL`.
- **`fetch failed` mot 11434:** Ollama kjører ikke. Start appen eller kjør `ollama serve`.
- **`model "bge-m3" not found`:** kjør `ollama pull bge-m3`.
- **Maskinen blir veldig varm under innlesing:** bruk `npm run sync:rolig`, eller sett `EMBED_PAUSE_MS=3000` for lengre pauser.

## Kode

| Fil | Innhold |
|---|---|
| `src/lovdata/download.ts` | henter datasett fra `api.lovdata.no` når `lastModified` endres |
| `src/lovdata/parse.ts` | parser Lovdata-HTML til metadata og paragrafer |
| `src/chunk.ts` | én chunk per §, med stabile ID-er og hasher for inkrementell synk |
| `src/sparse.ts`, `src/embed.ts` | BM25-vektorer og bge-m3-embeddings for hybridsøk |
| `src/sync.ts` | inkrementell synk |
| `src/search.ts`, `src/mcp-server.ts` | søk og MCP-verktøy (`sok_lov`, `hent_paragraf`, `hent_lov`, `list_lover`, `sok_dommer`, `hent_dom`, `lovdata_sok_lenke`, `status`) |
| `src/dommer/` | uttrekk fra PDF/HTML/TXT, metadata og chunking av dommer (`npm run dommer`) |
| `src/transfer.ts`, `src/snapshot.ts` | eksport og import (gzip-komprimerte Qdrant-snapshots) |

Tester: `npm test`.
