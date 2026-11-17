# Ändringslogg

Varje release får ett avsnitt `## [x.y.z] - ÅÅÅÅ-MM-DD`. Avsnittet blir releasetexten på GitHub.

## [2.1.4] - 2026-11-17

- Rättar spåren på Värmlandsbanan igen: dubbelspår mellan Karlstad C och Skattkärr och enkelspår hela vägen från Skattkärr till Laxå. I 2.1.3 visades Skattkärr–Väse felaktigt som dubbelspår. Från Laxå till Stockholm är det dubbelspår. Ändringen slår igenom vid första hämtningen efter uppgraderingen. Sträckor du själv har ändrat på adminsidan behålls.

## [2.1.3] - 2026-11-17

- Rättar spåren på Värmlandsbanan: dubbelspår mellan Karlstad C och Väse, enkelspår från Väse till Laxå. Mötesplatser och bangårdar längs enkelspåret räknas inte som dubbelspår. Från Laxå till Stockholm är det som tidigare dubbelspår. Ändringen slår igenom vid första hämtningen efter uppgraderingen. Sträckor du själv har ändrat på adminsidan behålls.

## [2.1.2] - 2026-11-17

- Spåren på linjen blir rätt i fler fall. Sträckor som visades som *okänt* mellan Degerfors och Laxå får nu enkelspår, och sträckorna från Laxå mot Stockholm dubbelspår (stambanan). Stationsnamn jämförs nu mer tolerant.
- Inbyggda spåruppgifter räknas om vid varje hämtning, så att rättelser i appen slår igenom även i befintliga databaser. Det du själv har ändrat på adminsidan behålls.

## [2.1.1] - 2026-11-17

- Linjen visar nu ett tåg som har kommit fram stående vid slutstationen, i stället för där det befann sig vid planerad ankomsttid. Texten ovanför linjen säger när tåget kom fram och var det var när det skulle ha varit framme. *Spela upp resan* visar fortfarande hela resan.

## [2.1.0] - 2026-11-17

- **Ny linjevy** på dashboarden: ett ånglok med animerad ånga visar var tåget är på sträckan, och ett streckat spöktåg visar var det hade varit enligt tidtabellen, med förseningen i minuter mellan dem. För avgångar som redan gått visas läget vid planerad ankomsttid, och *Spela upp resan* kör hela resan från start till mål. Inställda avgångar och sträckor syns tydligt i rött.
- Linjen visar **enkelspår och dubbelspår** och färgar de sträckor där förseningen uppstod (gult +2–4 min, orange +5 min eller mer). Antalet spår är inbyggda, ungefärliga uppgifter och kan rättas på adminsidan under *Spår på sträckorna*.
- Ny utfällbar sektion **Var uppstod förseningen?** med varje delsträcka och uppehåll där tåget förlorade eller tog igen tid, antal spår och Trafikverkets orsak.
- Välj vilken avgång som visas på linjen med *Visa på linjen* i avgångstabellen.
- Var förseningarna uppstod och antalet spår per sträcka sparas i databasen. Befintliga databaser uppgraderas automatiskt vid start.
- Varje tåg visar hur gammal den äldsta datapunkten är och sedan när egen insamling från Trafikverket pågår, både på dashboarden och på adminsidan.

## [2.0.2] - 2026-11-16

- Rättar att dashboarden kunde fastna på "Hämtar …" bakom en cache som Cloudflare efter en uppgradering: skript och stilmall får nu versionsnumret i adressen, så att en ny release aldrig blandas med cachade filer från en äldre.

## [2.0.1] - 2026-11-16

- Knappen *Uppdatera nu* har flyttats från dashboarden till adminsidan, tillsammans med när data senast hämtades. Den kräver nu inloggning.
- Länken till Admin i dashboardens övre hörn är borttagen. Adminsidan nås direkt på `/admin`.

## [2.0.0] - 2026-11-16

**Kräver ändring i `.env`:** lägg till `ADMIN_PASSWORD=ditt-lösenord` och starta om containern. Utan lösenordet går det inte längre att lägga till, ta bort eller importera.

- Ny adminsida på `/admin`, skyddad med lösenordet i `.env`. Dit har funktionerna för att lägga till och ta bort tåg och för att importera historik flyttats. Dashboarden visar bara statistik.
- På adminsidan väljs tåg för importen i en lista, och tåget väljs automatiskt om filnamnet innehåller tågnumret.
- Ny funktion på adminsidan: *Radera allt och börja om* tar bort alla tåg och all data och startar om insamlingen med tågen i `INITIAL_TRAINS`.
- Knappen *Uppdatera nu* hämtar från Trafikverket högst en gång per 30 sekunder.

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
