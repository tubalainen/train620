# Kostnadsmodell – vad kostar ett försenat eller inställt tåg samhället?

Tågkoll räknar ut en ungefärlig **samhällskostnad** för varje avgång som har bevakats. Det här
dokumentet beskriver modellen, schablonerna, hur siffrorna ska läsas och hur modellen förhåller
sig till en annan beräkning för samma tågpar. Koden finns i `app/cost.py`, och alla schabloner kan
ändras på `/admin` under *Kostnadsmodell*.

> Siffrorna är **förväntade värden** som bygger på schabloner. En enskild avgång kan i
> verkligheten kosta mer eller mindre. Över många avgångar ger genomsnittet ändå en rimlig bild av
> storleksordningen. Därför visas alltid ett spann (lågt–högt scenario) bredvid grundberäkningen.

## 1. Resenärerna

**Antal:** 240 platser (SJ 3000 / X55) × 85 % beläggning = **204 resenärer** per avgång. Går tåget
med två sätt ändras antalet platser på adminsidan.

| Grupp | Andel | Värde per timme |
|---|---|---|
| Konsulter och näringsliv | 40 % | 1 250 kr/h i arbetstid |
| Offentlig sektor (myndigheter, region, kommun, försvar) | 40 % | 650 kr/h i arbetstid (lön, arbetsgivaravgifter, omkostnader) |
| Övriga (pendlare, studenter, privatresor) | 20 % | 402 kr/h förseningstid |

Konsulter och offentliganställda kallas nedan **tjänsteresenärer**. Deras snittvärde är 950 kr/h.

**Fritid och förseningstid.** Trafikverkets kalkylvärden (ASEK 8.0, AR 9.21) värderar
förseningstid till **3,5 gånger** normal åktid. Restidsvärdet för långväga privata resor med tåg är
85 kr/h i 2017 års priser (ASEK). Med ASEK 8.0:s rättning på +5 % och inflationen fram till i dag
blir det ungefär **115 kr/h**, och förseningstiden **402 kr/h**. Det värdet används för övriga
resenärer och för **allas** tid på kvällen, eftersom hemresan sker efter arbetstid.

**Tjänsteresor och faktorn 3,5.** ASEK använder faktorn 3,5 även för tjänsteresor (AR 9.12, 9.21),
och räknar med att tjänsteresenärer på tåg är produktiva 15 % av resan (AR 9.9). Tågkoll lägger
inte faktorn på arbetstid. I ASEK fångar faktorn följderna av att inte kunna planera; här räknas
de följderna i stället var för sig – missade möten, att vända hem och förmiddagen efter. Att göra
både och vore dubbelräkning. Se avsnitt 7 för vad det betyder för nivån.

**Arbete under resan.** Ombord på ett försenat tåg antas tjänsteresenärerna kunna arbeta **60 %**
av tiden. På perrongen, i ersättningsbuss, på ett överfullt tåg eller bakom ratten **15 %**.

**Små förseningar.** Upp till **5 minuter** räknas inte; de ryms i normal marginal.
**Delvis inställda** avgångar räknas som **75 %** av ett helt inställt tåg.

## 2. Kostnadsslag

| Slag | Innehåll |
|---|---|
| Förlorad tid | Förlorad arbetstid och förseningstid på fritid |
| Missade möten | Möten, konferenser, utbildningar och övningar som resenärer kommer sent till eller missar (utresa) |
| Dagen efter och familj | Sämre arbetsförmåga förmiddagen efter en mycket sen hemkomst, och hämtning/barnomsorg som måste lösas (hemresa) |
| Hotellnätter | Hotell, traktamente och ombokning (hemresa) |
| Andra resor | Bil, hyrbil, buss, taxi |
| Ersättningstrafik | Bussar, taxi, personal och hantering vid inställd avgång: 50 000 kr |

## 3. Utresa till Stockholm (morgontåget, 620)

### 3.1 Förväntad mötesförlust

Kostnaden när en tjänsteresenär **inte kommer fram alls**, vägd över vad resenärerna ska göra:

```
mötesförlust = Σ andel × sannolikhet att frånvaron får betydelse × kostnad när den får det
```

