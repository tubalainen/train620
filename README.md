# Tågkoll

En liten webbapp som samlar in förseningar och inställda tåg från Trafikverkets öppna API
och visar statistiken i en dashboard. Bevakar tåg 620 (Karlstad C → Stockholm C) från start;
fler tågnummer läggs till och tas bort direkt i gränssnittet.

![Dashboard](docs/screenshot.png)

## Kom igång

```bash
cp .env.example .env        # fyll i TRAFIKVERKET_API_KEY
docker compose pull && docker compose up -d
```

Det hämtar den senaste releasen från `ghcr.io/tubalainen/train620`. Samma kommando uppgraderar
till en ny release. För att i stället bygga från källkoden: `docker compose up -d --build`.

Öppna sedan `http://<värd>:8843`. Databasen (SQLite) ligger i Docker-volymen `tagkoll-data`
och överlever omstarter och ombyggen.

## Så fungerar det

- En bakgrundstråd frågar Trafikverket (`TrainAnnouncement`) var 5:e minut och sparar varje
  hållplatsläge i SQLite. Trafikverket behåller bara några dagar bakåt, så statistiken byggs upp
  från den dag ett tåg börjar bevakas.
- Ett tåg räknas som **försenat** när det ankommer slutstationen mer än 5 minuter efter tidtabell
  (samma gräns som det officiella punktlighetsmåttet). Inställda och delvis inställda avgångar
  räknas som ej i tid.
- Tåg läggs till och tas bort på adminsidan `/admin`, som skyddas av `ADMIN_PASSWORD` i `.env`.
  Där finns också *Radera allt och börja om*.
- Äldre historik importeras på adminsidan genom att välja eller dra in en CSV-fil, eller
  klistra in rader. En rad per dag:
  `datum;försening_min;inställt`. Importerade dagar används bara där egna data saknas.

## Dashboarden

Överst väljer du tåg. Under det visar **Nu-kortet** en avgång i taget: status, avgång, ankomst,
försening och samhällskostnad, linjen och kommande dagars kända störningar. Pilarna och listan
bläddrar mellan alla insamlade avgångar.

Historiken ligger under fyra flikar, med periodvalet på samma rad:

- **Översikt:** punktlighet, inställda, medelförsening, samhällskostnad och försening per avgång.
- **Punktlighet:** utfall, per vecka, per veckodag och per station.
- **Kostnad:** samhällskostnaden i perioden, över tid och per kostnadsslag.
- **Avgångar:** tabellen, med urval (bara störningar) och sortering (senaste, störst försening, dyrast).

Vald flik sparas i webbläsaren och i adressen (`#overview`, `#punct`, `#cost`, `#table`), så att
en länk kan gå direkt till en flik.

## Linjen

Nu-kortet visar avgången som en linje från start till mål. Ångloket är tåget, det streckade loket är var tåget skulle ha
varit enligt tidtabellen. Avståndet längs linjen motsvarar planerad restid, eftersom Trafikverket
inte anger kilometer.

- Sträckorna färgas efter hur mycket förseningen ökade där, och inställda sträckor är röda.
  Uträkningen sparas i tabellen `delay_segments` efter varje hämtning.
- Enkel- och dubbelspår kommer från inbyggda, ungefärliga uppgifter om banorna mellan Karlstad
  och Stockholm (`DEFAULT_LINES` i `app/main.py`) och sparas per sträcka i `track_sections`.
  Rätta dem på adminsidan under *Spår på sträckorna*. Sträckor på andra banor visas som okända
  tills de anges där.

## Samhällskostnad

Fliken *Kostnad* visar en ungefärlig kostnad för samhället av förseningar och inställda
avgångar: summa och spann för vald period, uppdelning per slag (förlorad tid, missade möten,
dagen efter och familj, hotellnätter, andra resor, ersättningstrafik) och kostnad per vecka eller
månad. Nu-kortet visar kostnaden för den valda avgången, och tabellen under *Avgångar* kan
sorteras på kostnad. För morgontåget visas också en dold kostnad (resor kvällen före) separat
från summan.

- Resenärerna räknas utifrån antal platser och beläggning, uppdelade på konsulter, offentlig
  sektor och övriga med egna timvärden.
- Tåg till Stockholm räknas som utresa (möten, konferenser och övningar står på spel), tåg från
  Stockholm som hemresa (hotellnätter, alternativa resor, arbetstid dagen efter).
- Beloppen är förväntade värden som bygger på schabloner. Knappen *Så räknar vi* förklarar
  uträkningen med de värden som gäller.
