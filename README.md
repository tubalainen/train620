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

## Linjen

Dashboarden visar den senaste avgången (eller den som väljs med *Visa på linjen* i tabellen)
som en linje från start till mål. Ångloket är tåget, det streckade loket är var tåget skulle ha
varit enligt tidtabellen. Avståndet längs linjen motsvarar planerad restid, eftersom Trafikverket
inte anger kilometer.

- Sträckorna färgas efter hur mycket förseningen ökade där, och inställda sträckor är röda.
  Uträkningen sparas i tabellen `delay_segments` efter varje hämtning.
- Enkel- och dubbelspår kommer från inbyggda, ungefärliga uppgifter om banorna mellan Karlstad
  och Stockholm (`DEFAULT_LINES` i `app/main.py`) och sparas per sträcka i `track_sections`.
  Rätta dem på adminsidan under *Spår på sträckorna*. Sträckor på andra banor visas som okända
  tills de anges där.

## Inställningar (`.env`)

| Variabel | Standard | Betydelse |
|---|---|---|
| `TRAFIKVERKET_API_KEY` | – | API-nyckel, krävs |
| `ADMIN_PASSWORD` | – | Lösenord till `/admin`. Tomt = admin avstängt |
| `PORT` | `8843` | Port på värden |
| `INITIAL_TRAINS` | `620` | Tåg som bevakas vid allra första start |
| `POLL_INTERVAL_SECONDS` | `300` | Hur ofta Trafikverket tillfrågas |
| `DELAY_THRESHOLD_MIN` | `5` | Gräns för "försenat", i minuter |

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