| Ändamål | Andel | Sannolikhet | Kostnad när den får betydelse | Förväntat |
|---|---|---|---|---|
| Kunduppdrag eller arbete på plats utan fast mötestid | 30 % | 15 % | 8 000 kr | 1 200 kr |
| Internt arbetsmöte | 30 % | 20 % | 6 000 kr (6 personer × 2 h) | 1 200 kr |
| Externt möte, förhandling eller samverkan | 20 % | 35 % | 15 000 kr (motparter väntar, 8 personer × 3 h) | 5 250 kr |
| Konferens eller utbildning | 15 % | 70 % | 6 000 kr | 4 200 kr |
| Övning eller större samordnad aktivitet | 5 % | 40 % | 40 000 kr (20 personer × 4 h) | 16 000 kr |
| **Viktat** | | | | **≈ 3 200 kr** |

Sannolikheten fångar att det **inte alltid** kostar stora pengar när någon uteblir.

### 3.2 Försenat tåg

En försening kostar mötesförlust bara för den som har **mindre marginal** mellan ankomst och
mötets början än förseningen:

| Marginal | Andel |
|---|---|
| Under 15 min | 25 % |
| 15–45 min | 35 % |
| 45–90 min | 20 % |
| Mer än 90 min eller flexibel tid | 20 % (räknas som 90–180 min) |

Den som kommer för sent förlorar **15 %** av mötesförlusten vid under 30 minuter, **40 %** vid
30–90 minuter och **60 %** vid mer än 90 minuter. Från 30 minuters försening deltar **25 %** av de
sena digitalt från tåget och förlorar då bara **20 %**.

**Vända hem.** Vid mer än **90 minuters** försening vänder **25 %** av tjänsteresenärerna hem:
de förlorar **3 timmar** arbetstid (netto) och hela mötesförlusten.

```
per tjänsteresenär = försening × 950 kr/h × (1 − 60 %) + andel med för liten marginal × effekt × 3 200 kr
per övrig resenär  = försening × 402 kr/h
```

| Försening | Tid | Möten | Summa (204 resenärer) |
|---|---|---|---|
| +10 min | 13 000 kr | 13 000 kr | **≈ 26 000 kr** |
| +30 min | 39 000 kr | 78 000 kr | **≈ 117 000 kr** |
| +60 min | 78 000 kr | 122 000 kr | **≈ 200 000 kr** |
| +120 min | 242 000 kr | 300 000 kr | **≈ 542 000 kr** |
| +185 min | 310 000 kr | 326 000 kr | **≈ 637 000 kr** |

Kostnaden växer **inte i proportion till minuterna**. Den tar hopp när marginalerna tar slut och
när en del vänder hem.

### 3.3 Inställt tåg

| Vad tjänsteresenären gör | Andel | Antagande |
|---|---|---|
| Tar nästa tåg | 45 % | 2 h senare med 15 % arbetsförmåga, 60 % av mötesförlusten |
| Tar bilen | 15 % | 1 150 kr och 1 h utan arbete, 40 % av mötesförlusten |
| Deltar digitalt | 25 % | 0,5 h omplanering, 20 % av mötesförlusten |
| Ställer in resan | 15 % | 2 h förlorad arbetstid, hela mötesförlusten |

Övriga resenärer tar nästa tåg (2 h förseningstid). Med ersättningstrafik blir det
**≈ 596 000 kr per inställt morgontåg** (akut inställt, se avsnitt 5).

## 4. Hemresa från Stockholm (kvällståget, 643)

### 4.1 Försenat tåg

```
per resenär = försening × 402 kr/h
```

Kommer man hem mer än **120 minuter** för sent förlorar tjänsteresenärerna **1 timme** arbetstid
förmiddagen efter (ungefär 25 % sämre arbetsförmåga under en förmiddag), och **25 %** måste lösa
hämtning eller barnomsorg för **800 kr**. Effekten växer gradvis under timmen före gränsen, så att
kostnaden inte hoppar på en enda minut.

| Försening | Summa (204 resenärer) |
|---|---|
| +30 min | ≈ 41 000 kr |
| +60 min | ≈ 82 000 kr |
| +120 min | ≈ 360 000 kr |

### 4.2 Inställt tåg

| Vad resenären gör | Andel | Antagande |
|---|---|---|
| Väntar på nästa tåg | 50 % | 2,5 h senare |
| Hotellnatt | 20 % | 2 800 kr, 4 h förlorad kväll, 3 h arbetstid dagen efter |
| Hyrbil eller buss | 20 % | 3 h senare, 550 kr |
| Annat (taxi, skjuts, sitter fast) | 10 % | 1 500 kr |

Alla som inte bor på hotell räknas också med förmiddagen efter och familjelogistik. Med
ersättningstrafik blir det **≈ 685 000 kr per inställt kvällståg** (akut inställt).

### 4.3 Kopplingen till morgontåget

