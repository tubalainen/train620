"""Samhällskostnad för förseningar och inställda tåg.

Modellen beskrivs i docs/kostnadsmodell.md. Kort:

* Ett tåg *till* Stockholm (t.ex. 620 på morgonen) räknas som **utresa**: kostnaden är förlorad
  arbetstid plus den förväntade kostnaden för möten, konferenser, utbildningar och övningar som
  resenärerna kommer sent till eller missar. En försening kostar bara för den som har mindre
  marginal än förseningen.
* Ett tåg *från* Stockholm (t.ex. 643 på kvällen) räknas som **hemresa**: kostnaden är förlorad
  tid och, när tåget ställs in, hotellnätter, alternativa resor och förlorad arbetstid dagen efter.

Alla belopp är schabloner (antaganden). De kan ändras på adminsidan och sparas i tabellen
cost_params. Resultatet är ett förväntat värde: en enskild avgång kan kosta mer eller mindre.
"""
from __future__ import annotations

from dataclasses import dataclass

# --------------------------------------------------------------- schabloner


@dataclass(frozen=True)
class Param:
    key: str
    group: str
    label: str
    unit: str        # "kr", "kr/h", "h", "min", "%", "st"
    default: float
    help: str
    max: float = 1_000_000


GROUPS = {
    "common": "Gemensamt",
    "out": "Utresa till Stockholm (morgon)",
    "out_purpose": "Utresa: vad resenärerna ska göra i Stockholm",
    "out_margin": "Utresa: marginal mellan ankomst och mötets början",
    "out_effect": "Utresa: hur stor del av mötesförlusten som räknas",
    "out_cancel": "Utresa: vad resenärerna gör när tåget ställs in",
    "home": "Hemresa från Stockholm (kväll)",
    "home_cancel": "Hemresa: vad resenärerna gör när tåget ställs in",
}

