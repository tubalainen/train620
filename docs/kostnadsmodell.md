# Kostnadsmodell – vad kostar ett försenat eller inställt tåg samhället?

Tågkoll räknar ut en ungefärlig **samhällskostnad** för varje avgång som har bevakats. Det här
dokumentet beskriver modellen, schablonerna och hur siffrorna ska läsas. Koden finns i
`app/cost.py`, och schablonerna kan ändras på `/admin` under *Kostnadsmodell*.

> Siffrorna är **förväntade värden** som bygger på schabloner. En enskild avgång kan i
> verkligheten kosta mer eller mindre. Över många avgångar ger genomsnittet ändå en rimlig bild av
> storleksordningen. Därför visas alltid ett spann (låg–hög) bredvid grundberäkningen.

## 1. Två riktningar, två slags kostnader

| | Utresa till Stockholm (t.ex. 620 på morgonen) | Hemresa från Stockholm (t.ex. 643 på kvällen) |
|---|---|---|
| Vad står på spel | Det man skulle göra i Stockholm: möten, konferenser, utbildningar, övningar | Kvällen, natten och morgonen efter |
| Var kostnaden tar ett hopp | När förseningen blir större än marginalen till mötet | När det inte går att komma hem samma kväll, så att det blir hotell |
| Vems tid går förlorad | Resenärens arbetstid och **andras** tid i mötet | Främst resenärens egen tid |

Riktningen bestäms av tågets start- och slutstation: slutar tåget i Stockholm är det en utresa,
börjar det i Stockholm är det en hemresa. Tåg som inte går till eller från Stockholm får ingen
kostnadsberäkning.

## 2. Grundformel

För varje avgång:

```
kostnad = antal drabbade resenärer × kostnad per resenär
```

Kostnaden per resenär beror på vad som hände (i tid, försenat, delvis inställt, inställt) och
delas upp i fyra slag:

| Slag | Innehåll |
|---|---|
| Förlorad tid | Förlorad arbetstid och förseningstid på fritid |
| Missade möten | Möten, konferenser, utbildningar och övningar som resenärer kommer sent till eller missar (bara utresa) |
| Hotellnätter | Hotell, mat och traktamente (bara hemresa) |
| Andra resor | Bil, hyrbil, buss, taxi |

Förseningar upp till **5 minuter** räknas inte; de antas rymmas i normal marginal.
**Delvis inställda** avgångar räknas som **75 %** av ett helt inställt tåg, eftersom bara
resenärerna efter platsen där tåget stannade drabbas fullt och det ofta finns ersättningsbuss.

## 3. Utresa till Stockholm

### 3.1 Förväntad mötesförlust

Kärnan är den förväntade kostnaden när en resenär **inte kommer fram alls**. Den räknas som ett
viktat medelvärde över vad resenärerna ska göra i Stockholm:

```
mötesförlust = Σ andel(ändamål) × sannolikhet(att frånvaron får betydelse) × kostnad(när den får det)
```

| Ändamål | Andel | Sannolikhet | Kostnad när den får betydelse | Förväntat |
|---|---|---|---|---|
| Konsult eller dagpendlare utan fast mötestid | 30 % | 10 % | 5 000 kr (kundmöte flyttas) | 500 kr |
| Internt arbetsmöte | 30 % | 20 % | 6 000 kr (6 personer × 2 h) | 1 200 kr |
| Externt möte eller samverkan mellan myndigheter | 20 % | 35 % | 15 000 kr (8 personer × 3 h, andras resor) | 5 250 kr |
| Konferens eller utbildning | 15 % | 70 % | 6 000 kr (avgift, bokningar, innehåll) | 4 200 kr |
| Övning eller större samordnad aktivitet | 5 % | 40 % | 40 000 kr (20 personer × 4 h) | 16 000 kr |
| **Viktat** | | | | **≈ 2 990 kr** |

Sannolikheten fångar att det **inte alltid** kostar stora pengar när någon uteblir: många möten
kan genomföras ändå, flyttas utan större skada eller hållas digitalt.

### 3.2 Försenat tåg: marginal och effekt

En försening kostar bara för den som har **mindre marginal** mellan ankomst och mötets början än
förseningen. Fördelningen av marginalen:

| Marginal | Andel |
|---|---|
| Under 15 min | 25 % |
| 15–45 min | 35 % |
| 45–90 min | 20 % |
| Mer än 90 min eller flexibel tid | 20 % (räknas som 90–180 min) |

Inom varje intervall antas resenärerna vara jämnt fördelade. Vid 30 minuters försening drabbas
alltså hela första gruppen och halva den andra.

Den som drabbas förlorar en del av mötesförlusten, beroende på hur sen hen blir:

| Försening | Andel av mötesförlusten |
|---|---|
| Under 30 min (missar början) | 15 % |
| 30–90 min | 40 % |
| Mer än 90 min | 60 % |

Till det kommer förlorad arbetstid: förseningen × **500 kr/h** (arbetsgivarens kostnad), minus
**30 %** som antas bli arbetstid ombord.

```
kostnad per resenär = försening(h) × 500 × (1 − 0,30)
                    + andel med för liten marginal × effekt × mötesförlust
```

Räkneexempel med 180 resenärer:

| Försening | Tid | Möten | Summa |
|---|---|---|---|
| +10 min | ca 10 500 kr | ca 13 500 kr | **≈ 24 000 kr** |
| +25 min | ca 26 000 kr | ca 30 000 kr | **≈ 56 000 kr** |
| +60 min | ca 63 000 kr | ca 144 000 kr | **≈ 207 000 kr** |
| +120 min | ca 126 000 kr | ca 280 000 kr | **≈ 406 000 kr** |

