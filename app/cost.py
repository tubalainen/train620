"""Samhällskostnad för förseningar och inställda tåg.

Modellen beskrivs i docs/kostnadsmodell.md. Kort:

* Resenärerna delas i tre grupper: konsulter och näringsliv, offentlig sektor och övriga. De två
  första reser i tjänsten och värderas till sitt timvärde i arbetstid. Övrigas tid, och allas
  tid på kvällen, värderas som förseningstid enligt Trafikverkets ASEK (3,5 × restidsvärdet).
* Hur mycket arbetstid som går förlorad beror på var resenären är: ombord kan de flesta arbeta,
  på perrongen, i ersättningsbussen eller bakom ratten nästan inte.
* En inställning som var känd i förväg kostar mindre än en akut, och en försening som var känd
  redan vid avgång kostar högst som ett inställt tåg (resenärerna kan välja som vid inställt).
* Ett tåg *till* Stockholm (620 på morgonen) räknas som **utresa**: förlorad arbetstid plus den
  förväntade kostnaden för möten, konferenser, utbildningar och övningar som resenärerna kommer
  sent till eller missar. En försening kostar bara för den som har mindre marginal än
  förseningen. Vid mycket stor försening vänder en del hem.
* Ett tåg *från* Stockholm (643 på kvällen) räknas som **hemresa**: förlorad kväll, hotellnätter,
  andra resor, familjelogistik och sämre arbetsförmåga förmiddagen efter.
* Inställda avgångar kostar dessutom ersättningstrafik och hantering.

Alla belopp är schabloner. De kan ändras på adminsidan och sparas i tabellen cost_params.
Resultatet är ett förväntat värde: en enskild avgång kan kosta mer eller mindre.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass(frozen=True)
class Param:
    key: str
    group: str
    label: str
    unit: str        # "kr", "kr/h", "h", "min", "%", "st", "×"
    default: float
    help: str
    max: float = 1_000_000


GROUPS = {
    "common": "Tåget och resenärerna",
    "values": "Timvärden",
    "productivity": "Arbete under resan",
    "out": "Utresa till Stockholm (morgon)",
    "out_purpose": "Utresa: vad tjänsteresenärerna ska göra i Stockholm",
    "out_margin": "Utresa: marginal mellan ankomst och mötets början",
    "out_effect": "Utresa: hur stor del av mötesförlusten som räknas",
    "out_cancel": "Utresa: vad tjänsteresenärerna gör när tåget ställs in",
    "home": "Hemresa från Stockholm (kväll)",
    "home_cancel": "Hemresa: vad resenärerna gör när tåget ställs in",
    "known": "Känt i förväg",
    "operations": "Ersättningstrafik och hantering",
    "hidden": "Dold kostnad: resor kvällen före",
    "scenario": "Spann: lågt och högt scenario",
}

# Ändamål för tjänsteresenärerna (konsulter och offentlig sektor):
# (nyckel, etikett, andel %, sannolikhet att frånvaron får betydelse %, kostnad när den får det kr, förklaring)
PURPOSES = [
    ("consult", "Kunduppdrag eller arbete på plats utan fast mötestid", 30, 15, 8000,
     "Arbete hos kund som flyttas eller blir digitalt: ca 4–8 h, ibland med kundens tid."),
    ("internal", "Internt arbetsmöte", 30, 20, 6000,
     "Mötet flyttas eller genomförs sämre: ca 6 personer × 2 h."),
    ("external", "Externt möte, förhandling eller samverkan", 20, 35, 15000,
     "Motparter väntar förgäves, andras resor, ny bokning: ca 8 personer × 3 h."),
    ("conference", "Konferens eller utbildning", 15, 70, 6000,
     "Avgift, bokningar och innehåll som går förlorat."),
    ("exercise", "Övning eller större samordnad aktivitet", 5, 40, 40000,
     "Moment kan inte genomföras: ca 20 personer × 4 h."),
]

# Marginal mellan ankomst till Stockholm och mötets början: (nyckel, etikett, från min, till min, andel %).
MARGINS = [
    ("m15", "Under 15 min", 0, 15, 25),
    ("m45", "15–45 min", 15, 45, 35),
    ("m90", "45–90 min", 45, 90, 20),
    ("mflex", "Mer än 90 min eller flexibel tid", 90, 180, 20),
]

PARAMS: list[Param] = [
    Param("seats", "common", "Sittplatser per avgång", "st", 240,
          "SJ 3000 (X55) har ca 240 platser. Ange dubbelt så många om tåget går med två sätt.", 2000),
    Param("occupancy", "common", "Beläggning i snitt", "%", 85, "Andel av platserna som är upptagna.", 100),
    Param("share_consult", "common", "Konsulter och näringsliv: andel av resenärerna", "%", 40,
          "Reser i tjänsten. Värderas med konsulternas timvärde.", 100),
    Param("share_public", "common", "Offentlig sektor: andel av resenärerna", "%", 40,
          "Myndigheter, region, kommun, försvar. Reser i tjänsten.", 100),
    Param("share_other", "common", "Övriga (pendlare, studenter, privatresor): andel", "%", 20,
          "Deras tid värderas som förseningstid enligt ASEK.", 100),
    Param("min_delay", "common", "Förseningar som inte räknas", "min", 5,
          "Förseningar upp till så här många minuter ryms i normal marginal och kostar inget i modellen.", 60),
    Param("partial_factor", "common", "Delvis inställt räknas som andel av helt inställt", "%", 75,
          "Resenärer efter platsen där tåget stannade drabbas som vid inställt. Ofta finns ersättningsbuss.", 100),

    Param("hour_consult", "values", "Konsulter: värde per arbetstimme", "kr/h", 1250,
          "Genomsnittligt värde av en konsulttimme."),
    Param("hour_public", "values", "Offentlig sektor: kostnad per arbetstimme", "kr/h", 650,
          "Lön, arbetsgivaravgifter och omkostnader (ASEK värderar tjänsteresor efter arbetsgivarens kostnad)."),
    Param("hour_leisure", "values", "Restidsvärde på fritid", "kr/h", 115,
          "ASEK: långväga privata resor med tåg, 85 kr/h i 2017 års priser, uppräknat till dagens penningvärde (+5 % rättning i ASEK 8.0, inflation)."),
    Param("delay_factor", "values", "Förseningsfaktor (ASEK)", "×", 3.5,
          "ASEK värderar förseningstid till 3,5 gånger normal restid.", 10),

    Param("prod_onboard", "productivity", "Arbetsförmåga ombord under försening", "%", 60,
          "Andel av förseningstiden ombord som tjänsteresenärerna kan använda till arbete.", 100),
    Param("prod_offboard", "productivity", "Arbetsförmåga utanför tåget", "%", 15,
          "På perrongen, i ersättningsbuss, på ett överfullt tåg eller bakom ratten.", 100),

    Param("abort_after", "out", "Gräns för att vända hem", "min", 90,
          "Vid större försening vänder en del tjänsteresenärer hem; resans syfte faller.", 600),
    Param("abort_share", "out", "Andel tjänsteresenärer som vänder hem", "%", 25, "", 100),
    Param("abort_hours", "out", "Förlorad arbetstid för den som vänder hem", "h", 3,
          "Netto, efter det som går att göra hemifrån resten av dagen.", 24),

    *[p for key, label, share, prob, cost, help_ in PURPOSES for p in (
        Param(f"purpose_{key}_share", "out_purpose", f"{label}: andel", "%", share, help_, 100),
        Param(f"purpose_{key}_prob", "out_purpose", f"{label}: sannolikhet att frånvaron får betydelse", "%", prob,
              "Hur ofta en utebliven resenär faktiskt leder till en kostnad.", 100),
        Param(f"purpose_{key}_cost", "out_purpose", f"{label}: kostnad när den får det", "kr", cost, help_),
    )],

    *[Param(f"margin_{key}", "out_margin", f"Marginal {label.lower()}", "%", share,
            "Andel av tjänsteresenärerna. Den som har mindre marginal än förseningen drabbas.", 100)
      for key, label, _lo, _hi, share in MARGINS],

    Param("effect_lt30", "out_effect", "Sen under 30 min (missar början)", "%", 15,
          "Andel av den fulla mötesförlusten.", 100),
    Param("effect_30_90", "out_effect", "Sen 30–90 min", "%", 40, "Andel av den fulla mötesförlusten.", 100),
    Param("effect_gt90", "out_effect", "Sen mer än 90 min eller nästa tåg", "%", 60,
          "Andel av den fulla mötesförlusten.", 100),
    Param("digital_onboard_share", "out_effect", "Deltar digitalt från tåget vid minst 30 min försening", "%", 25,
          "Andel av de sena som kopplar upp sig på mötet från tåget. De förlorar bara den del som gäller digitalt deltagande.", 100),

    Param("out_next_share", "out_cancel", "Tar nästa tåg: andel", "%", 45, "", 100),
    Param("out_next_hours", "out_cancel", "Tar nästa tåg: senare ankomst", "h", 2,
          "Väntan och resa med låg arbetsförmåga. Övriga resenärer tar också nästa tåg.", 24),
    Param("out_car_share", "out_cancel", "Tar bilen: andel", "%", 15, "", 100),
    Param("out_car_cost", "out_cancel", "Tar bilen: kostnad per person", "kr", 1150,
          "Bil delad på flera, utsläpp och olycksrisk."),
    Param("out_car_hours", "out_cancel", "Tar bilen: tid utan arbete", "h", 1,
          "Extra tid jämfört med tåget, när man kör eller inte kan arbeta.", 24),
    Param("out_car_effect", "out_cancel", "Tar bilen: andel av mötesförlusten", "%", 40, "", 100),
    Param("out_digital_share", "out_cancel", "Deltar digitalt: andel", "%", 25, "", 100),
    Param("out_digital_hours", "out_cancel", "Deltar digitalt: förlorad arbetstid", "h", 0.5,
          "Omplanering.", 24),
    Param("out_digital_effect", "out_cancel", "Deltar digitalt: andel av mötesförlusten", "%", 20, "", 100),
    Param("out_stay_share", "out_cancel", "Ställer in resan: andel", "%", 15,
          "Hela mötesförlusten räknas.", 100),
    Param("out_stay_hours", "out_cancel", "Ställer in resan: förlorad arbetstid", "h", 2,
          "Förmiddagen som gick åt till att vänta och planera om.", 24),

    Param("home_paired_share", "home", "Andel som åkte upp med morgontåget samma dag", "%", 60,
          "Ställs morgontåget in åker en del aldrig upp. De räknas inte igen på hemresan.", 100),
    Param("late_after", "home", "Så sen försening att förmiddagen efter påverkas", "min", 120,
          "Den som kommer hem så här mycket senare (eller efter inställt tåg) är tröttare dagen efter. Effekten växer gradvis under timmen före gränsen.", 600),
    Param("nextday_hours", "home", "Förlorad arbetstid förmiddagen efter", "h", 1,
          "Ca 25 % sämre arbetsförmåga under en förmiddag. Gäller tjänsteresenärerna.", 24),
    Param("family_share", "home", "Andel med hämtning eller barnomsorg som måste lösas", "%", 25,
          "Gäller vid inställt tåg och vid så sen försening som ovan.", 100),
    Param("family_cost", "home", "Familjelogistik: kostnad per berörd", "kr", 800,
          "En partner som går från jobbet tidigare, extra barnvakt, ställda aktiviteter."),

    Param("home_next_share", "home_cancel", "Väntar på nästa tåg: andel", "%", 50, "", 100),
    Param("home_next_hours", "home_cancel", "Väntar på nästa tåg: senare ankomst", "h", 2.5, "", 24),
    Param("home_hotel_share", "home_cancel", "Hotellnatt: andel", "%", 20, "", 100),
    Param("home_hotel_cost", "home_cancel", "Hotellnatt: hotell, traktamente och ombokning", "kr", 2800,
          "Ca 2 500–3 500 kr per person."),
    Param("home_hotel_evening", "home_cancel", "Hotellnatt: förlorad kväll hemma", "h", 4,
          "Värderas som förseningstid.", 24),
    Param("home_hotel_work", "home_cancel", "Hotellnatt: förlorad arbetstid dagen efter", "h", 3,
          "Hemresan sker på arbetstid nästa morgon.", 24),
    Param("home_alt_share", "home_cancel", "Hyrbil eller buss: andel", "%", 20, "", 100),
    Param("home_alt_hours", "home_cancel", "Hyrbil eller buss: senare ankomst", "h", 3, "", 24),
    Param("home_alt_cost", "home_cancel", "Hyrbil eller buss: kostnad per person", "kr", 550,
          "Hyrbil delad på flera och bränsle, eller bussbiljett."),
    Param("home_other_share", "home_cancel", "Annat (taxi, skjuts, sitter fast): andel", "%", 10, "", 100),
    Param("home_other_cost", "home_cancel", "Annat: kostnad per person", "kr", 1500, ""),

    Param("known_delay_after", "known", "Försening vid avgång som räknas som känd", "min", 30,
          "Är tåget så här sent redan vid avgång kan resenärerna välja som vid inställt. Avgången räknas då högst som ett inställt tåg.", 600),
    Param("advance_hours", "known", "Inställt i förväg: känt minst så här länge före avgång", "h", 8,
          "Tågkoll ser när Trafikverket senast ändrade den inställda avgången. Gäller bara avgångar som samlats in från Trafikverket.", 168),
    Param("advance_out", "known", "Inställt i förväg, utresa: resenärernas kostnad som andel av akut inställt", "%", 40,
          "Resenärerna bokar om, flyttar mötet, kör bil enligt plan eller deltar digitalt. Ingen väntan på perrongen.", 100),
    Param("advance_home", "known", "Inställt i förväg, hemresa: resenärernas kostnad som andel av akut inställt", "%", 30,
          "Resenärerna åker hem tidigare, bokar annat tåg eller hotell i lugn och ro. Nästan inga akuta lösningar.", 100),
    Param("ops_cost", "operations", "Ersättningstrafik och hantering per inställd avgång", "kr", 50000,
          "Ersättningsbussar, taxi, personal och administration. SJ:s förseningsersättning räknas inte: den är en överföring."),

    Param("hidden_per_day", "hidden", "Resenärer som åker kvällen före för säkerhets skull", "st", 10,
          "Per avgång med morgontåget. Visas separat och ingår inte i summan.", 2000),
    Param("hidden_evening", "hidden", "Förlorad kväll hemma", "h", 4, "Värderas som förseningstid.", 24),
    Param("hidden_hotel", "hidden", "Hotell och traktamente", "kr", 2800, ""),

    Param("low_occupancy", "scenario", "Lågt: beläggning", "%", 70, "", 100),
    Param("low_hour_consult", "scenario", "Lågt: konsulternas timvärde", "kr/h", 900,
          "Arbetskostnad i stället för debiteringsvärde."),
    Param("low_prod_onboard", "scenario", "Lågt: arbetsförmåga ombord", "%", 70, "", 100),
    Param("high_occupancy", "scenario", "Högt: beläggning", "%", 100, "", 100),
    Param("high_hour_consult", "scenario", "Högt: konsulternas timvärde", "kr/h", 1350, "Debiteringsvärde."),
    Param("high_prod_onboard", "scenario", "Högt: arbetsförmåga ombord", "%", 15,
          "Som om ingen kan arbeta under förseningen.", 100),
]
PARAM_BY_KEY = {p.key: p for p in PARAMS}
DEFAULTS = {p.key: p.default for p in PARAMS}

KINDS = {
    "time": "Förlorad tid",
    "meetings": "Missade möten",
    "nextday": "Dagen efter och familj",
    "hotel": "Hotellnätter",
    "travel": "Andra resor",
    "ops": "Ersättningstrafik",
}


def validate(values: dict[str, float]) -> dict[str, float]:
    """Kontrollerar nya schabloner. Fel ger ValueError med en text för användaren."""
    out = {}
    for key, value in values.items():
        p = PARAM_BY_KEY.get(key)
        if not p:
            raise ValueError(f"Okänd schablon: {key[:40]}")
        try:
            v = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{p.label}: ange ett tal.") from None
        if v != v or not 0 <= v <= p.max:
            raise ValueError(f"{p.label}: ange ett värde mellan 0 och {p.max:g}.")
        out[key] = v
    return out


def scenario(p: dict, which: str) -> dict:
    """Schablonerna för det låga eller höga scenariot."""
    if which == "base":
        return p
    return {**p, "occupancy": p[f"{which}_occupancy"], "hour_consult": p[f"{which}_hour_consult"],
            "prod_onboard": p[f"{which}_prod_onboard"]}


# --------------------------------------------------------------- beräkning

def profile_for(origin: str | None, destination: str | None) -> str | None:
    """'out' för tåg till Stockholm, 'home' för tåg från Stockholm, annars None."""
    def sthlm(name):
        return bool(name) and name.casefold().startswith("stockholm")
    if sthlm(destination) and not sthlm(origin):
        return "out"
    if sthlm(origin) and not sthlm(destination):
        return "home"
    return None


def _shares(p: dict, keys: list[str]) -> list[float]:
    """Andelar i procent som bråk. Summerar de inte till 100 skalas de om."""
    raw = [max(0.0, p[k]) for k in keys]
    total = sum(raw)
    return [r / total for r in raw] if total else [0.0] * len(raw)


def passengers(p: dict) -> float:
    return p["seats"] * p["occupancy"] / 100


def groups(p: dict) -> dict:
    """Andelar och timvärden. 'work' = tjänsteresenärernas andel och deras snittvärde per arbetstimme."""
    s_c, s_p, s_o = _shares(p, ["share_consult", "share_public", "share_other"])
    work = s_c + s_p
    return {"consult": s_c, "public": s_p, "other": s_o, "work": work,
            "work_hour": (s_c * p["hour_consult"] + s_p * p["hour_public"]) / work if work else 0.0,
            "delay_hour": p["hour_leisure"] * p["delay_factor"]}


def meeting_loss(p: dict) -> float:
    """Förväntad mötesförlust i kr när en tjänsteresenär inte kommer fram alls."""
    keys = [key for key, *_ in PURPOSES]
    shares = _shares(p, [f"purpose_{k}_share" for k in keys])
    return sum(s * p[f"purpose_{k}_prob"] / 100 * p[f"purpose_{k}_cost"] for s, k in zip(shares, keys))


def _affected(p: dict, delay: float) -> float:
    """Andel vars marginal är mindre än förseningen (linjärt inom varje intervall)."""
    shares = _shares(p, [f"margin_{key}" for key, *_ in MARGINS])
    return sum(share * min(1.0, max(0.0, (delay - lo) / (hi - lo)))
               for share, (_k, _l, lo, hi, _d) in zip(shares, MARGINS))


def _effect(p: dict, delay: float) -> float:
    if delay < 30:
        return p["effect_lt30"] / 100
    if delay <= 90:
        return p["effect_30_90"] / 100
    return p["effect_gt90"] / 100


def _empty() -> dict[str, float]:
    return {k: 0.0 for k in KINDS}


def out_delayed(p: dict, delay: float) -> dict[str, float]:
    """Kostnad per resenär (snitt över alla grupper) för en försenad utresa."""
    c = _empty()
    if delay <= p["min_delay"]:
        return c
    g = groups(p)
    m = meeting_loss(p)
    stay = delay / 60 * g["work_hour"] * (1 - p["prod_onboard"] / 100)
    effect = _effect(p, delay)
    if delay >= 30:  # en del av de sena deltar digitalt från tåget i stället
        d = p["digital_onboard_share"] / 100
        effect = (1 - d) * effect + d * min(effect, p["out_digital_effect"] / 100)
    meet = _affected(p, delay) * effect * m
    a = p["abort_share"] / 100 if delay > p["abort_after"] else 0.0
    c["time"] = g["work"] * ((1 - a) * stay + a * p["abort_hours"] * g["work_hour"]) + g["other"] * delay / 60 * g["delay_hour"]
    c["meetings"] = g["work"] * ((1 - a) * meet + a * m)
    return c


def out_cancelled(p: dict) -> dict[str, float]:
    """Kostnad per resenär (snitt över alla grupper) för en inställd utresa."""
    g = groups(p)
    m = meeting_loss(p)
    v = g["work_hour"]
    s_next, s_car, s_dig, s_stay = _shares(p, ["out_next_share", "out_car_share", "out_digital_share", "out_stay_share"])
    c = _empty()
    work_time = (s_next * p["out_next_hours"] * v * (1 - p["prod_offboard"] / 100)
                 + s_car * p["out_car_hours"] * v + s_dig * p["out_digital_hours"] * v + s_stay * p["out_stay_hours"] * v)
    c["time"] = g["work"] * work_time + g["other"] * p["out_next_hours"] * g["delay_hour"]
    c["travel"] = g["work"] * s_car * p["out_car_cost"]
    c["meetings"] = g["work"] * m * (s_next * p["effect_gt90"] / 100 + s_car * p["out_car_effect"] / 100
                                     + s_dig * p["out_digital_effect"] / 100 + s_stay)
    return c


def _late_extra(p: dict, g: dict) -> dict[str, float]:
    """Dagen efter och familjelogistik, per resenär, när hemkomsten blir mycket sen."""
    return {"nextday": g["work"] * p["nextday_hours"] * g["work_hour"] + p["family_share"] / 100 * p["family_cost"]}


def home_delayed(p: dict, delay: float) -> dict[str, float]:
    c = _empty()
    if delay <= p["min_delay"]:
        return c
    g = groups(p)
    c["time"] = delay / 60 * g["delay_hour"]
    # Växer gradvis under timmen före gränsen, i stället för att slå till på en enda minut.
    ramp = min(1.0, max(0.0, (delay - p["late_after"] + 60) / 60))
    if ramp:
        c["nextday"] = ramp * _late_extra(p, g)["nextday"]
    return c


def home_cancelled(p: dict) -> dict[str, float]:
    g = groups(p)
    s_next, s_hotel, s_alt, s_other = _shares(p, ["home_next_share", "home_hotel_share", "home_alt_share", "home_other_share"])
    c = _empty()
    c["time"] = (s_next * p["home_next_hours"] + s_hotel * p["home_hotel_evening"] + s_alt * p["home_alt_hours"]) * g["delay_hour"]
    late = _late_extra(p, g)["nextday"]
    # Hotellgästerna förlorar i stället arbetstid när de reser hem nästa morgon.
    c["nextday"] = (1 - s_hotel) * late + s_hotel * g["work"] * p["home_hotel_work"] * g["work_hour"]
    c["hotel"] = s_hotel * p["home_hotel_cost"]
    c["travel"] = s_alt * p["home_alt_cost"] + s_other * p["home_other_cost"]
    return c


def known_in_advance(p: dict, j: dict) -> dict:
    """Om inställningen var känd i förväg, och om förseningen var känd redan vid avgång.

    Bygger på Trafikverkets ändringstid för de inställda raderna och på avgångsförseningen.
    Importerad historik saknar båda och räknas därför som akut.
    """
    advance = False
    if j.get("status") in ("cancelled", "partial") and j.get("canceled_known_at") and j.get("planned_departure"):
        try:
            known = datetime.fromisoformat(j["canceled_known_at"])
            dep = datetime.fromisoformat(j["planned_departure"])
            advance = known <= dep - timedelta(hours=p["advance_hours"])
        except (TypeError, ValueError):
            advance = False
    dep_delay = j.get("departure_delay")
    late_at_start = j.get("status") in ("delayed", "ontime") and dep_delay is not None and dep_delay >= p["known_delay_after"]
    return {"advance": advance, "late_at_start": late_at_start}


def journey_cost(p: dict, profile: str, status: str, delay: int | None, stayed_home: float = 0.0,
                 advance: bool = False, late_at_start: bool = False) -> dict | None:
    """Kostnad för en avgång, eller None om den inte går att räkna (planerad, uppgift saknas).

    stayed_home är andelen av hemresenärerna som aldrig åkte upp (morgontåget inställt samma dag).
    advance: inställningen var känd i förväg, så resenärerna hann planera om.
    late_at_start: förseningen var känd redan vid avgång, så avgången kostar högst som ett inställt tåg.
    """
    if status not in ("ontime", "delayed", "partial", "cancelled"):
        return None
    n = passengers(p) * (1 - stayed_home if profile == "home" else 1)
    cancelled, delayed = (out_cancelled, out_delayed) if profile == "out" else (home_cancelled, home_delayed)
    ops = 0.0
    capped = False
    if status in ("cancelled", "partial"):
        f = p["partial_factor"] / 100 if status == "partial" else 1.0
        if advance:
            f *= p["advance_out" if profile == "out" else "advance_home"] / 100
        per = {k: v * f for k, v in cancelled(p).items()}
        ops = p["ops_cost"] * (p["partial_factor"] / 100 if status == "partial" else 1.0)
    else:
        per = delayed(p, delay or 0)
        if late_at_start:
            cap = cancelled(p)
            if sum(per.values()) > sum(cap.values()):
                per, ops, capped = cap, p["ops_cost"], True
    kinds = {k: round(v * n) for k, v in per.items()}
    kinds["ops"] = round(ops)
    return {"total": sum(kinds.values()), "kinds": kinds, "passengers": round(n), "advance": advance, "capped": capped}


def stayed_home_share(p: dict, morning_status: str | None) -> float:
    """Andel av hemresenärerna som inte åkte upp, givet morgontågets status samma dag."""
    if morning_status not in ("cancelled", "partial"):
        return 0.0
    g = groups(p)
    _n, _c, s_dig, s_stay = _shares(p, ["out_next_share", "out_car_share", "out_digital_share", "out_stay_share"])
    share = p["home_paired_share"] / 100 * g["work"] * (s_dig + s_stay)
    return share * (p["partial_factor"] / 100 if morning_status == "partial" else 1)


def hidden_cost(p: dict) -> float:
    """Dold kostnad per avgång med morgontåget: resenärer som åkt kvällen före för säkerhets skull."""
    return p["hidden_per_day"] * (p["hidden_hotel"] + p["hidden_evening"] * groups(p)["delay_hour"])


def explain(p: dict, profile: str) -> dict:
    """Mellanresultat som visas i informationsrutan, så att uträkningen går att följa."""
    g = groups(p)
    n = passengers(p)
    examples = [{"delay": d, **journey_cost(p, profile, "delayed", d)} for d in (10, 30, 60, 120)]
    per = out_cancelled(p) if profile == "out" else home_cancelled(p)
    cancelled = journey_cost(p, profile, "cancelled", None)
    return {
        "passengers": round(n),
        "work_share": g["work"],
        "work_hour": round(g["work_hour"]),
        "delay_hour": round(g["delay_hour"]),
        "meeting_loss": round(meeting_loss(p)),
        "cancelled_per_person": round(sum(per.values())),
        "cancelled": cancelled,
        "delay_examples": examples,
        "curve": [{"delay": d, "total": journey_cost(p, profile, "delayed", d)["total"]} for d in range(0, 185, 5)],
        "scenarios": {w: {"cancelled": journey_cost(scenario(p, w), profile, "cancelled", None)["total"],
                          "delay60": journey_cost(scenario(p, w), profile, "delayed", 60)["total"]}
                      for w in ("low", "base", "high")},
        "hidden_per_journey": round(hidden_cost(p)) if profile == "out" else 0,
        "cancelled_advance": journey_cost(p, profile, "cancelled", None, advance=True)["total"],
        "late_examples": [{"delay": d, "en_route": journey_cost(p, profile, "delayed", d)["total"],
                           "at_start": journey_cost(p, profile, "delayed", d, late_at_start=True)["total"]}
                          for d in (60, 120, 180)],
    }