PURPOSES = [
    ("consult", "Konsult eller dagpendlare utan fast mötestid", 30, 10, 5000,
     "Arbetar ofta ombord eller på distans. Ibland flyttas ett kundmöte."),
    ("internal", "Internt arbetsmöte", 30, 20, 6000,
     "Mötet flyttas eller genomförs sämre: ca 6 personer × 2 h."),
    ("external", "Externt möte eller samverkan mellan myndigheter", 20, 35, 15000,
     "Ca 8 personer × 3 h, andras resor och ny bokning."),
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
    Param("work_hour", "common", "Arbetsgivarens kostnad per arbetstimme", "kr/h", 500,
          "Lön, sociala avgifter och omkostnader. Används för förlorad arbetstid."),
    Param("delay_hour", "common", "Värde per förseningstimme på fritid", "kr/h", 450,
          "Trafikverkets kalkylvärden (ASEK) värderar förseningstid ca 3,5 gånger högre än vanlig restid."),
    Param("min_delay", "common", "Förseningar som inte räknas", "min", 5,
          "Förseningar upp till så här många minuter ryms i normal marginal och kostar inget i modellen.", 60),
    Param("partial_factor", "common", "Delvis inställt räknas som andel av helt inställt", "%", 75,
          "Resenärer efter platsen där tåget stannade drabbas som vid inställt. Ofta finns ersättningsbuss."),
    Param("range_low", "common", "Osäkerhetsintervall, låg", "%", 50,
          "Den låga siffran i spannet, som andel av grundberäkningen.", 100),
    Param("range_high", "common", "Osäkerhetsintervall, hög", "%", 160,
          "Den höga siffran i spannet, som andel av grundberäkningen.", 1000),

    Param("out_passengers", "out", "Resenärer som drabbas", "st", 180,
          "Platser × beläggning × andel som reser från Karlstad med omnejd.", 2000),
    Param("out_onboard_work", "out", "Andel av tiden ombord som blir arbetstid", "%", 30,
          "Den delen av förseningen räknas inte som förlorad arbetstid.", 100),

    *[p for key, label, share, prob, cost, help_ in PURPOSES for p in (
        Param(f"purpose_{key}_share", "out_purpose", f"{label}: andel av resenärerna", "%", share, help_, 100),
        Param(f"purpose_{key}_prob", "out_purpose", f"{label}: sannolikhet att frånvaron får betydelse", "%", prob,
              "Hur ofta en utebliven resenär faktiskt leder till en kostnad.", 100),
        Param(f"purpose_{key}_cost", "out_purpose", f"{label}: kostnad när den får det", "kr", cost, help_),
    )],

    *[Param(f"margin_{key}", "out_margin", f"Marginal {label.lower()}", "%", share,
            "Andel av resenärerna. Den som har mindre marginal än förseningen drabbas.", 100)
      for key, label, _lo, _hi, share in MARGINS],

    Param("effect_lt30", "out_effect", "Sen under 30 min (missar början)", "%", 15,
          "Andel av den fulla mötesförlusten.", 100),
    Param("effect_30_90", "out_effect", "Sen 30–90 min", "%", 40, "Andel av den fulla mötesförlusten.", 100),
    Param("effect_gt90", "out_effect", "Sen mer än 90 min eller nästa tåg", "%", 60,
          "Andel av den fulla mötesförlusten.", 100),

    Param("out_next_share", "out_cancel", "Tar nästa tåg: andel", "%", 45, "", 100),
    Param("out_next_hours", "out_cancel", "Tar nästa tåg: senare ankomst", "h", 2,
          "Tid tills nästa tåg är framme i Stockholm.", 24),
    Param("out_car_share", "out_cancel", "Tar bilen: andel", "%", 15, "", 100),
    Param("out_car_cost", "out_cancel", "Tar bilen: kostnad per person", "kr", 1150,
          "Bil delad på flera, extra tid, utsläpp och olycksrisk."),
    Param("out_car_effect", "out_cancel", "Tar bilen: andel av mötesförlusten", "%", 40, "", 100),
    Param("out_digital_share", "out_cancel", "Deltar digitalt: andel", "%", 25, "", 100),
    Param("out_digital_cost", "out_cancel", "Deltar digitalt: kostnad per person", "kr", 250,
          "Omplanering och sämre deltagande."),
    Param("out_digital_effect", "out_cancel", "Deltar digitalt: andel av mötesförlusten", "%", 20, "", 100),
    Param("out_stay_share", "out_cancel", "Ställer in resan: andel", "%", 15,
          "Hela mötesförlusten räknas.", 100),
    Param("out_stay_hours", "out_cancel", "Ställer in resan: förlorad arbetstid", "h", 2,
          "Förmiddagen som gick åt till att vänta och planera om.", 24),

    Param("home_passengers", "home", "Resenärer som drabbas", "st", 180,
          "Platser × beläggning × andel som ska till Karlstad med omnejd.", 2000),
    Param("home_paired_share", "home", "Andel som åkte upp med morgontåget samma dag", "%", 60,
          "Ställs morgontåget in åker en del aldrig upp. De räknas inte igen på hemresan.", 100),

    Param("home_next_share", "home_cancel", "Väntar på nästa tåg: andel", "%", 50, "", 100),
    Param("home_next_hours", "home_cancel", "Väntar på nästa tåg: senare ankomst", "h", 2.5, "", 24),
    Param("home_hotel_share", "home_cancel", "Hotellnatt: andel", "%", 20, "", 100),
    Param("home_hotel_cost", "home_cancel", "Hotellnatt: hotell, mat och traktamente", "kr", 2100,
          "Hotell ca 1 500–2 000 kr plus middag och frukost."),
    Param("home_hotel_evening", "home_cancel", "Hotellnatt: förlorad kväll hemma", "h", 4,
          "Värderas som förseningstid på fritid.", 24),
    Param("home_hotel_work", "home_cancel", "Hotellnatt: förlorad arbetstid dagen efter", "h", 3, "", 24),
    Param("home_alt_share", "home_cancel", "Hyrbil eller buss: andel", "%", 20, "", 100),
    Param("home_alt_hours", "home_cancel", "Hyrbil eller buss: senare ankomst", "h", 3, "", 24),
    Param("home_alt_cost", "home_cancel", "Hyrbil eller buss: kostnad per person", "kr", 550,
          "Hyrbil delad på flera och bränsle, eller bussbiljett."),
    Param("home_other_share", "home_cancel", "Annat (taxi, skjuts, sitter fast): andel", "%", 10, "", 100),
    Param("home_other_cost", "home_cancel", "Annat: kostnad per person", "kr", 1500, ""),
]
PARAM_BY_KEY = {p.key: p for p in PARAMS}
DEFAULTS = {p.key: p.default for p in PARAMS}

