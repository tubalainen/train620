# Minne – läget i projektet

Överlämning mellan chattsessioner. Läs den här filen och `CLAUDE.md` först i en ny session,
och uppdatera filen när något viktigt ändras (via PR, utan versionshöjning).

*Senast uppdaterad: 2026-11-17, inför v2.4.0.*

## Vad Tågkoll är

Webbapp som samlar förseningar och inställda tåg från Trafikverkets öppna API och visar
statistiken i en dashboard. Tåg 620 (Karlstad C → Stockholm C) och 643 (Stockholm C →
Karlstad C, SJ Snabbtåg) bevakas.

- **Dashboard `/`:** äldsta datapunkt per tåg, linjevy (ånglok + spöktåg enligt tidtabell,
  enkel/dubbelspår, färgade förseningssträckor, uppspelning, väljare för alla avgångar med
  egna hållplatsdata (`/api/journeys` = lista, `/api/journey?train=&date=` = en avgång), utfällbar "Var uppstod
  förseningen?"; ett framkommet tåg står vid slutstationen, pågående visas nu-läget,
  inställda/delvis inställda står kvar där de stannade), punktlighet, försenade/inställda, medelförsening, försening per avgång,
  vecka, veckodag och station, samt tabell med alla avgångar (utfällbar per station).
- **Admin `/admin`:** lösenordsskyddad (`ADMIN_PASSWORD`). Lägga till/ta bort tåg, *Uppdatera
  nu*, CSV-import av historik (filval, drag-och-släpp, inklistring) och *Radera allt och börja om*.
- **Definition:** försenat = mer än 5 min sent till slutstationen. Inställda och delvis
  inställda räknas som ej i tid.

## Kod

| Fil | Innehåll |
|---|---|
| `app/security.py` | Betrodd proxy (`client_ip`, `is_https`), `RateLimiter`, `SecurityMiddleware` (rubriker, 3 MB-gräns, Origin-kontroll, API-gräns) |
| `app/main.py` | FastAPI: insamling i bakgrundstråd (var 5:e min), SQLite, statistik, API, admin-inloggning |
| `app/static/index.html`, `app.js` | Dashboard, egna SVG-diagram utan bibliotek |
| `app/static/admin.html`, `admin.js` | Adminsidan |
| `app/static/style.css` | Gemensam stil, ljust och mörkt läge |
| `.github/workflows/build.yml` | Varje PR: bygg, provstart, nyckelkontroll, VERSION ↔ CHANGELOG |
| `.github/workflows/release.yml` | Merge av ändrad `VERSION` till `main` → image till ghcr.io + GitHub-release |
| `.github/workflows/security.yml` | Varje natt 04:17 UTC + push till main: Trivy (image) och pip-audit (requirements), ärende vid fynd |
| `.github/workflows/codeql.yml` | CodeQL (Python + JS) på PR, main och varje natt |
| `.github/dependabot.yml` | Veckovisa uppdateringar: pip, Docker, Actions (Actions låsta till SHA) |

SQLite-tabeller: `trains`, `announcements` (alla hållplatslägen från Trafikverket),
`imported_journeys` (CSV-import, används bara för dagar utan egna data), `stations`, `meta`,
`visits` (anonyma besökare: sha256(dygnssalt|ip|UA), saltet i `meta` byts och gamla rader
raderas vid dygnsbyte – inga IP-adresser sparas), `delay_segments` (var förseningen uppstod per delsträcka/uppehåll, räknas om efter varje
hämtning) och `track_sections` (antal spår per sträcka; `inbyggd` från `DEFAULT_LINES` eller
`admin` när användaren rättat). Nya tabeller skapas automatiskt vid start.

Spårdata i `DEFAULT_LINES` är ungefärlig och skrevs utan tillgång till riktiga hållplatslägen
(ingen API-nyckel i molnsessionen). Kontrollera mot verkliga data när det går: driftplatser
som inte finns i listan ärver bana från närmaste kända stationer.

HTML-sidorna levereras av appen med `?v=<version>` på skript och stilmall, eftersom Cloudflare
annars cachar gammal `app.js` efter en uppgradering (det var buggen som rättades i 2.0.2).

## Drift

- Körs hos användaren på labbservern **totoro** med `docker compose` och imagen
  `ghcr.io/tubalainen/train620:latest` (publik, ingen inloggning behövs).
- Uppgradering: `docker compose pull && docker compose up -d`.
- `.env` på totoro: `TRAFIKVERKET_API_KEY`, `ADMIN_PASSWORD` (krävs sedan 2.0.0), valfritt
  `PORT`, `INITIAL_TRAINS`, `POLL_INTERVAL_SECONDS`, `DELAY_THRESHOLD_MIN`. Se `.env.example`.
- Nås även från internet via användarens Nginx Proxy Manager bakom **Cloudflare**. Rensa
  Cloudflare-cachen om sidan beter sig konstigt efter en uppgradering till en version före 2.0.2.

