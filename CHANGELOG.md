# Ändringslogg

Varje release får ett avsnitt `## [x.y.z] - ÅÅÅÅ-MM-DD`. Avsnittet blir releasetexten på GitHub.

## [2.5.1] - 2026-11-17

- Tydligare när tåget har avgått: *I dag* visar **Har avgått** med en grön bock, eller en gul markering om tåget är mer än 5 minuter sent. Texten säger när tåget avgick och om det var i tid, till exempel "Avgick från Stockholm C 15:04, 2 min sent". Den säger också var tåget senast rapporterades och när det beräknas vara framme.
- Linjen visar också avgångstiden och om den var i tid. I avgångsväljaren står "på väg" i stället för "planerat" för ett tåg som har avgått.
- Rättad dubbel punkt efter datumet i *Kommande avgångar*.

## [2.5.0] - 2026-11-17

- Nytt: **Kommande avgångar.** Tågkoll hämtar nu avgångar upp till 7 dagar framåt, så långt Trafikverket har publicerat dem. En avgång som ställs in i förväg, till exempel på grund av banarbete, syns därför direkt i rutan *Kommande avgångar* under *I dag*, med Trafikverkets orsak när den finns. Tidigare syntes en inställning först från midnatt samma dag.
- Nytt: **prognos före avgång.** Om Trafikverket redan före avgång räknar med att tåget blir sent visas det som *Väntas bli försenat*, med väntad avgångstid och beräknad ankomst. Prognosen visas i *I dag*, i *Kommande avgångar* och på linjen.
- Kommande avgångar räknas inte in i statistiken förrän deras dag har kommit. En avgång som redan är inställd nästa vecka sänker alltså inte punktligheten i dag.
- I dag och vid inställda avgångar visas Trafikverkets orsak (t.ex. "Banarbete") när den finns.

## [2.4.0] - 2026-11-17

- Nytt: **spela upp äldre avgångar.** På linjekortet finns en väljare med alla avgångar som Tågkoll har samlat in från Trafikverket, oavsett vald period. Välj en avgång och tryck *Spela upp resan* för att se hur tåget gick och var förseningen uppstod. Varje avgång i listan visas med datum och utfall, till exempel "+13 min" eller "inställt".
- Importerad historik (från CSV) finns inte med i väljaren. Där finns bara slutförseningen och ingen uppgift om var tåget var under resan.

## [2.3.1] - 2026-11-17

- Rättar de säkerhetshål som den första dagliga säkerhetskontrollen hittade i imagen. Operativsystemets paket uppdateras när imagen byggs, vilket bland annat rättar en allvarlig brist i zlib. Pakethanteraren pip tas bort ur den färdiga imagen, och med den de gamla paket som pip bar med sig (bl.a. setuptools). Imagen har nu inga kända säkerhetshål med tillgänglig rättning.
- Säkerhetskontrollen på GitHub körs nu när en release är helt klar, så att den granskar den nya imagen och inte den föregående.

## [2.3.0] - 2026-11-17

Säkerhetsrelease. **Du behöver logga in på adminsidan igen** efter uppgraderingen. Inga andra manuella åtgärder krävs.

- **Uppdaterade Python-paket.** Den tidigare versionen av Starlette (0.41.3) hade åtta kända säkerhetshål. Nu används FastAPI 0.163.1, Starlette 1.10.0 och Uvicorn 0.54.0, som inte har några kända hål.
- **Skydd mot lösenordsgissning.** Efter 5 felaktiga lösenord från samma IP-adress spärras inloggningen i 15 minuter, och efter 50 fel totalt per timme spärras den för alla.
- **Säkrare inloggning.** Sessionen är en slumpad kod som servern kan återkalla. Utloggning avslutar sessionen på riktigt, och byte av `ADMIN_PASSWORD` loggar ut alla. En inloggning gäller i 12 timmar i stället för 7 dagar. Kakan markeras `Secure` när sidan nås via https.
- **Säkerhetsrubriker** på alla svar: Content-Security-Policy, skydd mot inbäddning i andra sidor (clickjacking), `nosniff`, `Referrer-Policy`, `Permissions-Policy` och HSTS via https. Rubriken som avslöjar servertyp skickas inte längre.
- **Skydd mot överbelastning.** Högst 120 API-anrop per minut och IP-adress (`API_RATE_LIMIT_PER_MINUTE`), högst 3 MB per anrop och kontroll av alla parametrar. Statistiken cachas mellan hämtningarna.
- **Skydd mot förfalskade anrop från andra webbplatser (CSRF)** utöver den tidigare kakinställningen.
- **Rubriker med besökarens IP-adress** (`X-Forwarded-For`, `CF-Connecting-IP`) godtas bara från en betrodd proxy (`TRUSTED_PROXIES`, standard: privata nät). Det går inte längre att förfalska besöksräknaren eller kringgå spärrarna med påhittade rubriker direkt mot porten.
- **Felmeddelanden från hämtningen** visas bara för inloggad admin, inte längre för alla i `/api/health`.
- **Härdad container** i `docker-compose.yml`: skrivskyddat filsystem, inga Linux-rättigheter, ingen rättighetshöjning, och tak för minne och processer. Med `BIND_ADDRESS=127.0.0.1` nås appen bara från servern själv. Ta in den nya `docker-compose.yml` för att få härdningen.
- **Daglig säkerhetskontroll på GitHub.** Den granskar imagen (Trivy), Python-paketen (pip-audit) och koden (CodeQL) och öppnar ett ärende vid fynd. Dependabot föreslår uppdateringar varje vecka. Imagen har nu SBOM och byggintyg.

## [2.2.0] - 2026-11-17

- Nytt: **antal besökare i dag** visas uppe till höger på dashboarden. Varje besökare räknas en gång per dag, helt anonymt och utan kakor. Räkningen använder en engångskod av IP-adress och webbläsare, blandad med ett slumpvärde som byts varje natt. IP-adressen sparas aldrig, och koderna raderas när dygnet är slut. Robotar räknas inte.
- Nytt avsnitt **Kakor och integritet** längst ned på sidan. Det beskriver att Tågkoll inte sätter kakor för besökare och inte spårar någon, att valt tåg och period bara sparas i din webbläsare, hur besökare räknas, att adminsidan har en inloggningskaka och att Cloudflare kan sätta egna kakor. Adminsidan har fått en motsvarande rad om sin inloggningskaka.

## [2.1.6] - 2026-11-17

- Markeringen *Laxå* på linjen visas nu alltid, för både tåg 620 och 643. Tidigare visades namnet bara när sträckan förbi Laxå var tillräckligt bred på skärmen, så för 620 syndes bara ett streck.
- Texten ovanför linjen säger inte längre "var det framme i …" om ett tåg som var några minuter sent.

## [2.1.5] - 2026-11-17

- Spåren på linjen följer nu: dubbelspår Karlstad C–Skattkärr, enkelspår Skattkärr–Laxå och dubbelspår (stambanan) Laxå–Stockholm C. Samma sak gäller tåg 643 i motsatt riktning.
- Trafikverket rapporterar inte alltid tåget i Laxå, utan nästa plats efter Svartå kan vara Hasselfors. En sådan sträcka visades tidigare som dubbelspår. Nu delas den vid Laxå: enkelspår fram till Laxå och dubbelspår därefter, med Laxå utmärkt på linjen.
- Rättar texten ovanför linjen för ett tåg som är på väg: den säger nu var tåget är just nu.

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