Kostnaden växer alltså **inte i proportion till minuterna**. Den tar ett hopp när marginalerna tar
slut, ungefär mellan 30 och 60 minuter.

### 3.3 Inställt tåg

| Vad resenären gör | Andel | Tid och direkta kostnader | Mötesförlust | Per person |
|---|---|---|---|---|
| Tar nästa tåg (2 h senare) | 45 % | 2 h × 500 × 0,7 = 700 kr | 60 % | ≈ 2 490 kr |
| Tar bilen | 15 % | 1 150 kr (bil, tid, utsläpp, olycksrisk) | 40 % | ≈ 2 350 kr |
| Deltar digitalt | 25 % | 250 kr (omplanering) | 20 % | ≈ 850 kr |
| Ställer in resan | 15 % | 2 h × 500 = 1 000 kr | 100 % | ≈ 3 990 kr |
| **Viktat** | | | | **≈ 2 280 kr** |

Med 180 resenärer blir det **≈ 410 000 kr per inställt morgontåg**.

### 3.4 Dold kostnad som inte räknas

När morgontåget är opålitligt anpassar sig resenärerna i förväg: de tar ett tidigare tåg, åker
kvällen före och bor på hotell, eller tackar nej till möten i Stockholm. Det kostar även de dagar
då tåget går i tid. Den kostnaden är svår att belägga och **ingår inte** i Tågkolls siffror.

## 4. Hemresa från Stockholm

### 4.1 Försenat tåg

```
kostnad per resenär = försening(h) × 450 kr/h
```

450 kr/h är värdet av en förseningstimme på fritid. Trafikverkets kalkylvärden (ASEK) värderar
förseningstid ungefär 3,5 gånger högre än vanlig restid. En timmes försening för 180 resenärer
kostar alltså ≈ 81 000 kr.

### 4.2 Inställt tåg

| Vad resenären gör | Andel | Kostnad per person |
|---|---|---|
| Väntar på nästa tåg (2,5 h senare) | 50 % | 2,5 h × 450 = 1 125 kr |
| Hotellnatt | 20 % | 2 100 kr (hotell, mat) + 4 h kväll × 450 + 3 h arbete dagen efter × 500 = 5 400 kr |
| Hyrbil eller buss (3 h senare) | 20 % | 3 h × 450 + 550 kr = 1 900 kr |
| Annat (taxi, skjuts, sitter fast) | 10 % | 1 500 kr |
| **Viktat** | | **≈ 2 170 kr** |

Med 180 resenärer blir det **≈ 390 000 kr per inställt kvällståg**.

### 4.3 Kopplingen till morgontåget

Den som inte kom iväg på morgonen åker inte hem på kvällen. Om ett bevakat tåg till Stockholm
ställdes in samma dag minskas antalet hemresenärer:

```
andel som aldrig åkte upp = 60 % (åkte upp med morgontåget)
                          × (25 % digitalt + 15 % ställde in resan) = 24 %
```

Var morgontåget delvis inställt räknas 75 % av det. Var det bara försenat påverkas inte
hemresan. Har båda tågen problem samma dag räknas båda, eftersom resenärerna då har drabbats
två gånger.

## 5. Osäkerhet

Det största osäkra värdet är **antalet resenärer**: SJ publicerar inte beläggning per avgång, och
den finns inte i Trafikverkets API. Därför visas ett spann:

- **Låg:** 50 % av grundberäkningen.
- **Hög:** 160 % av grundberäkningen.

Spannet är en grov markering, inte ett statistiskt konfidensintervall.

## 6. Vad som inte räknas in

- **SJ:s förseningsersättning** är en överföring mellan SJ och resenären, inte en kostnad för
  samhället. Den ingår inte.
- **Konsulternas uteblivna debitering** är företagets förlust. För samhället räknas den
  förlorade produktionen, värderad till arbetskostnad.
- **Dold anpassning** (se 3.4).
- **Följdförseningar** för andra tåg på samma bana.

## 7. Schabloner och källor

Alla schabloner finns på adminsidan med inbyggt värde, nuvarande värde och förklaring. De
viktigaste:

| Schablon | Värde | Grund |
|---|---|---|
| Arbetsgivarens kostnad per arbetstimme | 500 kr/h | Månadslön ca 45 000 kr med sociala avgifter och omkostnader, ca 160 h/mån |
| Värde per förseningstimme på fritid | 450 kr/h | ASEK: förseningstid värderas ca 3,5 × restid för långväga tåg |
| Resenärer per avgång | 180 | Antagande: ca 300 platser, ca 75 % beläggning, ca 80 % till eller från Karlstad med omnejd |
| Hotellnatt med mat | 2 100 kr | Hotell i Stockholm 1 500–2 000 kr plus middag och frukost |
| Övriga andelar och sannolikheter | se ovan | Antaganden, ska kalibreras |

**Att göra:** kontrollera tidsvärdena mot den senaste versionen av Trafikverkets ASEK och
kalibrera andelarna, helst med en enkät bland resenärerna (ändamål, marginal, vad de gjorde vid
senaste inställningen).

## 8. Var siffrorna syns i Tågkoll

- Kortet **Samhällskostnad** på dashboarden: summa och spann för vald period, uppdelning per slag,
  kostnad per vecka eller månad och de dyraste avgångarna.
- Knappen **ⓘ Så räknar vi** öppnar en ruta med uträkningen, schablonerna som gäller just nu och
  en kurva över kostnad mot försening.
- Kolumnen **Kostnad** i tabellen över avgångar.
- Importerad historik räknas också, eftersom den har status och försening.