## Begränsningar i molnsessionen

- **totoro går inte att nå** från en molnsession (privat nät). Användaren kör kommandona där
  själv, eller kopplar en dator via Remote Control. Lova inte att testa på totoro.
- Den publika adressen bakom Cloudflare svarar 403 till molnsessionen; be användaren titta.
- Docker måste startas för hand: `setsid nohup dockerd > <scratchpad>/dockerd.log 2>&1 &`.
- `docker build` behöver proxyns CA. Bygg en hjälpimage en gång och peka om basimagen:

  ```bash
  mkdir -p <scratchpad>/base && cp /root/.ccr/ca-bundle.crt <scratchpad>/base/ca.crt
  printf 'FROM python:3.13-slim\nCOPY ca.crt /etc/ssl/sandbox-ca.crt\nENV PIP_CERT=/etc/ssl/sandbox-ca.crt SSL_CERT_FILE=/etc/ssl/sandbox-ca.crt\n' > <scratchpad>/base/Dockerfile
  docker build -q -t sandbox-python <scratchpad>/base
  docker build --build-context python:3.13-slim=docker-image://sandbox-python -t tagkoll .
  ```

  En släppt image körs lokalt med `-e SSL_CERT_FILE=/ca.crt -v /root/.ccr/ca-bundle.crt:/ca.crt:ro`.
- `.env` finns inte i repot; skapa en lokal med API-nyckeln (fråga användaren) och ett
  testlösenord för att provköra.

## Historik

Trafikverket sparar bara några dagar bakåt. Äldre data kom från Tågstatistik
(tågexperterna.nu), som har ett odokumenterat API:
`https://api.tydalsystems.se/api/ts_tagperiod.php?tagNr=<nr>` → ca 15 månader per tåg med
`ankdiff` (ankomstavvikelse, **negativt = sent**).

- Användaren har importerat 620 (från 2025-08-18) och 643 (från 2025-07-23) via adminsidan.
- Dagar utan ankomsttid i Tågstatistik importerades som **inställda** på användarens begäran,
  fast källan inte säger varför tiden saknas (några hade registrerad avgång).
- Historiken ska **inte** byggas in i repot eller imagen (användarens beslut). Lokala filer
  ligger i `historik/`, som är undantagen i `.gitignore`.

## Releaser

- **v2.4.0** (PR, ej släppt ännu): välj och spela upp vilken insamlad avgång som helst i linjekortet.
  Importerade dagar kan inte spelas upp (bara slutförsening) – användaren är införstådd. Användaren
  ville *bara* väljare + befintlig uppspelning, inga fler kontroller (paus, reglage, hastighet).

- **v2.1.0** (2026-11-17): linjevy, `delay_segments`/`track_sections`, datans ålder, spår i admin.
  Release-körningen och `docker pull` utan inloggning kontrollerade. Användaren har uppgraderat
  på totoro; en skärmbild visade linjen för 620 med riktiga data.
- **v2.1.1** (2026-11-17): framkomna tåg visas vid slutstationen (användaren tyckte att läget
  vid planerad ankomst var förvirrande; uppspelningen gillades). Release-körningen gick igenom
  och `docker pull` av `2.1.1` och `latest` fungerar utan inloggning. `latest` pekade på den
  gamla versionen några sekunder in i körningen – vänta tills *Release* är klar innan kontroll.
- **v2.1.2** (2026-11-17): tolerantare stationsnamn, knutpunktsregel (Laxå) för luckor mellan
  banor, inbyggda spårrader räknas om vid varje hämtning. Release och `docker pull` kontrollerade.
- **v2.1.3** (2026-11-17): dubbelspår Karlstad C–Väse – blev fel, användaren tog tillbaka det.
- **v2.1.4** (2026-11-17): dubbelspår Karlstad C–Skattkärr, enkelspår Skattkärr–Laxå.
- **v2.1.5** (2026-11-17): Svartå med i Värmlandsbanan, sträckor förbi Laxå delas vid Laxå,
  rättad statustext för pågående tåg (beskrev läget vid planerad ankomst sedan 2.1.1).
  Release-körningen och `docker pull` av `2.1.5` och `latest` utan inloggning kontrollerade.
  Användaren har inte bekräftat linjen med riktiga data efter 2.1.5.
- **v2.1.6** (2026-11-17): Laxå-etiketten visades bara om sträckan var bredare än 70 px –
  syntes för 643 men inte för 620. Nu visas den alltid. Även rättad ankomsttext vid liten
  försening. Release-körningen och `docker pull` av `2.1.6` och `latest` utan inloggning
  kontrollerade; rättelsen finns i imagen. Användaren var (med rätta) irriterad: **testa alltid
  båda tågen/riktningarna** (t.ex. en spegelvänd kopia av 620 som 643 i en testdatabas) innan
  release.