Den som inte kom iväg på morgonen åker inte hem på kvällen. Ställdes ett bevakat tåg till
Stockholm in samma dag antas 60 % av hemresenärerna ha åkt upp med det. De tjänsteresenärer som då
deltog digitalt eller ställde in resan (40 % av tjänsteresenärerna) räknas inte igen på hemresan:

```
andel som aldrig åkte upp = 60 % × 80 % tjänsteresenärer × 40 % = 19 %
```

Var morgontåget delvis inställt räknas 75 % av det. Var det bara försenat påverkas inte hemresan.

## 5. Känt i förväg eller akut

**Inställt i förväg.** Ett tåg som ställs in minst **8 timmar** före avgång (t.ex. banarbete eller
dagen innan) kostar mindre: resenärerna bokar om, flyttar mötet, åker bil enligt plan eller deltar
digitalt, och ingen står och väntar. Resenärernas kostnad räknas då som **40 %** av en akut
inställning för utresan och **30 %** för hemresan. Ersättningstrafiken räknas fullt.

Tågkoll ser när Trafikverket senast ändrade de inställda raderna. Den tiden är som senast när
inställningen gjordes, så en inställning räknas aldrig som känd i förväg om den inte var det.

**Försening känd vid avgång.** Är tåget minst **30 minuter** sent redan när det lämnar startstationen
kan resenärerna välja som vid ett inställt tåg. Avgången räknas då **högst** som ett akut inställt tåg.

**Försening som uppstår under resan** har inget sådant tak. Då sitter resenärerna fast och kan inte
välja, och en mycket lång försening kan därför kosta mer än ett inställt tåg: +185 min under resan
≈ 637 000 kr, mot 596 000 kr för ett akut inställt morgontåg. Det är rimligt: ett tåg som är tre
timmar sent är sämre än nästa avgång, som resenärerna hade kunnat ta om tåget ställts in.

| Morgontåget | Kostnad |
|---|---|
| Inställt, akut | 596 000 kr |
| Inställt, känt i förväg | 268 000 kr |
| +185 min, uppstod under resan | 637 000 kr |
| +185 min, känt vid avgång | 596 000 kr (taket) |

Importerad historik saknar ändringstid och avgångsförsening och räknas som akut och som
försening under resan.

## 6. Spannet: lågt och högt scenario

Spannet räknas om med andra schabloner för det som är mest osäkert:

| | Lågt | Grund | Högt |
|---|---|---|---|
| Beläggning | 70 % | 85 % | 100 % |
| Konsulternas timvärde | 900 kr/h (arbetskostnad) | 1 250 kr/h | 1 350 kr/h (debitering) |
| Arbetsförmåga ombord under försening | 70 % | 60 % | 15 % |
| **Inställt morgontåg** | 468 000 kr | 596 000 kr | 705 000 kr |
| **+60 min morgontåg** | 145 000 kr | 200 000 kr | 326 000 kr |
| **Inställt kvällståg** | 540 000 kr | 685 000 kr | 810 000 kr |

## 7. Dold kostnad: resor kvällen före

När morgontåget är opålitligt åker en del till Stockholm kvällen före och bor på hotell för att
säkert hinna till mötet. Tågkoll räknar med **10 resenärer per avgång**, 2 800 kr i hotell och
traktamente och 4 timmar förlorad kväll: **≈ 44 000 kr per avgång**. Beloppet är svårt att belägga
och visas därför i en egen ruta, **utanför** summan.

## 8. Jämförelse med en annan beräkning

En annan samhällsekonomisk kalkyl för samma tågpar (300 resenärer, konsulter 45 % à 1 350 kr/h,
offentlig sektor 35 % à 650 kr/h, övriga 20 % à 220 kr/h) jämfördes med Tågkolls första modell.
Den nuvarande modellen tar in det som var bättre i den andra kalkylen och behåller det som var
bättre i Tågkolls.

| Per avgång | Tågkoll, första versionen (180 resenärer) | Andra kalkylen (300 resenärer) | **Tågkoll nu (204 resenärer)** |
|---|---|---|---|
| Morgontåget +60 min | 207 000 kr | 400 000 kr | **200 000 kr** |
| Morgontåget +120 min | 406 000 kr | 965 000 kr | **542 000 kr** |
| Inställt morgontåg (akut) | 411 000 kr | 2 110 000 kr | **596 000 kr** |
| Inställt kvällståg (akut) | 391 000 kr | 1 310 000 kr | **685 000 kr** |