- Schablonerna ändras på adminsidan under *Kostnadsmodell* och sparas i tabellen `cost_params`.
- Hela modellen beskrivs i [`docs/kostnadsmodell.md`](docs/kostnadsmodell.md). Koden finns i
  `app/cost.py`.

## Besökare och integritet

Dashboarden visar antalet unika besökare i dag. Besök på `/` räknas som en hash av IP-adress
och User-Agent, blandad med ett slumpat salt som byts varje dygn (tabellen `visits`). Varken
IP-adresser eller kakor sparas, och gårdagens hashar raderas tillsammans med saltet. Robotar
och verktyg som `curl` räknas inte. IP-adressen läses från `CF-Connecting-IP` eller
`X-Forwarded-For` när appen ligger bakom Cloudflare eller en proxy.

## Säkerhet

- Adminsidan skyddas av `ADMIN_PASSWORD`. Efter 5 felaktiga lösenord per IP spärras inloggningen
  i 15 minuter, och efter 50 fel totalt per timme spärras den för alla. Sessionerna sparas på
  servern (bara som hash), gäller i 12 timmar och avslutas vid utloggning eller lösenordsbyte.
- Alla svar har säkerhetsrubriker (CSP, skydd mot inbäddning, `nosniff` m.fl.). API:t tillåter
  högst `API_RATE_LIMIT_PER_MINUTE` anrop per IP och minut och högst 3 MB per anrop.
- Besökarens IP läses ur `CF-Connecting-IP`/`X-Forwarded-For` bara när anropet kommer från en
  betrodd proxy (`TRUSTED_PROXIES`, standard loopback och privata nät).
- `docker-compose.yml` kör containern med skrivskyddat filsystem, utan Linux-rättigheter och med
  tak för minne och processer. `BIND_ADDRESS=127.0.0.1` gör porten nåbar bara från värden.
- **Rekommenderat i Cloudflare:** lägg `/admin*` och `/api/admin*` bakom Cloudflare Access och
  sätt en Rate Limiting-regel för `/api/*`. Då når lösenordsgissningar aldrig appen.
- GitHub granskar varje natt imagen (Trivy), Python-paketen (pip-audit) och koden (CodeQL) och
  öppnar ett ärende vid fynd. Dependabot föreslår uppdateringar varje vecka.

## Inställningar (`.env`)

| Variabel | Standard | Betydelse |
|---|---|---|
| `TRAFIKVERKET_API_KEY` | – | API-nyckel, krävs |
| `ADMIN_PASSWORD` | – | Lösenord till `/admin`. Tomt = admin avstängt |
| `PORT` | `8843` | Port på värden |
| `INITIAL_TRAINS` | `620` | Tåg som bevakas vid allra första start |
| `POLL_INTERVAL_SECONDS` | `300` | Hur ofta Trafikverket tillfrågas |
| `DELAY_THRESHOLD_MIN` | `5` | Gräns för "försenat", i minuter |
| `BIND_ADDRESS` | `0.0.0.0` | Vilket nätverkskort porten öppnas på (`127.0.0.1` = bara värden) |
| `TRUSTED_PROXIES` | `private` | Vem som får ange besökarens IP: `private`, `none` eller nät som `172.18.0.0/16` |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | Högsta antal API-anrop per IP och minut |

Dashboarden är öppen för alla som når porten; bara `/admin` kräver lösenord. Lösenordet skickas
okrypterat över vanlig http, så kör appen bara på ett nät du litar på.

## Releaser

1. En release-PR mot `main` höjer `VERSION` och lägger till ett avsnitt i `CHANGELOG.md`.
2. Att merga PR:en är godkännandet. Då bygger arbetsflödet *Release* imagen, pushar den till
   `ghcr.io/tubalainen/train620` (taggarna `x.y.z`, `x.y`, `x` och `latest`) och skapar taggen
   `vx.y.z` med en GitHub-release.

Utan merge släpps ingenting. Varje pull request byggs och provstartas av arbetsflödet *Build*,
som också stoppar incheckade API-nycklar.

## Säkerhetskontroll

Arbetsflödet *Security* körs varje natt och söker med Trivy efter kända säkerhetshål i den
senast släppta imagen (operativsystem och Python-paket). Hittas allvarliga hål som har en
rättning misslyckas körningen och ett ärende öppnas eller uppdateras i repot. Ärendet stängs
automatiskt när imagen är ren igen. Rättningen är normalt en ny release, som bygger om imagen.