- **v2.3.1**: första Security-körningen (vid mergen av 2.3.0) granskade gamla 2.2.0-imagen och
  öppnade ärende #18. Kvar i 2.3.0 enligt lokal Trivy: zlib1g (Debian) och setuptools 70.3.0 –
  den senare är *pips egna medföljande paket* (pip/_vendor), inte appens. Rättat: `apt-get
  upgrade` i Dockerfile och pip avinstalleras efter installationen (pip behövs inte i drift).
  Lokal Trivy: 0 sårbarheter. Security körs nu via `workflow_run` efter Release i stället för
  vid push. Ärende #18 stängs automatiskt vid nästa rena körning.
- **v2.3.0** (2026-11-17), släppt och kontrollerad: säkerhetsrelease efter granskning (se CHANGELOG). Viktigt för framtida ändringar:
  uvicorn körs med `--no-proxy-headers` (annars skriver uvicorn om klientadressen och appens
  egen proxykontroll kringgås); `_password_tag()` får inte anropas inne i en öppen
  `db()`-transaktion (låser databasen); sessioner i tabellen `sessions`, hemligheten i
  `meta.session_secret` (behålls vid "Radera allt"). Testskriptet låg i molnsessionens
  scratchpad – skriv om liknande tester vid behov.
- **v2.2.0** (2026-11-17), släppt och kontrollerad (`docker pull` utan inloggning): besökare i dag uppe till höger (`/api/visitors`, räknas bara vid sidladdning av
  `/`, inte admin/API/robotar) och avsnittet *Kakor och integritet* i sidfoten, inklusive
  Cloudflare (användarens val). Dashboarden ska fortsätta vara helt utan kakor.

## Spårdata

Användarens slutliga besked (efter flera rundor 2.1.2–2.1.5):

- Karlstad C–Skattkärr **dubbelspår**, Skattkärr–Laxå **enkelspår** ("inget annat"),
  Laxå–Stockholm C **dubbelspår** (Västra stambanan). 643 är samma sträcka spegelvänd;
  spårdata är riktningsoberoende (`pair_key`).
- Trafikverket rapporterar inte alltid Laxå: i 620:s data kommer Hasselfors direkt efter
  Svartå. `guess_section` delar då sträckan vid Laxå (`split` i segmentet: enkelspår före,
  dubbelspår efter, läget uppskattat efter antal stationer). Användaren valde den lösningen.
  Svartå ligger på Värmlandsbanan före Laxå – blanda inte ihop dem.
- Inbyggda rader i `track_sections` skrivs om vid varje hämtning; rader med `source='admin'`
  rörs inte. Ändringar användaren gjort på adminsidan går före de inbyggda.
- **Lärdom:** gissa inte järnvägsgeografi. Fråga användaren innan spårdata ändras, och utgå
  från stationsordningen i tågets egna data.

## Användarens preferenser

- Svenska i allt som användaren ser.
- Varje uppdatering: PR mot `main` → grön *Build* → användaren säger "merga" → release →
  kontrollera `docker pull` utan inloggning och rapportera. Se `CLAUDE.md`.
- Versionsregel: mindre → `0.0.x`, halvstor → `0.x.0`, major → `x.0.0`. Fråga vid tvekan.
- Kontrollera innan du säger att något inte går, och förklara då konkret varför (t.ex. vad
  ett test faktiskt svarade).

## Öppna punkter

- Besöksräknaren läser IP från `CF-Connecting-IP`/`X-Forwarded-For`. Om användarens Nginx
  Proxy Manager inte skickar vidare dem blir alla besökare samma IP (bara webbläsaren skiljer)
  och siffran blir för låg. Be användaren säga till om siffran ser konstig ut.
- Användaren har inte bekräftat 2.1.6 med riktiga data. Fråga om linjen ser rätt ut för både
  620 och 643 (spår och Laxå-markering), och om inget står som "Okänt" under *Spår på sträckorna* på /admin.
- Det är okänt varför en bit efter Degerfors visades som "okänt" i 2.1.0 (troligen ett
  stationsnamn som inte matchade). 2.1.2 och senare täcker det med tolerantare namn och
  knutpunktsregeln.
- Säkerhetskontrollen körde första gången 2026-11-17 (rött på grund av gamla imagen, ärende
  #18). Kontrollera efter 2.3.1 att *Security* blir grön och stänger #18, och att nattkörningen
  04:17 UTC faktiskt sker.
- Rekommenderat till användaren (görs i Cloudflare, inte i koden): Cloudflare Access för
  `/admin*` och `/api/admin*`, och en Rate Limiting-regel för `/api/*`. Ej bekräftat gjort.
- Login-spärren per IP går att kringgå av den som når proxyn förbi Cloudflare och förfalskar
  `CF-Connecting-IP`; den globala spärren (50 fel/timme) fångar det. Cloudflare Access löser det.
- Version 2.0.0 blev major innan versionsregeln fanns; numreringen fortsätter därifrån.