**Från den andra kalkylen** har Tågkoll tagit: resenärsgrupper med egna timvärden, fler resenärer,
skillnaden mellan arbete ombord och utanför tåget, att en del vänder hem vid stor försening,
förmiddagen efter och familjelogistik efter sen hemkomst, högre hotellkostnad, ersättningstrafik och
den dolda kostnaden för resor kvällen före.

**Det som inte har tagits över:**

- **Försening ombord räknas inte som väntan på perrongen.** Den andra kalkylen räknar med 15 %
  arbetsförmåga även när man sitter kvar på sin plats. Det gör produktionsbortfallet vid en timmes
  försening ungefär tre gånger så stort.
- **Förseningsfaktorn läggs inte på arbetstid.** ASEK använder faktorn 3,5 även för tjänsteresor,
  så på den punkten följer den andra kalkylen ASEK bättre. Tågkoll räknar i stället följderna av
  förseningen var för sig (möten, vända hem, dagen efter), och att lägga faktorn ovanpå vore
  dubbelräkning. En renodlad ASEK-kalkyl (3,5 × arbetsgivarens kostnad × 85 % improduktiv tid) skulle
  ge ungefär dubbelt så höga belopp för försenade morgontåg som Tågkoll.
- **Alla som ska på möte missar inte.** Mötesförlusten vägs med marginal och sannolikhet.
- **Inte alla förlorar en halv arbetsdag.** Den andra kalkylens 1,15 miljoner kronor i
  produktionsbortfall för ett inställt morgontåg motsvarar att alla 300 förlorar drygt 4 timmar
  till fullt värde. Här tar många nästa tåg eller deltar digitalt.
- **SJ:s förseningsersättning** är en överföring mellan SJ och resenären, inte en kostnad för
  samhället. Bara hanteringen ingår, i ersättningstrafiken.
- **Årskostnaden** räknas från de verkliga utfallen som Tågkoll har samlat in, inte från antagna
  frekvenser.

Det höga scenariot använder den andra kalkylens antaganden om beläggning, konsulternas timvärde och
arbetsförmåga ombord. Resten av skillnaden kommer av punkterna ovan.

## 9. Vad som inte räknas in

- SJ:s förseningsersättning (se ovan).
- Följdförseningar för andra tåg på samma bana.
- Den dolda kostnaden räknas, men visas separat.

## 10. Källor och osäkerheter

- **ASEK 8.0** (Trafikverket, *Analysmetod och samhällsekonomiska kalkylvärden för
  transportsektorn*, 2 april 2024), kapitel 9: förseningstid = 3,5 × åktid för både privata resor
  och tjänsteresor (AR 9.12, 9.21); tjänsteresor värderas efter arbetsgivarens kostnad, bruttolön
  plus sociala avgifter (AR 9.7); tjänsteresenärer på tåg antas produktiva 15 % av resan (AR 9.9).
  Se även riksdagens utvärdering 2025/26:RFR21.
- **Restidsvärdet 115 kr/h:** ASEK anger 85 kr/h för långväga privata tågresor i 2017 års priser.
  Från ASEK 8.0 finns kalkylvärdena bara i kalkylbilagan (Excel), som inte gick att hämta; värdet är
  därför uppräknat för hand (+5 % rättning i ASEK 8.0, inflation 2017–2026). Kontrollera mot
  kalkylbilagan om det går.
- **Offentlig sektor 650 kr/h** innehåller omkostnader (lokaler, administration). ASEK räknar bara
  bruttolön plus sociala avgifter, vilket för statligt anställda blir ungefär 430 kr/h.
- **SJ 3000 (X55):** ca 240 platser per sätt.
- Andelar, sannolikheter och marginaler är antaganden. De bör kalibreras, helst med en enkät bland
  resenärerna (ändamål, marginal, vad de gjorde vid senaste inställningen).

## 11. Var siffrorna syns i Tågkoll

- **Nu-kortet** överst: kostnaden för den valda avgången, med en kort förklaring (akut inställt,
  känt i förväg, försening under resan).
- **Översikt:** samhällskostnaden för perioden som nyckeltal, med spann.
- **Kostnad:** summa och spann, kostnad per avgång, den dolda kostnaden (morgontåget), fördelningen
  mellan inställda och försenade avgångar, kostnad per vecka eller månad per slag och uppdelningen.
  Knappen **Så räknar vi** förklarar uträkningen med schablonerna som gäller just nu, med en kurva
  över kostnad mot försening och tabellen över scenarierna.
- **Avgångar:** kolumnen *Kostnad*, och sortering på dyrast.
- Importerad historik räknas också, eftersom den har status och försening.
