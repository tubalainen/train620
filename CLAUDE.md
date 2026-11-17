# Tågkoll – arbetsregler

Webbapp som samlar förseningar och inställda tåg från Trafikverkets API (FastAPI + SQLite,
dashboard i `app/static/`). Körs som Docker-container på port 8843. Skriv till användaren,
i gränssnittet och i ändringsloggen på svenska.

**Läs `MINNE.md` först** – där står läget, driften, begränsningar i molnsessionen och öppna
punkter. Uppdatera den när något viktigt ändras.

## Releaseflöde

Varje uppdatering går till `main` via en pull request och avslutas med en release.

1. Gör ändringen på en arbetsgren och öppna en PR mot `main`. Pusha aldrig direkt till `main`.
2. I samma PR: höj `VERSION` och lägg till ett avsnitt `## [x.y.z] - ÅÅÅÅ-MM-DD` överst i
   `CHANGELOG.md`. Avsnittet blir releasetexten, så skriv det för den som använder appen.
3. Vänta tills arbetsflödet *Build* är grönt.
4. **Användaren godkänner varje release.** Merga bara när användaren uttryckligen har sagt till
   för just den PR:en. Ett tidigare godkännande gäller inte nästa release.
5. Mergen startar arbetsflödet *Release*, som bygger imagen, pushar den till
   `ghcr.io/tubalainen/train620` (`x.y.z`, `x.y`, `x`, `latest`) och skapar taggen `vx.y.z`
   med en GitHub-release. Skapa aldrig taggar eller releaser för hand.
6. Kontrollera efteråt att körningen gick igenom och att `docker pull` av den nya versionen
   fungerar utan inloggning. Rapportera resultatet.

Versionsnummer `x.y.z` väljs efter hur stor ändringen är (användarens regel):

- **Mindre ändringar → `0.0.x`** (höj sista siffran): rättningar, justeringar i text och utseende,
  små förbättringar av befintliga funktioner.
- **Halvstora ändringar → `0.x.0`** (höj mittensiffran, nollställ sista): nya funktioner eller
  sidor, flyttade funktioner, nya inställningar i `.env`.
- **Major → `x.0.0`** (höj första siffran, nollställ resten): stora omarbetningar, eller när en
  befintlig installation slutar fungera utan manuella åtgärder (t.ex. nytt databasformat).

Är det oklart vilken nivå en ändring hör till, fråga användaren innan release-PR:en öppnas.

Ändringar som inte påverkar imagen (dokumentation, arbetsflöden, den här filen) mergas via PR
utan versionshöjning och ger ingen release.

## Hemligheter

- Trafikverkets API-nyckel finns bara i `.env`, som inte checkas in. Skriv aldrig nyckeln i
  kod, tester, dokumentation, commit-meddelanden eller PR-texter.
- *Build* stoppar PR:er som innehåller en incheckad nyckel. Kringgå inte den kontrollen.

## Testa före PR

```bash
docker build -t tagkoll . && docker run --rm -p 8843:8843 --env-file .env tagkoll
```

Kontrollera `http://localhost:8843/api/health` och att dashboarden laddar. Ändringar i
gränssnittet granskas i webbläsare, i ljust och mörkt läge och i mobilbredd.

## Säkerhetskontroll

Arbetsflödet *Security* söker varje natt efter säkerhetshål i den släppta imagen och öppnar ett
ärende vid fynd. Rättningen är en ny release enligt flödet ovan: den bygger om imagen med
uppdaterad basimage, och paketversioner höjs i `requirements.txt` vid behov.