KINDS = {
    "time": "Förlorad tid",
    "meetings": "Missade möten",
    "hotel": "Hotellnätter",
    "travel": "Andra resor",
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
        if not 0 <= v <= p.max or v != v:
            raise ValueError(f"{p.label}: ange ett värde mellan 0 och {p.max:g}.")
        out[key] = v
    return out


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


def meeting_loss(p: dict) -> float:
    """Förväntad mötesförlust i kr när en resenär inte kommer fram alls."""
    keys = [key for key, *_ in PURPOSES]
    shares = _shares(p, [f"purpose_{k}_share" for k in keys])
    return sum(s * p[f"purpose_{k}_prob"] / 100 * p[f"purpose_{k}_cost"] for s, k in zip(shares, keys))


def _affected(p: dict, delay: float) -> float:
    """Andel av resenärerna vars marginal är mindre än förseningen (linjärt inom varje intervall)."""
    shares = _shares(p, [f"margin_{key}" for key, *_ in MARGINS])
    out = 0.0
    for share, (_key, _label, lo, hi, _d) in zip(shares, MARGINS):
        out += share * min(1.0, max(0.0, (delay - lo) / (hi - lo)))
    return out


def _effect(p: dict, delay: float) -> float:
    if delay < 30:
        return p["effect_lt30"] / 100
    if delay <= 90:
        return p["effect_30_90"] / 100
    return p["effect_gt90"] / 100


def _empty() -> dict[str, float]:
    return {k: 0.0 for k in KINDS}


def out_delayed(p: dict, delay: float) -> dict[str, float]:
    """Kostnad per resenär för en försenad utresa."""
    c = _empty()
    if delay <= p["min_delay"]:
        return c
    c["time"] = delay / 60 * p["work_hour"] * (1 - p["out_onboard_work"] / 100)
    c["meetings"] = _affected(p, delay) * _effect(p, delay) * meeting_loss(p)
    return c


def out_cancelled(p: dict) -> dict[str, float]:
    """Kostnad per resenär för en inställd utresa."""
    m = meeting_loss(p)
    s_next, s_car, s_dig, s_stay = _shares(p, ["out_next_share", "out_car_share", "out_digital_share", "out_stay_share"])
    c = _empty()
    c["time"] = (s_next * p["out_next_hours"] * p["work_hour"] * (1 - p["out_onboard_work"] / 100)
                 + s_dig * p["out_digital_cost"] + s_stay * p["out_stay_hours"] * p["work_hour"])
    c["travel"] = s_car * p["out_car_cost"]
    c["meetings"] = m * (s_next * p["effect_gt90"] / 100 + s_car * p["out_car_effect"] / 100
                         + s_dig * p["out_digital_effect"] / 100 + s_stay)
    return c


def home_delayed(p: dict, delay: float) -> dict[str, float]:
    c = _empty()
    if delay > p["min_delay"]:
        c["time"] = delay / 60 * p["delay_hour"]
    return c


def home_cancelled(p: dict) -> dict[str, float]:
    s_next, s_hotel, s_alt, s_other = _shares(p, ["home_next_share", "home_hotel_share", "home_alt_share", "home_other_share"])
    c = _empty()
    c["time"] = (s_next * p["home_next_hours"] * p["delay_hour"]
                 + s_hotel * (p["home_hotel_evening"] * p["delay_hour"] + p["home_hotel_work"] * p["work_hour"])
                 + s_alt * p["home_alt_hours"] * p["delay_hour"])
    c["hotel"] = s_hotel * p["home_hotel_cost"]
    c["travel"] = s_alt * p["home_alt_cost"] + s_other * p["home_other_cost"]
    return c


def journey_cost(p: dict, profile: str, status: str, delay: int | None, stayed_home: float = 0.0) -> dict | None:
    """Kostnad för en avgång, eller None om den inte går att räkna (planerad, uppgift saknas).

    stayed_home är andelen av hemresenärerna som aldrig åkte upp (morgontåget inställt samma dag).
    """
    if status not in ("ontime", "delayed", "partial", "cancelled"):
        return None
    if profile == "out":
        n = p["out_passengers"]
        cancelled, delayed = out_cancelled, out_delayed
    else:
        n = p["home_passengers"] * (1 - stayed_home)
        cancelled, delayed = home_cancelled, home_delayed
    if status == "cancelled":
        per = cancelled(p)
    elif status == "partial":
        per = {k: v * p["partial_factor"] / 100 for k, v in cancelled(p).items()}
    else:
        per = delayed(p, delay or 0)
    kinds = {k: round(v * n) for k, v in per.items()}
    return {"total": sum(kinds.values()), "kinds": kinds, "passengers": round(n)}


def stayed_home_share(p: dict, morning_status: str | None) -> float:
    """Andel av hemresenärerna som inte åkte upp, givet morgontågets status samma dag."""
    if morning_status not in ("cancelled", "partial"):
        return 0.0
    _n, _c, s_dig, s_stay = _shares(p, ["out_next_share", "out_car_share", "out_digital_share", "out_stay_share"])
    share = p["home_paired_share"] / 100 * (s_dig + s_stay)
    return share * (p["partial_factor"] / 100 if morning_status == "partial" else 1)


def curve(p: dict, profile: str) -> list[dict]:
    """Kostnad per avgång mot försening, för diagrammet i informationsrutan."""
    return [{"delay": d, **journey_cost(p, profile, "delayed", d)} for d in range(0, 125, 5)]


def explain(p: dict, profile: str) -> dict:
    """Mellanresultat som visas i informationsrutan, så att uträkningen går att följa."""
    if profile == "out":
        per = out_cancelled(p)
        n = p["out_passengers"]
        examples = [{"delay": d, **journey_cost(p, "out", "delayed", d)} for d in (10, 25, 60, 120)]
    else:
        per = home_cancelled(p)
        n = p["home_passengers"]
        examples = [{"delay": d, **journey_cost(p, "home", "delayed", d)} for d in (10, 30, 60, 120)]
    return {
        "meeting_loss": round(meeting_loss(p)),
        "cancelled_per_person": round(sum(per.values())),
        "cancelled_kinds_per_person": {k: round(v) for k, v in per.items()},
        "cancelled_total": round(sum(per.values()) * n),
        "delay_examples": examples,
        "curve": curve(p, profile),
    }
