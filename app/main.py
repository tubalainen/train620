"""Tågkoll – samlar förseningar och inställda tåg från Trafikverkets öppna API.

En bakgrundstråd hämtar TrainAnnouncement för bevakade tågnummer och sparar
dem i SQLite. Webbgränssnittet läser färdig statistik från /api/stats.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import sqlite3
import statistics
import threading
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from xml.sax.saxutils import quoteattr
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

API_URL = "https://api.trafikinfo.trafikverket.se/v2/data.json"
API_KEY = os.environ.get("TRAFIKVERKET_API_KEY", "").strip()
DB_PATH = os.environ.get("DB_PATH", "/data/trains.db")
POLL_SECONDS = max(60, int(os.environ.get("POLL_INTERVAL_SECONDS", "300")))
DELAY_THRESHOLD = int(os.environ.get("DELAY_THRESHOLD_MIN", "5"))
INITIAL_TRAINS = [t for t in os.environ.get("INITIAL_TRAINS", "620").replace(" ", "").split(",") if t]
TZ = ZoneInfo("Europe/Stockholm")
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
"""


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


def build_journey(day: str, rows: list[sqlite3.Row], names: dict[str, str], now: datetime) -> dict:
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
    }


def load_journeys(ident: str, since: str | None) -> list[dict]:
    now = datetime.now(TZ)
    with db() as conn:
        names = {r["signature"]: r["name"] for r in conn.execute("SELECT * FROM stations")}
        args = [ident] + ([since] if since else [])
        cond = " AND departure_date >= ?" if since else ""
        rows = conn.execute(f"SELECT * FROM announcements WHERE train_ident = ?{cond}", args).fetchall()
        imported = conn.execute(f"SELECT * FROM imported_journeys WHERE train_ident = ?{cond}", args).fetchall()
    by_day: dict[str, list] = {}
    for r in rows:
        by_day.setdefault(r["departure_date"], []).append(r)
    journeys = {day: build_journey(day, rs, names, now) for day, rs in by_day.items()}
    for r in imported:  # importerad historik fyller bara dagar som saknar egna data
        if r["departure_date"] not in journeys:
            journeys[r["departure_date"]] = {
                "date": r["departure_date"], "status": r["status"], "delay": r["delay_min"],
                "current_delay": None, "estimated_arrival": None, "origin": None, "destination": None,
                "planned_departure": None, "planned_arrival": None, "actual_arrival": None,
                "operator": None, "product": None, "deviations": [], "source": r["source"] or "import",
                "stops": [],
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
    return {
        "ident": ident,
        "origin": described["origin"] if described else None,
        "destination": described["destination"] if described else None,
        "operator": described["operator"] if described else None,
        "product": described["product"] if described else None,
        "journeys": sum(j["status"] in FINISHED for j in journeys),
        "first_date": journeys[-1]["date"] if journeys else None,
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


class TrainIn(BaseModel):
    ident: str


class ImportIn(BaseModel):
    csv: str
    source: str = "import"


def require_train(ident: str) -> None:
    with db() as conn:
        if not conn.execute("SELECT 1 FROM trains WHERE ident = ?", (ident,)).fetchone():
            raise HTTPException(404, f"Tåg {ident} bevakas inte")


@app.get("/api/health")
def health():
    meta = get_meta()
    return {"ok": True, "api_key": bool(API_KEY), "last_poll_ok": meta.get("last_poll_ok"),
            "last_error": meta.get("last_error") or None}


@app.get("/api/trains")
def list_trains():
    with db() as conn:
        idents = [r["ident"] for r in conn.execute("SELECT ident FROM trains ORDER BY CAST(ident AS INTEGER)")]
    return [train_overview(i) for i in idents]


@app.post("/api/trains", status_code=201)
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
    except Exception:
        log.exception("Första hämtningen för tåg %s misslyckades", ident)
    return {**train_overview(ident), "found": found}


@app.delete("/api/trains/{ident}", status_code=204)
def delete_train(ident: str):
    require_train(ident)
    with db() as conn:
        conn.execute("DELETE FROM trains WHERE ident = ?", (ident,))
        conn.execute("DELETE FROM announcements WHERE train_ident = ?", (ident,))
        conn.execute("DELETE FROM imported_journeys WHERE train_ident = ?", (ident,))


@app.post("/api/refresh")
def refresh():
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
    }


@app.post("/api/trains/{ident}/import")
def import_history(ident: str, body: ImportIn):
    """Importerar historik per avgångsdag: datum;försening_min;inställt (inställt = ja/nej, valfri)."""
    require_train(ident)
    records, errors = [], []
    for n, row in enumerate(csv.reader(io.StringIO(body.csv.strip()), delimiter=";"), start=1):
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


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
