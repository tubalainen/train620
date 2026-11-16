# Ändringslogg

Varje release får ett avsnitt `## [x.y.z] - ÅÅÅÅ-MM-DD`. Avsnittet blir releasetexten på GitHub.

## [1.1.0] - 2026-11-16

- Historik kan importeras genom att välja en CSV-fil eller dra och släppa den i importrutan. Innehållet visas för granskning innan det importeras.
- Importen godtar både semikolon och komma som fältavgränsare.
- Varning om filnamnet ser ut att gälla ett annat bevakat tåg än det valda.

## [1.0.0] - 2026-11-16

Första releasen.

- Samlar in ankomst- och avgångstider för bevakade tågnummer från Trafikverkets öppna API var 5:e minut och sparar dem i SQLite.
- Dashboard med punktlighet, försenade och inställda avgångar, medelförsening samt försening per avgång, vecka, veckodag och station.
- Tågnummer läggs till och tas bort i gränssnittet. Tåg 620 bevakas från start.
- CSV-import av äldre historik.
- Daglig säkerhetskontroll av imagen med Trivy.
- Docker-image på `ghcr.io/tubalainen/train620`, webbgränssnitt på port 8843.
