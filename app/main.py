"""Tågkoll – samlar förseningar och inställda tåg från Trafikverkets öppna API.

En bakgrundstråd hämtar TrainAnnouncement för bevakade tågnummer och sparar
dem i SQLite. Webbgränssnittet läser färdig statistik från /api/stats.
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import sqlite3
import statistics
import threading
import time
import unicodedata
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from xml.sax.saxutils import quoteattr
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

API_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"
API_KEY = os.environ.get("TRAFIKVERKET_API_KEY", "").strip()
DB_PATH = os.environ.get("DB_PATH", "/data/trains.db")
POLL_SECONDS = max(60, int(os.environ.get("POLL_INTERVAL_SECONDS", "300")))
DELAY_THRESHOLD = int(os.environ.get("DELAY_THRESHOLD_MIN", "5"))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
INITIAL_TRAINS = [t for t in os.environ.get("INITIAL_TRAINS", "620").replace(" ", "").split(",") if t]
TZ = ZoneInfo("Europe/Stockholm")
_version_file = Path(__file__).parent.parent / "VERSION"
VERSION = _version_file.read_text().strip() if _version_file.exists() else "dev"
IDENT_RE = re.compile(r"^\d{1,6}$")
# Hur länge efter planerad ankomst vi väntar på en ankomsttid innan resan räknas som "uppgift saknas".
PENDING_GRACE = timedelta(hours=4)

log = logging.getLogger("tagkoll")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

SCHEMA = """
CREATE TABLE IF NOT EXISTS trains (
    ident TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
    activity_id TEXT PRIMARY KEY,
    train_ident TEXT NOT NULL,
    departure_date TEXT NOT NULL,
    location TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    advertised INTEGER NOT NULL,
    advertised_time TEXT NOT NULL,
    estimated_time TEXT,
    actual_time TEXT,
    canceled INTEGER NOT NULL,
    deviations TEXT NOT NULL,
    track TEXT,
    from_loc TEXT,
    to_loc TEXT,
    operator TEXT,
    product TEXT,
    modified_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_ann_train_date ON announcements (train_ident, departure_date);
CREATE TABLE IF NOT EXISTS imported_journeys (
    train_ident TEXT NOT NULL,
    departure_date TEXT NOT NULL,
    status TEXT NOT NULL,
    delay_min INTEGER,
    source TEXT,
    PRIMARY KEY (train_ident, departure_date)
);
CREATE TABLE IF NOT EXISTS stations (
    signature TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS track_sections (
    from_sig TEXT NOT NULL,
    to_sig TEXT NOT NULL,
    tracks INTEGER,
    line TEXT,
    source TEXT NOT NULL,
    PRIMARY KEY (from_sig, to_sig)
);
CREATE TABLE IF NOT EXISTS delay_segments (
    train_ident TEXT NOT NULL,
    departure_date TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    from_sig TEXT NOT NULL,
    to_sig TEXT NOT NULL,
    planned_from TEXT,
    planned_to TEXT,
    delay_from INTEGER,
    delay_to INTEGER,
    added INTEGER,
    canceled INTEGER NOT NULL,
    tracks INTEGER,
    line TEXT,
    deviations TEXT NOT NULL,
    PRIMARY KEY (train_ident, departure_date, seq)
);
"""

# Spårstandard för banorna som Karlstad–Stockholm-tågen trafikerar. Enligt användaren:
# dubbelspår Karlstad C–Skattkärr, enkelspår Skattkärr–Laxå,
# Laxå–Stockholm stambana med dubbelspår. Övriga banor är ungefärliga. Varje bana är en
# lista (station, antal spår till nästa station). Används bara för sträckor som inte finns i
# tabellen track_sections; sträckorna sparas där och kan rättas på adminsidan.
DEFAULT_LINES = [
    ("Värmlandsbanan", [("Kil", 1), ("Karlstad C", 2), ("Skattkärr", 1), ("Väse", 1), ("Ölme", 1),
                        ("Kristinehamn", 1), ("Degerfors", 1), ("Laxå", None)]),
    ("Västra stambanan", [("Laxå", 2), ("Hasselfors", 2), ("Hallsberg", 2), ("Pålsboda", 2), ("Högsjö", 2),
                          ("Vingåker", 2), ("Katrineholm C", 2), ("Flen", 2), ("Sparreholm", 2), ("Gnesta", 2),
                          ("Mölnbo", 2), ("Järna", 2), ("Södertälje Syd", 2), ("Flemingsberg", 2),
                          ("Huddinge", 2), ("Stuvsta", 2), ("Älvsjö", 2), ("Stockholm Södra", 2),
                          ("Stockholm C", None)]),
    ("Hallsberg–Örebro", [("Hallsberg", 2), ("Kumla", 2), ("Örebro Södra", 2), ("Örebro C", None)]),
    ("Mälarbanan", [("Örebro C", 1), ("Arboga", 2), ("Köping", 2), ("Kolbäck", 2), ("Västerås C", 2),
                    ("Enköping", 2), ("Bålsta", 2), ("Kungsängen", 2), ("Sundbyberg", 2), ("Stockholm C", None)]),
]


def station_key(name: str | None) -> str:
    """Jämförbart stationsnamn: samma Unicode-form, gemener, utan "C"/"central"/"station" på slutet."""
    key = " ".join(unicodedata.normalize("NFC", name or "").casefold().replace("-", " ").split())
    return re.sub(r"\s+(c|central|centralstation|station|bangård)$", "", key)


_LINE_INDEX: dict[str, list[tuple[str, int]]] = {}
for _line, _stations in DEFAULT_LINES:
    for _i, (_name, _) in enumerate(_stations):
        _LINE_INDEX.setdefault(station_key(_name), []).append((_line, _i))
_LINES = dict(DEFAULT_LINES)


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        if not conn.execute("SELECT 1 FROM meta WHERE key='seeded'").fetchone():
            now = datetime.now(timezone.utc).isoformat()
            for ident in INITIAL_TRAINS:
                if IDENT_RE.match(ident):
                    conn.execute("INSERT OR IGNORE INTO trains VALUES (?, ?)", (ident, now))
            conn.execute("INSERT INTO meta VALUES ('seeded', '1')")


def set_meta(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value)
        )


def get_meta() -> dict[str, str]:
    with db() as conn:
        return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM meta")}


# ---------------------------------------------------------------- Trafikverket

def trv_query(objecttype: str, schemaversion: str, filter_xml: str, includes: list[str], limit: int = 20000):
    if not API_KEY:
        raise RuntimeError("TRAFIKVERKET_API_KEY saknas")
    inc = "".join(f"<INCLUDE>{i}</INCLUDE>" for i in includes)
    body = (
        f"<REQUEST><LOGIN authenticationkey={quoteattr(API_KEY)}/>"
        f'<QUERY objecttype="{objecttype}" schemaversion="{schemaversion}" limit="{limit}">'
        f"<FILTER>{filter_xml}</FILTER>{inc}</QUERY></REQUEST>"
    )
    req = urllib.request.Request(API_URL, data=body.encode(), headers={"Content-Type": "text/xml"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
    return payload["RESPONSE"]["RESULT"][0].get(objecttype, [])


ANN_FIELDS = [
    "ActivityId", "ActivityType", "Advertised", "AdvertisedTimeAtLocation", "AdvertisedTrainIdent",
    "Canceled", "Deviation", "EstimatedTimeAtLocation", "FromLocation", "LocationSignature",
    "ModifiedTime", "ProductInformation", "ScheduledDepartureDateTime", "TimeAtLocation",
    "ToLocation", "TrackAtLocation", "Operator", "InformationOwner",
]


def _first_loc(value) -> str | None:
    if not value:
        return None
    return min(value, key=lambda x: x.get("Order", 0)).get("LocationName")


def fetch_announcements(idents: list[str], days_back: int | None) -> int:
    """Hämtar och sparar tåglägen. days_back=None hämtar allt API:et har kvar."""
    if not idents:
        return 0
    parts = [
        f'<IN name="AdvertisedTrainIdent" value={quoteattr(",".join(idents))}/>',
        '<LTE name="ScheduledDepartureDateTime" value="$now"/>',
    ]
    if days_back is not None:
        parts.append(f'<GT name="ScheduledDepartureDateTime" value="$dateadd(-{days_back}.00:00:00)"/>')
    rows = trv_query("TrainAnnouncement", "1.9", f"<AND>{''.join(parts)}</AND>", ANN_FIELDS)
    records = []
    for a in rows:
        try:
            records.append((
                a["ActivityId"], a["AdvertisedTrainIdent"], a["ScheduledDepartureDateTime"][:10],
                a["LocationSignature"], a["ActivityType"], int(a.get("Advertised", False)),
                a["AdvertisedTimeAtLocation"], a.get("EstimatedTimeAtLocation"), a.get("TimeAtLocation"),
                int(a.get("Canceled", False)),
                json.dumps([d.get("Description") for d in a.get("Deviation", []) if d.get("Description")],
                           ensure_ascii=False),
                a.get("TrackAtLocation"), _first_loc(a.get("FromLocation")), _first_loc(a.get("ToLocation")),
                a.get("Operator") or a.get("InformationOwner"),
                ", ".join(p.get("Description", "") for p in a.get("ProductInformation", [])) or None,
                a.get("ModifiedTime"),
            ))
        except KeyError as exc:  # ofullständig post – hoppa över
            log.warning("Hoppar över post utan %s", exc)
    with db() as conn:
        conn.executemany(
            """INSERT INTO announcements VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(activity_id) DO UPDATE SET
                 advertised=excluded.advertised, advertised_time=excluded.advertised_time,
                 estimated_time=excluded.estimated_time,
                 actual_time=COALESCE(excluded.actual_time, announcements.actual_time),
                 canceled=excluded.canceled, deviations=excluded.deviations, track=excluded.track,
                 from_loc=COALESCE(excluded.from_loc, announcements.from_loc),
                 to_loc=COALESCE(excluded.to_loc, announcements.to_loc),
                 operator=COALESCE(excluded.operator, announcements.operator),
                 product=COALESCE(excluded.product, announcements.product),
                 modified_time=excluded.modified_time""",
            records,
        )
    return len(records)


def fetch_stations() -> None:
    rows = trv_query("TrainStation", "1.4", '<EQ name="Deleted" value="false"/>',
                     ["LocationSignature", "AdvertisedLocationName"])
    with db() as conn:
        conn.executemany(
            "INSERT INTO stations VALUES (?, ?) ON CONFLICT(signature) DO UPDATE SET name=excluded.name",
            [(r["LocationSignature"], r["AdvertisedLocationName"]) for r in rows
             if r.get("LocationSignature") and r.get("AdvertisedLocationName")],
        )
    set_meta("stations_fetched", datetime.now(timezone.utc).isoformat())


poll_lock = threading.Lock()
wake = threading.Event()
stop = threading.Event()


def poll_once(days_back: int | None = 3) -> None:
    with poll_lock:
        try:
            meta = get_meta()
            fetched = meta.get("stations_fetched")
            if not fetched or datetime.fromisoformat(fetched) < datetime.now(timezone.utc) - timedelta(days=7):
                fetch_stations()
            with db() as conn:
                idents = [r["ident"] for r in conn.execute("SELECT ident FROM trains")]
            n = fetch_announcements(idents, days_back)
            since = None if days_back is None else (datetime.now(TZ).date() - timedelta(days=days_back + 1)).isoformat()
            save_segments(idents, since)
            set_meta("last_poll_ok", datetime.now(timezone.utc).isoformat())
            set_meta("last_error", "")
            log.info("Hämtade %d tåglägen för %d tåg", n, len(idents))
        except Exception as exc:  # nätverksfel m.m. – försök igen vid nästa varv
            log.exception("Hämtning misslyckades")
            set_meta("last_error", f"{datetime.now(timezone.utc).isoformat()} {exc}")


def poll_loop() -> None:
    poll_once(days_back=None)  # första varvet: ta allt som API:et har kvar
    while not stop.is_set():
        wake.wait(POLL_SECONDS)
        wake.clear()
        if not stop.is_set():
            poll_once()


# ------------------------------------------------------------------- statistik

def minutes_between(later: str, earlier: str) -> int:
    return round((datetime.fromisoformat(later) - datetime.fromisoformat(earlier)).total_seconds() / 60)


def classify(delay: int) -> str:
    return "delayed" if delay > DELAY_THRESHOLD else "ontime"


def pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


def _line_tracks(line: str, ia: int, ib: int) -> int | None:
    lo, hi = sorted((ia, ib))
    counts = [c for _, c in _LINES[line][lo:hi]]
    return None if not counts or None in counts else min(counts)


def guess_section(points: list[dict], i: int) -> tuple[int | None, str | None]:
    """Gissar antal spår mellan punkt i och i+1 ur DEFAULT_LINES.

    Punkter som inte finns i någon bana (t.ex. driftplatser utan resandeutbyte) får samma bana
    som de närmaste kända stationerna före och efter. Ligger de kända stationerna på två olika
    banor som möts i en knutpunkt (t.ex. Laxå) räknas sträckan till den första banan fram till
    halva tiden mellan stationerna och till den andra därefter.
    """
    def known(k):
        return _LINE_INDEX.get(station_key(points[k]["station"]))

    def t(k):
        iso = points[k]["planned_arr"] or points[k]["planned_dep"]
        return datetime.fromisoformat(iso).timestamp() if iso else None

    a = next((k for k in range(i, -1, -1) if known(k)), None)
    b = next((k for k in range(i + 1, len(points)) if known(k)), None)
    if a is None or b is None:
        return None, None
    best = None
    for line, ia in known(a):
        for line_b, ib in known(b):
            if line == line_b and ia != ib and (best is None or abs(ia - ib) < best[0]):
                best = (abs(ia - ib), _line_tracks(line, ia, ib), line)
    if best:
        return best[1], best[2]
    # Olika banor: leta upp en gemensam knutpunkt.
    for line_a, ia in known(a):
        for line_b, ib in known(b):
            for name, _ in _LINES[line_a]:
                hits_b = [jb for lb, jb in _LINE_INDEX[station_key(name)] if lb == line_b]
                if not hits_b or line_a == line_b:
                    continue
                ja = next(k for k, (n, _) in enumerate(_LINES[line_a]) if n == name)
                ta, tb, ti, tj = t(a), t(b), t(i), t(i + 1)
                first = None in (ta, tb, ti, tj) or (ti + tj) / 2 < (ta + tb) / 2
                if first:
                    return _line_tracks(line_a, ia, ja), line_a
                return _line_tracks(line_b, hits_b[0], ib), line_b
    return None, None


def journey_points(ordered: list[sqlite3.Row], names: dict[str, str]) -> list[dict]:
    """En punkt per plats i tidsordning, med ankomst- och avgångsläge sammanslagna."""
    points: list[dict] = []
    for r in ordered:
        if not points or points[-1]["sig"] != r["location"] or r["activity_type"] in points[-1]["_types"]:
            points.append({"sig": r["location"], "station": names.get(r["location"], r["location"]),
                           "advertised": False, "canceled": False, "_types": set(), "_dev": []})
        p = points[-1]
        p["_types"].add(r["activity_type"])
        key = "arr" if r["activity_type"] == "Ankomst" else "dep"
        p[f"planned_{key}"] = r["advertised_time"]
        p[f"actual_{key}"] = r["actual_time"]
        p[f"estimated_{key}"] = r["estimated_time"]
        p[f"canceled_{key}"] = bool(r["canceled"])
        p["advertised"] = p["advertised"] or bool(r["advertised"])
        if r["track"]:
            p["track"] = r["track"]
        for d in json.loads(r["deviations"]):
            if d not in p["_dev"]:
                p["_dev"].append(d)
    for p in points:
        for key in ("arr", "dep"):
            p.setdefault(f"planned_{key}", None)
            p.setdefault(f"actual_{key}", None)
            p.setdefault(f"estimated_{key}", None)
            p.setdefault(f"canceled_{key}", False)
            p[f"delay_{key}"] = (minutes_between(p[f"actual_{key}"], p[f"planned_{key}"])
                                 if p[f"actual_{key}"] and p[f"planned_{key}"] else None)
        p["canceled"] = all(p["canceled_arr" if t == "Ankomst" else "canceled_dep"] for t in p["_types"])
        p["deviations"] = p.pop("_dev")
        del p["_types"]
    return points


def journey_segments(points: list[dict], tracks: dict[tuple[str, str], dict]) -> list[dict]:
    """Delsträckor mellan på varandra följande punkter och uppehåll med tillkommen försening.

    added = hur många minuter förseningen ökade på sträckan (negativt = tåget tog igen tid).
    """
    out: list[dict] = []

    def d_in(p):
        return p["delay_arr"] if p["delay_arr"] is not None else p["delay_dep"]

    def d_out(p):
        return p["delay_dep"] if p["delay_dep"] is not None else p["delay_arr"]

    for i, p in enumerate(points):
        if p["delay_arr"] is not None and p["delay_dep"] is not None and p["delay_dep"] != p["delay_arr"]:
            out.append({"kind": "stop", "from_sig": p["sig"], "to_sig": p["sig"], "from": p["station"],
                        "to": p["station"], "planned_from": p["planned_arr"], "planned_to": p["planned_dep"],
                        "delay_from": p["delay_arr"], "delay_to": p["delay_dep"],
                        "added": p["delay_dep"] - p["delay_arr"], "canceled": False,
                        "tracks": None, "line": None, "track_source": None, "deviations": p["deviations"]})
        if i + 1 == len(points):
            break
        q = points[i + 1]
        known = tracks.get(pair_key(p["sig"], q["sig"]))
        if known and known["source"] == "admin":
            n_tracks, line, source = known["tracks"], known["line"], known["source"]
        else:
            n_tracks, line = guess_section(points, i)
            source = "inbyggd"
        a, b = d_out(p), d_in(q)
        out.append({
            "kind": "run", "from_sig": p["sig"], "to_sig": q["sig"], "from": p["station"], "to": q["station"],
            "planned_from": p["planned_dep"] or p["planned_arr"], "planned_to": q["planned_arr"] or q["planned_dep"],
            "delay_from": a, "delay_to": b, "added": b - a if a is not None and b is not None else None,
            "canceled": bool(p["canceled_dep"] or q["canceled_arr"] or (p["canceled"] and q["canceled"])),
            "tracks": n_tracks, "line": line, "track_source": source,
            "deviations": [d for d in q["deviations"] if d not in p["deviations"]] or q["deviations"],
        })
    return out


def build_journey(day: str, rows: list[sqlite3.Row], names: dict[str, str], now: datetime,
                  tracks: dict[tuple[str, str], dict] | None = None) -> dict:
    # Samma hållplatsläge kan i sällsynta fall finnas under två ActivityId – behåll det senast ändrade.
    unique: dict[tuple, sqlite3.Row] = {}
    for r in sorted(rows, key=lambda r: r["modified_time"] or ""):
        unique[(r["location"], r["activity_type"], r["advertised_time"])] = r
    ordered = sorted(unique.values(), key=lambda r: (r["advertised_time"], r["activity_type"]))
    stops = [r for r in ordered if r["advertised"]] or ordered
    origin = next((r for r in stops if r["activity_type"] == "Avgang"), stops[0])
    dest = next((r for r in reversed(stops) if r["activity_type"] == "Ankomst"), stops[-1])
    n_canceled = sum(r["canceled"] for r in stops)

    delay = None
    if dest["actual_time"] and not dest["canceled"]:
        delay = minutes_between(dest["actual_time"], dest["advertised_time"])

    if n_canceled == len(stops):
        status = "cancelled"
    elif dest["canceled"]:
        status = "partial"
    elif delay is not None:
        status = "partial" if n_canceled else classify(delay)
    elif now < datetime.fromisoformat(dest["advertised_time"]) + PENDING_GRACE:
        status = "pending"
    else:
        status = "partial" if n_canceled else "unknown"

    current_delay = None
    if status == "pending":
        seen = [r for r in ordered if r["actual_time"]]
        if seen:
            current_delay = minutes_between(seen[-1]["actual_time"], seen[-1]["advertised_time"])

    deviations: list[str] = []
    for r in ordered:
        for d in json.loads(r["deviations"]):
            if d not in deviations:
                deviations.append(d)

    def name(sig):
        return names.get(sig, sig) if sig else None

    points = journey_points(ordered, names)
    segments = journey_segments(points, tracks or {})

    return {
        "date": day,
        "status": status,
        "delay": delay,
        "current_delay": current_delay,
        "estimated_arrival": dest["estimated_time"],
        "origin": name(origin["location"]),
        "destination": name(dest["location"]),
        "planned_departure": origin["advertised_time"],
        "planned_arrival": dest["advertised_time"],
        "actual_arrival": dest["actual_time"],
        "operator": next((r["operator"] for r in stops if r["operator"]), None),
        "product": next((r["product"] for r in stops if r["product"]), None),
        "deviations": deviations,
        "source": "trafikverket",
        "stops": [
            {
                "sig": r["location"],
                "station": name(r["location"]),
                "type": r["activity_type"],
                "planned": r["advertised_time"],
                "actual": r["actual_time"],
                "delay": minutes_between(r["actual_time"], r["advertised_time"]) if r["actual_time"] else None,
                "canceled": bool(r["canceled"]),
                "track": r["track"],
            }
            for r in stops
        ],
        "points": points,
        "segments": segments,
    }


def load_tracks(conn: sqlite3.Connection) -> dict[tuple[str, str], dict]:
    return {pair_key(r["from_sig"], r["to_sig"]): dict(r) for r in conn.execute("SELECT * FROM track_sections")}


def save_segments(idents: list[str], since: str | None) -> None:
    """Sparar var förseningarna uppstod (delay_segments) och nya sträckor (track_sections)."""
    for ident in idents:
        journeys = [j for j in load_journeys(ident, since) if j["source"] == "trafikverket"]
        with db() as conn:
            for j in journeys:
                conn.execute("DELETE FROM delay_segments WHERE train_ident = ? AND departure_date = ?",
                             (ident, j["date"]))
                conn.executemany(
                    "INSERT INTO delay_segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(ident, j["date"], n, s["kind"], s["from_sig"], s["to_sig"], s["planned_from"], s["planned_to"],
                      s["delay_from"], s["delay_to"], s["added"], int(s["canceled"]), s["tracks"], s["line"],
                      json.dumps(s["deviations"], ensure_ascii=False))
                     for n, s in enumerate(j["segments"])],
                )
                conn.executemany(
                    """INSERT INTO track_sections VALUES (?,?,?,?,?) ON CONFLICT(from_sig, to_sig) DO UPDATE SET
                         tracks=excluded.tracks, line=excluded.line WHERE track_sections.source = 'inbyggd'""",
                    [(*pair_key(s["from_sig"], s["to_sig"]), s["tracks"], s["line"], "inbyggd")
                     for s in j["segments"] if s["kind"] == "run" and s["track_source"] == "inbyggd"],
                )


def load_journeys(ident: str, since: str | None) -> list[dict]:
    now = datetime.now(TZ)
    with db() as conn:
        names = {r["signature"]: r["name"] for r in conn.execute("SELECT * FROM stations")}
        args = [ident] + ([since] if since else [])
        cond = " AND departure_date >= ?" if since else ""
        rows = conn.execute(f"SELECT * FROM announcements WHERE train_ident = ?{cond}", args).fetchall()
        imported = conn.execute(f"SELECT * FROM imported_journeys WHERE train_ident = ?{cond}", args).fetchall()
        tracks = load_tracks(conn)
    by_day: dict[str, list] = {}
    for r in rows:
        by_day.setdefault(r["departure_date"], []).append(r)
    journeys = {day: build_journey(day, rs, names, now, tracks) for day, rs in by_day.items()}
    for r in imported:  # importerad historik fyller bara dagar som saknar egna data
        if r["departure_date"] not in journeys:
            journeys[r["departure_date"]] = {
                "date": r["departure_date"], "status": r["status"], "delay": r["delay_min"],
                "current_delay": None, "estimated_arrival": None, "origin": None, "destination": None,
                "planned_departure": None, "planned_arrival": None, "actual_arrival": None,
                "operator": None, "product": None, "deviations": [], "source": r["source"] or "import",
                "stops": [], "points": [], "segments": [],
            }
    return sorted(journeys.values(), key=lambda j: j["date"], reverse=True)


FINISHED = ("ontime", "delayed", "partial", "cancelled")
WEEKDAYS = ["Mån", "Tis", "Ons", "Tors", "Fre", "Lör", "Sön"]


def pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def summarize(journeys: list[dict]) -> dict:
    done = [j for j in journeys if j["status"] in FINISHED]
    counts = {s: sum(j["status"] == s for j in done) for s in FINISHED}
    delays = [j["delay"] for j in done if j["delay"] is not None]
    worst = max((j for j in done if j["delay"] is not None), key=lambda j: j["delay"], default=None)
    return {
        "journeys": len(done),
        **counts,
        "punctuality": pct(counts["ontime"], len(done)),
        "avg_delay": round(statistics.fmean(delays), 1) if delays else None,
        "median_delay": statistics.median(delays) if delays else None,
        "max_delay": worst["delay"] if worst else None,
        "max_delay_date": worst["date"] if worst else None,
    }


def station_stats(journeys: list[dict]) -> list[dict]:
    """Medelförsening per station. Ankomsttid används där den finns, annars avgång (startstationen)."""
    acc: dict[str, dict] = {}
    for j in journeys:
        if not j["stops"]:
            continue
        start = datetime.fromisoformat(j["stops"][0]["planned"])
        per_station: dict[str, dict] = {}
        for s in j["stops"]:
            if s["sig"] not in per_station or s["type"] == "Ankomst":
                per_station[s["sig"]] = s
        for sig, s in per_station.items():
            a = acc.setdefault(sig, {"station": s["station"], "delays": [], "offsets": [], "canceled": 0})
            a["offsets"].append((datetime.fromisoformat(s["planned"]) - start).total_seconds())
            if s["canceled"]:
                a["canceled"] += 1
            elif s["delay"] is not None:
                a["delays"].append(s["delay"])
    out = [
        {
            "station": a["station"],
            "avg_delay": round(statistics.fmean(a["delays"]), 1) if a["delays"] else None,
            "late_share": pct(sum(d > DELAY_THRESHOLD for d in a["delays"]), len(a["delays"])),
            "observations": len(a["delays"]),
            "canceled": a["canceled"],
            "_order": statistics.fmean(a["offsets"]),
        }
        for a in acc.values()
    ]
    out.sort(key=lambda s: s.pop("_order"))
    return out


def weekday_stats(journeys: list[dict]) -> list[dict]:
    out = []
    for wd in range(7):
        js = [j for j in journeys if j["status"] in FINISHED and date.fromisoformat(j["date"]).weekday() == wd]
        if js:
            s = summarize(js)
            out.append({"weekday": WEEKDAYS[wd], "journeys": s["journeys"], "punctuality": s["punctuality"],
                        "avg_delay": s["avg_delay"]})
    return out


def weekly_stats(journeys: list[dict]) -> list[dict]:
    weeks: dict[str, list] = {}
    for j in journeys:
        if j["status"] in FINISHED:
            d = date.fromisoformat(j["date"])
            weeks.setdefault((d - timedelta(days=d.weekday())).isoformat(), []).append(j)
    out = []
    for monday in sorted(weeks):
        s = summarize(weeks[monday])
        iso = date.fromisoformat(monday).isocalendar()
        out.append({"week_start": monday, "label": f"v.{iso.week}", "journeys": s["journeys"],
                    "punctuality": s["punctuality"], "avg_delay": s["avg_delay"]})
    return out


def train_overview(ident: str) -> dict:
    journeys = load_journeys(ident, None)
    described = next((j for j in journeys if j["origin"]), None)
    first = journeys[-1]["date"] if journeys else None
    return {
        "ident": ident,
        "origin": described["origin"] if described else None,
        "destination": described["destination"] if described else None,
        "operator": described["operator"] if described else None,
        "product": described["product"] if described else None,
        "journeys": sum(j["status"] in FINISHED for j in journeys),
        "first_date": first,
        "first_collected_date": min((j["date"] for j in journeys if j["source"] == "trafikverket"), default=None),
        "first_imported_date": min((j["date"] for j in journeys if j["source"] != "trafikverket"), default=None),
        "age_days": (datetime.now(TZ).date() - date.fromisoformat(first)).days if first else None,
    }


# ------------------------------------------------------------------------- API

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    thread = threading.Thread(target=poll_loop, name="collector", daemon=True)
    thread.start()
    yield
    stop.set()
    wake.set()


app = FastAPI(title="Tågkoll", lifespan=lifespan, docs_url=None, redoc_url=None)
STATIC_DIR = Path(__file__).parent / "static"

# ----------------------------------------------------------------------- admin
# Inloggningen ger en kaka "<utgångstid>.<HMAC>" signerad med lösenordet. Byts lösenordet
# blir alla gamla inloggningar ogiltiga.
SESSION_COOKIE = "tagkoll_admin"
SESSION_SECONDS = 7 * 24 * 3600


def _sign(expires: str) -> str:
    return hmac.new(ADMIN_PASSWORD.encode(), f"tagkoll-admin:{expires}".encode(), hashlib.sha256).hexdigest()


def session_valid(token: str | None) -> bool:
    if not ADMIN_PASSWORD or not token or "." not in token:
        return False
    expires, signature = token.split(".", 1)
    if not expires.isdigit() or int(expires) < time.time():
        return False
    return hmac.compare_digest(signature, _sign(expires))


def require_admin(request: Request) -> None:
    if not ADMIN_PASSWORD:
        raise HTTPException(503, "Admin är avstängt. Sätt ADMIN_PASSWORD i .env och starta om containern.")
    if not session_valid(request.cookies.get(SESSION_COOKIE)):
        raise HTTPException(401, "Logga in som admin först.")


admin_only = [Depends(require_admin)]


class TrainIn(BaseModel):
    ident: str


class LoginIn(BaseModel):
    password: str


class ResetIn(BaseModel):
    confirm: str


class ImportIn(BaseModel):
    csv: str
    source: str = "import"


class TrackIn(BaseModel):
    from_sig: str
    to_sig: str
    tracks: int | None = None
    line: str | None = None


def require_train(ident: str) -> None:
    with db() as conn:
        if not conn.execute("SELECT 1 FROM trains WHERE ident = ?", (ident,)).fetchone():
            raise HTTPException(404, f"Tåg {ident} bevakas inte")


@app.get("/api/health")
def health():
    meta = get_meta()
    return {"ok": True, "version": VERSION, "api_key": bool(API_KEY), "last_poll_ok": meta.get("last_poll_ok"),
            "last_error": meta.get("last_error") or None}


@app.get("/api/trains")
def list_trains():
    with db() as conn:
        idents = [r["ident"] for r in conn.execute("SELECT ident FROM trains ORDER BY CAST(ident AS INTEGER)")]
    return [train_overview(i) for i in idents]


@app.post("/api/trains", status_code=201, dependencies=admin_only)
def add_train(body: TrainIn):
    ident = body.ident.strip()
    if not IDENT_RE.match(ident):
        raise HTTPException(422, "Tågnumret ska bestå av 1–6 siffror")
    with db() as conn:
        if conn.execute("SELECT 1 FROM trains WHERE ident = ?", (ident,)).fetchone():
            raise HTTPException(409, f"Tåg {ident} bevakas redan")
        conn.execute("INSERT INTO trains VALUES (?, ?)", (ident, datetime.now(timezone.utc).isoformat()))
    found = None
    try:
        with poll_lock:
            found = fetch_announcements([ident], None)
            save_segments([ident], None)
    except Exception:
        log.exception("Första hämtningen för tåg %s misslyckades", ident)
    return {**train_overview(ident), "found": found}


@app.delete("/api/trains/{ident}", status_code=204, dependencies=admin_only)
def delete_train(ident: str):
    require_train(ident)
    with db() as conn:
        conn.execute("DELETE FROM trains WHERE ident = ?", (ident,))
        conn.execute("DELETE FROM announcements WHERE train_ident = ?", (ident,))
        conn.execute("DELETE FROM imported_journeys WHERE train_ident = ?", (ident,))
        conn.execute("DELETE FROM delay_segments WHERE train_ident = ?", (ident,))


@app.post("/api/refresh", dependencies=admin_only)
def refresh():
    # Högst en hämtning per 30 sekunder, även om knappen trycks flera gånger.
    last = get_meta().get("last_poll_ok")
    if not last or datetime.fromisoformat(last) < datetime.now(timezone.utc) - timedelta(seconds=30):
        poll_once()
    return health()


@app.get("/api/stats")
def stats(train: str, days: int | None = None):
    require_train(train)
    since = (datetime.now(TZ).date() - timedelta(days=days - 1)).isoformat() if days else None
    journeys = load_journeys(train, since)
    meta = get_meta()
    return {
        "train": train_overview(train),
        "threshold": DELAY_THRESHOLD,
        "days": days,
        "summary": summarize(journeys),
        "stations": station_stats(journeys),
        "weekdays": weekday_stats(journeys),
        "weeks": weekly_stats(journeys),
        "journeys": journeys,
        "last_poll_ok": meta.get("last_poll_ok"),
        "last_error": meta.get("last_error") or None,
        "poll_seconds": POLL_SECONDS,
        "version": VERSION,
    }


@app.post("/api/trains/{ident}/import", dependencies=admin_only)
def import_history(ident: str, body: ImportIn):
    """Importerar historik per avgångsdag: datum;försening_min;inställt (inställt = ja/nej, valfri).

    Fält skiljs med semikolon eller komma.
    """
    require_train(ident)
    records, errors = [], []
    text = body.csv.lstrip("\ufeff").strip()
    delimiter = ";" if ";" in text else ","
    for n, row in enumerate(csv.reader(io.StringIO(text), delimiter=delimiter), start=1):
        row = [c.strip() for c in row]
        if not row or not row[0] or row[0].lower() in ("datum", "date"):
            continue
        try:
            day = date.fromisoformat(row[0]).isoformat()
            canceled = len(row) > 2 and row[2].lower() in ("ja", "1", "true", "inställt", "x")
            if canceled:
                records.append((ident, day, "cancelled", None, body.source))
            else:
                delay = int(float(row[1].replace(",", ".")))
                records.append((ident, day, classify(delay), delay, body.source))
        except (ValueError, IndexError):
            errors.append(n)
    with db() as conn:
        conn.executemany(
            """INSERT INTO imported_journeys VALUES (?,?,?,?,?)
               ON CONFLICT(train_ident, departure_date) DO UPDATE SET
                 status=excluded.status, delay_min=excluded.delay_min, source=excluded.source""",
            records,
        )
    return {"imported": len(records), "skipped_lines": errors}


def recompute_all_segments() -> None:
    with db() as conn:
        idents = [r["ident"] for r in conn.execute("SELECT ident FROM trains")]
    save_segments(idents, None)


@app.get("/api/tracks")
def list_tracks():
    """Sträckor som tågen har passerat, med antal spår (1, 2 eller null = okänt)."""
    with db() as conn:
        names = {r["signature"]: r["name"] for r in conn.execute("SELECT * FROM stations")}
        used = {pair_key(r["from_sig"], r["to_sig"]): r["n"] for r in conn.execute(
            "SELECT from_sig, to_sig, COUNT(*) AS n FROM delay_segments WHERE kind = 'run' GROUP BY from_sig, to_sig")}
        rows = [dict(r) for r in conn.execute("SELECT * FROM track_sections")]
    for r in rows:
        r["from"] = names.get(r["from_sig"], r["from_sig"])
        r["to"] = names.get(r["to_sig"], r["to_sig"])
        r["journeys"] = used.get((r["from_sig"], r["to_sig"]), 0)
    rows.sort(key=lambda r: (r["line"] or "~", r["from"], r["to"]))
    return rows


@app.put("/api/tracks", dependencies=admin_only)
def set_track(body: TrackIn):
    if body.tracks not in (None, 1, 2):
        raise HTTPException(422, "Antal spår ska vara 1, 2 eller tomt (okänt).")
    a, b = pair_key(body.from_sig.strip(), body.to_sig.strip())
    if not a or not b:
        raise HTTPException(422, "Ange båda driftplatserna.")
    line = (body.line or "").strip()[:60] or None
    with poll_lock:
        with db() as conn:
            conn.execute(
                """INSERT INTO track_sections VALUES (?,?,?,?,'admin') ON CONFLICT(from_sig, to_sig) DO UPDATE SET
                     tracks=excluded.tracks, line=excluded.line, source='admin'""", (a, b, body.tracks, line))
        recompute_all_segments()
    return {"from_sig": a, "to_sig": b, "tracks": body.tracks, "line": line, "source": "admin"}


@app.delete("/api/tracks/{from_sig}/{to_sig}", status_code=204, dependencies=admin_only)
def reset_track(from_sig: str, to_sig: str):
    """Återställer en sträcka till den inbyggda uppgiften."""
    with poll_lock:
        with db() as conn:
            conn.execute("DELETE FROM track_sections WHERE from_sig = ? AND to_sig = ?", pair_key(from_sig, to_sig))
        recompute_all_segments()


@app.get("/api/admin/session")
def admin_session(request: Request):
    return {"enabled": bool(ADMIN_PASSWORD), "logged_in": session_valid(request.cookies.get(SESSION_COOKIE)),
            "initial_trains": [t for t in INITIAL_TRAINS if IDENT_RE.match(t)]}


@app.post("/api/admin/login")
def admin_login(body: LoginIn, response: Response):
    if not ADMIN_PASSWORD:
        raise HTTPException(503, "Admin är avstängt. Sätt ADMIN_PASSWORD i .env och starta om containern.")
    if not hmac.compare_digest(body.password.encode(), ADMIN_PASSWORD.encode()):
        time.sleep(1)  # bromsar gissningar
        raise HTTPException(401, "Fel lösenord.")
    expires = str(int(time.time()) + SESSION_SECONDS)
    response.set_cookie(SESSION_COOKIE, f"{expires}.{_sign(expires)}", max_age=SESSION_SECONDS,
                        httponly=True, samesite="strict", path="/")
    return {"logged_in": True}


@app.post("/api/admin/logout")
def admin_logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"logged_in": False}


@app.post("/api/admin/reset", dependencies=admin_only)
def admin_reset(body: ResetIn):
    """Raderar alla tåg och all data och börjar om med tågen i INITIAL_TRAINS."""
    if body.confirm.strip() != "RADERA":
        raise HTTPException(422, "Skriv RADERA för att bekräfta.")
    with poll_lock:
        with db() as conn:
            for table in ("announcements", "imported_journeys", "delay_segments", "trains", "meta"):
                conn.execute(f"DELETE FROM {table}")
        init_db()
    log.warning("All data raderad via admin, börjar om med tåg %s", ", ".join(INITIAL_TRAINS))
    threading.Thread(target=poll_once, kwargs={"days_back": None}, daemon=True).start()
    return {"trains": [t for t in INITIAL_TRAINS if IDENT_RE.match(t)]}


def html_page(name: str) -> HTMLResponse:
    """Sidan med versionsnumret i skript- och stilmallsadresserna.

    En cache framför appen (t.ex. Cloudflare) cachar .js och .css men inte HTML. Med versionen i
    adressen hämtas nya filer vid varje release i stället för att gamla blandas med ny HTML.
    """
    text = (STATIC_DIR / name).read_text(encoding="utf-8")
    for asset in ("style.css", "app.js", "admin.js"):
        text = text.replace(f'"{asset}"', f'"{asset}?v={VERSION}"')
    return HTMLResponse(text, headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index_page():
    return html_page("index.html")


@app.get("/admin", include_in_schema=False)
@app.get("/admin.html", include_in_schema=False)
def admin_page():
    return html_page("admin.html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
