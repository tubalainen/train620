"use strict";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const nf = (n, digits = 0) =>
  n.toLocaleString("sv-SE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Färger: grönt = i tid, orange = försenat, rött = inställt (delvis inställt ritas randigt eller med snedstreck).
const STATUS = {
  ontime: { label: "I tid", color: "var(--good)", icon: "✓" },
  delayed: { label: "Försenat", color: "var(--late)", icon: "!", darkInk: true },
  partial: { label: "Delvis inställt", color: "var(--critical)", icon: "–" },
  cancelled: { label: "Inställt", color: "var(--critical)", icon: "✕" },
  pending: { label: "Planerat", color: "var(--neutral)", icon: "…", darkInk: true },
  unknown: { label: "Uppgift saknas", color: "var(--neutral)", icon: "?", darkInk: true },
};
const FINISHED = ["ontime", "delayed", "partial", "cancelled"];
// Flikarna i 3.x hade egna adresser (#cost osv.). De leder nu till motsvarande avsnitt.
const OLD_TABS = { overview: null, punct: "sec-punct", cost: "sec-cost", table: "sec-table" };
const SECTIONS = ["sec-punct", "sec-where", "sec-cost", "sec-upcoming", "sec-table"];
const TZ = "Europe/Stockholm";

/** localStorage kan saknas eller vara spärrat (privat läge). Inget här får vara nödvändigt. */
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* bara en bekvämlighet */ } },
};

const state = {
  trains: [],
  view: "board",     // board = alla tåg, train = ett tåg
  train: store.get("train"),
  days: store.get("days") ?? "30",
  board: {},         // statistik per tåg för startsidan
  boardDate: null,   // dagen som Just nu visar; null = i dag
  boardPlayable: {}, // avgångar med hållplatsdata per tåg (även äldre än perioden)
  boardExtra: {},    // avgångar som hämtats separat för startsidan, "620/2026-11-24" → avgång
  data: null,        // statistik för tåget som visas
  lineDate: null,
  lineExtra: null,   // en äldre avgång som hämtats separat
  replayable: [],    // alla avgångar med hållplatsdata, nyast först
  filter: "all",     // Alla avgångar: alla eller bara störningar
  sort: "date",      // Alla avgångar: date, delay eller cost
};

// ------------------------------------------------------------------ helpers
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}
const show = (node, on) => { node.style.display = on ? "" : "none"; };
const fmtDate = (iso, opts = { day: "numeric", month: "short" }) =>
  new Date(iso + "T12:00:00").toLocaleDateString("sv-SE", opts);
const fmtLongDate = (iso) => fmtDate(iso, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const dayName = (iso) => fmtDate(iso, { weekday: "long", day: "numeric", month: "long" });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "–");
const ms = (iso) => (iso ? Date.parse(iso) : null);
const clock = (t) => new Date(t).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const todayIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
function fmtDelay(min) {
  if (min === null || min === undefined) return "–";
  if (min === 0) return "0 min";
  return `${min > 0 ? "+" : "−"}${nf(Math.abs(min))} min`;
}
/** Trafikverkets orsaker utan upprepningen "Inställt" när statusen redan säger det. */
function reasons(j, n = 2) {
  return j.deviations.filter((d) => !/^inställt( tåg)?$/i.test(d)).slice(0, n);
}
const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* inget JSON-svar */ }
    throw new Error(typeof detail === "string" ? detail : "Något gick fel");
  }
  return res.status === 204 ? null : res.json();
}

function showMessage(text, ok = false) {
  const m = $("message");
  m.textContent = text;
  m.className = "message" + (ok ? " ok" : "");
  m.hidden = !text;
}

// ------------------------------------------------------------------ tooltip
const tip = $("tooltip");
function showTip(evt, { color, value, label, extra }) {
  tip.replaceChildren();
  const val = el("div", { class: "t-val" });
  if (color) val.append(el("span", { class: "t-key", style: `background:${color}` }));
  val.append(document.createTextNode(value));
  tip.append(val, el("div", { class: "t-label", text: label }));
  if (extra) tip.append(el("div", { class: "t-extra", text: extra }));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + 14;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, evt.clientY - r.height - 12) + "px";
}
const hideTip = () => { tip.hidden = true; };

// ------------------------------------------------------------------- charts
function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function frame(container, height, ticks, yFormat, margin) {
  container.replaceChildren();
  const width = Math.max(260, container.clientWidth);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img" }, container);
  const inner = { x: margin.l, y: margin.t, w: width - margin.l - margin.r, h: height - margin.t - margin.b };
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = (v) => inner.y + inner.h - ((v - lo) / (hi - lo)) * inner.h;
  for (const t of ticks) {
    svg("line", { x1: inner.x, x2: inner.x + inner.w, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }, root);
    const label = svg("text", { x: inner.x - 8, y: y(t) + 4, "text-anchor": "end" }, root);
    label.textContent = yFormat(t);
  }
  return { root, inner, y, width };
}

function barPath(x, w, yBase, yVal) {
  const h = Math.abs(yVal - yBase);
  const r = Math.min(4, w / 2, h);
  const d = yVal < yBase ? -1 : 1; // -1 = stapeln växer uppåt
  return `M${x},${yBase} V${yVal - d * r} Q${x},${yVal} ${x + r},${yVal} H${x + w - r} Q${x + w},${yVal} ${x + w},${yVal - d * r} V${yBase} Z`;
}

/** Kryss (inställt) eller snedstreck (delvis inställt) runt (cx, cy). */
function cancelMark(parent, cx, cy, s, kind, cls = "mark") {
  const d = kind === "partial" ? `M${cx + s},${cy - s} L${cx - s},${cy + s}`
    : `M${cx - s},${cy - s} L${cx + s},${cy + s} M${cx + s},${cy - s} L${cx - s},${cy + s}`;
  return svg("path", { class: cls, d, stroke: "var(--critical)", "stroke-width": 2.4, "stroke-linecap": "round", fill: "none" }, parent);
}

/** Stapeldiagram. items: {label, value|null, color, tip, capLabel, mark, onclick, selected}. value null ritas som en markör. */
function columnChart(container, { items, height = 250, yFormat, min = 0, max, threshold, labelCaps = false }) {
  const values = items.map((i) => i.value).filter((v) => v !== null);
  const ticks = niceTicks(Math.min(min, ...values), max ?? Math.max(1, ...values));
  const { root, inner, y } = frame(container, height, ticks, yFormat, { l: 44, r: 14, t: 18, b: 26 });
  const band = inner.w / items.length;
  const barW = Math.max(1, Math.min(24, band - 2));
  const every = Math.ceil(items.length / Math.max(1, Math.floor(inner.w / 62)));

  if (threshold) {
    svg("line", { x1: inner.x, x2: inner.x + inner.w, y1: y(threshold.value), y2: y(threshold.value), stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "4 4" }, root);
  }

  items.forEach((item, i) => {
    const g = svg("g", { class: "band" + (item.onclick ? " clickable" : "") }, root);
    const cx = inner.x + band * i + band / 2;
    svg("rect", { class: "hit", x: cx - band / 2, y: inner.y, width: band, height: inner.h }, g);
    if (item.value === null) {
      cancelMark(g, cx, y(0) - 8, 4, item.mark);
    } else if (item.value === 0) {
      svg("rect", { class: "mark", x: cx - barW / 2, y: y(0) - 2, width: barW, height: 2, fill: item.color }, g);
    } else {
      svg("path", { class: "mark", d: barPath(cx - barW / 2, barW, y(0), y(item.value)), fill: item.color }, g);
    }
    if (item.selected) svg("path", { class: "sel", d: `M${cx - 5},${inner.y + inner.h + 7} l5,-5 l5,5 Z` }, g);
    if (labelCaps && item.value !== null) {
      const t = svg("text", { class: "val", x: cx, y: y(Math.max(0, item.value)) - 6, "text-anchor": "middle" }, g);
      t.textContent = item.capLabel;
    }
    if (i % every === 0) {
      const t = svg("text", { x: cx, y: inner.y + inner.h + 20, "text-anchor": "middle" }, root);
      t.textContent = item.label;
    }
    g.addEventListener("pointermove", (e) => { g.classList.add("hover"); showTip(e, item.tip); });
    g.addEventListener("pointerleave", () => { g.classList.remove("hover"); hideTip(); });
    if (item.onclick) g.addEventListener("click", () => { hideTip(); item.onclick(); });
  });
}

/** Linjediagram för en serie i procent (0–100). */
function lineChart(container, { points, height = 250 }) {
  const { root, inner, y, width } = frame(container, height, [0, 25, 50, 75, 100], (v) => v + " %", { l: 44, r: 52, t: 18, b: 26 });
  const x = (i) => inner.x + (points.length === 1 ? inner.w / 2 : (inner.w * i) / (points.length - 1));
  const coords = points.map((p, i) => [x(i), y(p.value)]);
  const line = coords.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
  svg("path", { d: `${line} L${coords[coords.length - 1][0]},${y(0)} L${coords[0][0]},${y(0)} Z`, fill: "var(--accent)", opacity: 0.1 }, root);
  svg("path", { d: line, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, root);
  const every = Math.ceil(points.length / Math.max(1, Math.floor(inner.w / 52)));
  const dots = points.map((p, i) => {
    if (i % every === 0) {
      const t = svg("text", { x: x(i), y: inner.y + inner.h + 18, "text-anchor": "middle" }, root);
      t.textContent = p.label;
    }
    return svg("circle", { cx: coords[i][0], cy: coords[i][1], r: points.length > 30 ? 0 : 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }, root);
  });
  const last = points[points.length - 1];
  const end = svg("text", { class: "val", x: coords[coords.length - 1][0] + 9, y: coords[coords.length - 1][1] + 4 }, root);
  end.textContent = nf(last.value) + " %";

  const cross = svg("line", { y1: inner.y, y2: inner.y + inner.h, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" }, root);
  root.insertBefore(cross, root.firstChild);
  const hit = svg("rect", { class: "hit", x: inner.x - 10, y: inner.y, width: inner.w + 20, height: inner.h }, root);
  hit.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    let nearest = 0;
    coords.forEach(([cx], i) => { if (Math.abs(cx - px) < Math.abs(coords[nearest][0] - px)) nearest = i; });
    cross.setAttribute("x1", coords[nearest][0]);
    cross.setAttribute("x2", coords[nearest][0]);
    cross.setAttribute("visibility", "visible");
    dots.forEach((d, i) => d.setAttribute("r", i === nearest ? 5.5 : points.length > 30 ? 0 : 4));
    showTip(e, points[nearest].tip);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("r", points.length > 30 ? 0 : 4));
    hideTip();
  });
}

/** Avgång för avgång i en smal remsa: höjd = försening, kryss = inställt, snedstreck = delvis inställt. */
function stripChart(container, journeys, threshold, onPick) {
  container.replaceChildren();
  const done = journeys.filter((j) => FINISHED.includes(j.status)).reverse().slice(-120);
  if (!done.length) { container.append(el("span", { class: "sub", text: "Inga avslutade avgångar" })); return; }
  const width = Math.max(120, container.clientWidth), height = 44, base = 38;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, class: "strip",
    role: "img", "aria-label": stripLabel(done) }, container);
  svg("line", { x1: 0, x2: width, y1: base + 1, y2: base + 1, class: "strip-base" }, root);
  const step = width / done.length;
  const barW = Math.max(1, Math.min(12, step * 0.72));
  const top = Math.max(threshold * 4, 30);
  done.forEach((j, n) => {
    const cx = step * n + step / 2;
    const g = svg("g", { class: "band" + (onPick && j.points?.length > 1 ? " clickable" : "") }, root);
    svg("rect", { class: "hit", x: step * n, y: 0, width: step, height }, g);
    if (j.status === "cancelled" || j.status === "partial") cancelMark(g, cx, base - 6, Math.min(4, step / 2.5), j.status);
    else {
      const h = Math.max(3, (Math.min(top, Math.max(0, j.delay ?? 0)) / top) * (base - 4));
      svg("rect", { class: "mark", x: cx - barW / 2, y: base - h, width: barW, height: h, rx: Math.min(2, barW / 2), fill: STATUS[j.status].color }, g);
    }
    const tipData = { color: STATUS[j.status].color, label: fmtLongDate(j.date),
      value: j.delay === null ? STATUS[j.status].label : j.status === "ontime" ? "I tid" : fmtDelay(j.delay) };
    g.addEventListener("pointermove", (e) => { g.classList.add("hover"); showTip(e, tipData); });
    g.addEventListener("pointerleave", () => { g.classList.remove("hover"); hideTip(); });
    if (onPick && j.points?.length > 1) g.addEventListener("click", () => { hideTip(); onPick(j.date); });
  });
}
function stripLabel(done) {
  const n = (s) => done.filter((j) => j.status === s).length;
  const worst = Math.max(0, ...done.map((j) => j.delay ?? 0));
  return `${done.length} avgångar: ${n("ontime")} i tid, ${n("delayed")} försenade` + (worst ? ` med som mest ${worst} minuter` : "") +
    `, ${n("cancelled")} inställda och ${n("partial")} delvis inställda.`;
}

function placeholder(container, text) {
  container.replaceChildren(el("p", { class: "sub", text }));
}

function statusBadge(key, labelOverride) {
  const s = STATUS[key];
  return el("span", { class: "status" },
    el("i", { class: s.darkInk ? "dark-ink" : "", style: `background:${s.color}`, "aria-hidden": "true", text: s.icon }),
    el("span", { text: labelOverride ?? s.label }));
}
const dot = (key, hollow = false) => el("span", { class: "dot" + (hollow ? " hollow" : ""), style: hollow ? null : `background:${STATUS[key].color}`, "aria-hidden": "true" });

function renderPeriods() {
  for (const b of document.querySelectorAll(".periods [data-days]")) b.setAttribute("aria-pressed", String(b.dataset.days === state.days));
}
const periodText = (d) => d.days ? `De senaste ${d.days} dagarna` : d.train.first_date ? `Sedan ${longDate(d.train.first_date)}` : "Hittills";

// ---------------------------------------------------------------- startsidan
/** Avgången som visas för ett tåg på startsidan: dagens, annars den senaste. */
function currentJourney(d) {
  return d.journeys.find((j) => j.date === todayIso()) ?? d.journeys[0] ?? null;
}

/** Alla dagar som startsidan kan bläddra till: insamlade, importerade (i perioden) och kommande. */
function boardDates() {
  const dates = new Set([todayIso()]);
  for (const t of state.trains) {
    const d = state.board[t.ident];
    if (!d) continue;
    for (const j of d.journeys) dates.add(j.date);
    for (const j of d.upcoming ?? []) dates.add(j.date);
    for (const r of state.boardPlayable[t.ident] ?? []) dates.add(r.date);
  }
  return [...dates].sort();
}

/** Ett tågs avgång en viss dag, eller null om den inte finns (eller ännu inte är hämtad). */
function journeyOn(ident, date) {
  const d = state.board[ident];
  return d.journeys.find((j) => j.date === date) ?? (d.upcoming ?? []).find((j) => j.date === date) ??
    state.boardExtra[`${ident}/${date}`] ?? null;
}

/** Visa en annan dag i Just nu. date = null eller i dag visar läget just nu. */
function setBoardDate(date) {
  state.boardDate = !date || date === todayIso() ? null : date;
  history.replaceState(null, "", state.boardDate ? `#dag/${state.boardDate}` : location.pathname + location.search);
  hideTip();
  renderBoard();
}

function stepBoard(dir) {
  const dates = boardDates();
  const current = state.boardDate ?? todayIso();
  const target = dir < 0 ? dates.filter((d) => d < current).pop() : dates.find((d) => d > current);
  if (target) setBoardDate(target);
}
$("board-prev").addEventListener("click", () => stepBoard(-1));
$("board-next").addEventListener("click", () => stepBoard(1));
$("board-today").addEventListener("click", () => setBoardDate(null));

/** Läget för en avgång i korthet: {key, hollow, tag, big, sub}. */
function brief(j, threshold) {
  const eta = j.estimated_arrival || j.planned_arrival;
  if (j.status === "pending") {
    if (j.current_delay !== null && j.current_delay !== undefined) {
      return { key: j.current_delay > threshold ? "delayed" : "ontime", tag: "På väg",
        big: j.current_delay > 0 ? `${j.current_delay} min sent` : "I tid",
        sub: `Väntas ${hhmm(eta)} · tidtabell ${hhmm(j.planned_arrival)}` };
    }
    if (j.forecast_delay > 0) {
      return { key: "delayed", tag: "Inte avgått", big: `Väntas ${j.forecast_delay} min sent`,
        sub: `Avgår ≈ ${hhmm(j.estimated_departure)} · tidtabell ${hhmm(j.planned_departure)}` };
    }
    return { key: "pending", hollow: true, tag: "Inte avgått", big: "Inga kända störningar",
      sub: `Avgår ${hhmm(j.planned_departure)} · framme ${hhmm(j.planned_arrival)}` };
  }
  if (j.status === "cancelled") return { key: "cancelled", tag: "Inställt", big: "Inställt", sub: reasons(j).join(", ") || "hela avgången" };
  if (j.status === "partial") {
    const last = [...(j.stops ?? [])].reverse().find((s) => !s.canceled && s.actual);
    return { key: "partial", tag: "Delvis inställt", big: last ? `Kom till ${last.station}` : "Delvis inställt", sub: "resten av sträckan inställd" };
  }
  if (j.status === "unknown") return { key: "unknown", tag: "Uppgift saknas", big: "Uppgift saknas", sub: "ingen ankomsttid från Trafikverket" };
  const imported = !j.stops?.length;
  if (j.status === "ontime") return { key: "ontime", tag: "Framme", big: "I tid", sub: imported ? `importerad uppgift` : `Ankom ${hhmm(j.actual_arrival)}` };
  return { key: "delayed", tag: "Framme", big: `${j.delay} min sent`,
    sub: imported ? "importerad uppgift" : `Ankom ${hhmm(j.actual_arrival)} · tidtabell ${hhmm(j.planned_arrival)}` };
}

function upcomingWhat(j) {
  return j.status === "cancelled" ? "inställt" : j.status === "partial" ? "delvis inställt"
    : `väntas bli ${j.forecast_delay} min sent (avgång ${hhmm(j.estimated_departure)})`;
}
function upcomingKind(j) {
  return j.status === "cancelled" ? "cancelled" : j.status === "partial" ? "partial" : j.forecast_delay > 0 ? "delayed" : null;
}

function boardRow(t, d, date) {
  const j = date ? journeyOn(t.ident, date) : currentJourney(d);
  const route = t.origin ? `${t.origin} → ${t.destination}` : "Inga uppgifter ännu";
  const line = el("div", { class: "br-line" });
  const id = el("div", { class: "br-id" },
    el("span", { class: "br-num", text: t.ident }),
    el("span", { class: "br-route", text: route }),
    j?.planned_departure ? el("span", { class: "br-times", text: `${hhmm(j.planned_departure)}–${hhmm(j.planned_arrival)}` }) : null);
  let status;
  if (!j) {
    status = el("div", { class: "br-status" },
      el("span", { class: "br-big quiet", text: date ? "Ingen avgång" : "Inga avgångar ännu" }),
      date ? el("span", { class: "br-sub", text: "Tåget gick inte den dagen, eller uppgift saknas" }) : null);
  } else {
    const b = brief(j, d.threshold);
    if (j.status === "pending" && j.date > todayIso()) b.tag = "Planerat";
    // Utan vald dag visas den senaste avgången om dagens saknas – då står datumet i raden.
    const when = date || j.date === todayIso() ? "" : `${cap(fmtDate(j.date, { weekday: "short", day: "numeric", month: "short" }))} · `;
    const next = date || j.date === todayIso() ? null : d.upcoming?.[0];
    status = el("div", { class: "br-status" },
      el("span", { class: "br-tag" }, dot(b.key, b.hollow), document.createTextNode(when + b.tag)),
      el("span", { class: "br-big", text: b.big }),
      el("span", { class: "br-sub", text: b.sub }),
      next ? el("span", { class: "br-sub", text: `Nästa avgång ${fmtDate(next.date, { weekday: "short", day: "numeric", month: "short" })} ${hhmm(next.planned_departure)}` +
        (upcomingKind(next) ? ` – ${upcomingWhat(next)}` : "") }) : null);
  }
  const withLine = j?.points?.length > 1;
  const href = date && withLine ? `#${t.ident}/${date}` : `#${t.ident}`;
  const row = el("a", { class: "board-row", href }, id, line, status,
    el("span", { class: "br-go", "aria-hidden": "true", text: "›" }));
  return { row, draw: () => drawMini(line, j) };
}

function boardStats(t, d) {
  const s = d.summary, c = d.cost;
  const strip = el("div", { class: "strip-box" });
  const cell = (label, big, sub, cls = "") => el("td", { "data-label": label, class: cls },
    el("span", { class: "bs-big", text: big }), sub ? el("span", { class: "bs-sub", text: sub }) : null);
  const has = s.journeys > 0;
  const row = el("tr", {},
    el("th", { scope: "row", class: "bs-train" }, el("a", { href: `#${t.ident}`, text: t.ident }),
      el("span", { class: "bs-sub", text: t.destination ? `mot ${t.destination}` : "" })),
    cell("I tid", has ? `${nf(s.punctuality, s.punctuality % 1 ? 1 : 0)} %` : "–", has ? `${nf(s.ontime)} av ${nf(s.journeys)}` : "", "bs-punct"),
    el("td", { "data-label": "Avgång för avgång", class: "bs-strip" }, strip),
    cell("Inställda", nf(s.cancelled + s.partial), s.partial ? `varav ${nf(s.partial)} delvis` : ""),
    cell("Medelförsening", s.avg_delay === null ? "–" : `${nf(s.avg_delay, 1)} min`, s.max_delay ? `störst ${fmtDelay(s.max_delay)}` : ""),
    cell("Samhällskostnad", c && c.journeys ? `≈ ${fmtKr(c.total)}` : "–", c ? "" : "bara till/från Stockholm"));
  return { row, draw: () => stripChart(strip, d.journeys, d.threshold, (date) => { location.hash = `${t.ident}/${date}`; }) };
}

function renderBoard() {
  const trains = state.trains.filter((t) => state.board[t.ident]);
  const first = state.board[trains[0]?.ident];
  if (!first) return;
  renderSync(first);
  renderPeriods();
  const date = state.boardDate, today = todayIso();
  $("board-now-title").textContent = !date ? "Just nu" : date < today ? "Så gick det" : "Planerat";
  $("board-date").textContent = cap(dayName(date ?? today));
  const dates = boardDates(), current = date ?? today;
  $("board-prev").disabled = !dates.some((d) => d < current);
  $("board-next").disabled = !dates.some((d) => d > current);
  $("board-today").hidden = !date;
  // Äldre avgångar än perioden hämtas för sig, en gång per tåg och dag.
  if (date) {
    const missing = trains.filter((t) => !journeyOn(t.ident, date) && (state.boardPlayable[t.ident] ?? []).some((r) => r.date === date));
    for (const t of missing) {
      const key = `${t.ident}/${date}`;
      state.boardExtra[key] = null;
      api(`/api/journey?${new URLSearchParams({ train: t.ident, date })}`)
        .then((j) => { state.boardExtra[key] = j; if (state.view === "board" && state.boardDate === date) renderBoard(); })
        .catch(() => { delete state.boardExtra[key]; });
    }
  }
  const rows = trains.map((t) => boardRow(t, state.board[t.ident], date));
  $("board-rows").replaceChildren(...rows.map((r) => r.row));
  rows.forEach((r) => r.draw());
  $("board-period-title").textContent = periodText(first);
  const stats = trains.map((t) => boardStats(t, state.board[t.ident]));
  document.querySelector("#board-table tbody").replaceChildren(...stats.map((r) => r.row));
  stats.forEach((r) => r.draw());
  $("board-key").textContent = `En stapel per avgång, äldst till vänster. Höjden är minuter efter tidtabell vid slutstationen: grön = i tid (högst ${first.threshold} min sent), orange = försenad, kryss = inställd, snedstreck = delvis inställd. Välj en stapel för att se resan.`;

  const notes = [];
  for (const t of trains) {
    for (const j of state.board[t.ident].upcoming ?? []) {
      if (!upcomingKind(j)) continue;
      const why = reasons(j)[0];
      notes.push(el("li", {}, dot(upcomingKind(j)),
        el("span", { text: `${t.ident} ${j.status === "pending" ? "" : "är "}${upcomingWhat(j)} ${dayName(j.date)}${why ? ` (${lower(why)})` : ""}.` })));
    }
  }
  const anyUpcoming = trains.some((t) => state.board[t.ident].upcoming?.length);
  $("board-upcoming").hidden = !anyUpcoming;
  $("board-upcoming-list").replaceChildren(...(notes.length ? notes
    : [el("li", { class: "quiet", text: "Inga kända inställningar eller förseningar de kommande dagarna." })]));
  $("about").textContent = `Tågkoll bevakar ${trains.length === 1 ? "ett tåg" : `${nf(trains.length)} tåg`}: ` +
    trains.map((t) => `${t.ident}${t.origin ? ` ${t.origin} → ${t.destination}` : ""}`).join(", ") + ".";
}

// ------------------------------------------------------------- resan (ett tåg)
/** Avgången som visas: vald avgång, annars den senaste med hållplatsdata, annars den senaste. */
function nowJourney() {
  const d = state.data;
  if (!d) return null;
  return lineJourney(d.journeys) ?? d.journeys[0] ?? null;
}

/** Rubriken för avgången: färgnyckel och kort mening. */
function headline(j) {
  const thr = state.data.threshold;
  if (j.status === "pending") {
    if (j.current_delay !== null && j.current_delay !== undefined) {
      return j.current_delay > 0
        ? { key: j.current_delay > thr ? "delayed" : "ontime", text: `På väg – ${j.current_delay} min sent` }
        : { key: "ontime", text: "På väg – i tid" };
    }
    if (j.forecast_delay > 0) return { key: "delayed", text: `Väntas avgå ${j.forecast_delay} min sent` };
    return { key: "pending", hollow: true, text: "Planerat – inga kända störningar" };
  }
  if (j.status === "ontime") return { key: "ontime", text: "Framme i tid" };
  if (j.status === "delayed") return { key: "delayed", text: `Framme ${j.delay} min sent` };
  if (j.status === "cancelled") return { key: "cancelled", text: "Inställt" };
  if (j.status === "partial") return { key: "partial", text: "Delvis inställt" };
  return { key: "unknown", text: "Uppgift saknas" };
}

/** Var tiden förlorades, i ord: de två största ökningarna. */
function lostText(j) {
  const segs = (j.segments ?? []).filter((s) => s.added >= 2 && !s.canceled).sort((a, b) => b.added - a.added).slice(0, 2);
  if (!segs.length) return "";
  const part = (s) => {
    const where = s.kind === "stop" ? `vid uppehållet i ${s.from}` : `mellan ${s.from} och ${s.to}`;
    const why = [`+${s.added} min`, lower(s.deviations[0]), s.kind === "run" && s.tracks === 1 ? "enkelspår" : null].filter(Boolean);
    return `${where} (${why.join(", ")})`;
  };
  return ` Mest tid förlorades ${segs.map(part).join(" och ")}.`;
}

/** Avgången berättad i en eller två meningar. */
function storyText(j) {
  const origin = j.origin ?? "startstationen", dest = j.destination ?? "slutstationen";
  const why = reasons(j);
  const cause = why.length ? ` Orsak enligt Trafikverket: ${why.map(lower).join(", ")}.` : "";
  if (!j.stops.length) return `Importerad uppgift (${j.source}). Hållplatsdetaljer saknas för den här dagen.`;
  if (j.status === "pending") {
    if (j.current_delay === null || j.current_delay === undefined) {
      return `Avgår från ${origin} ${hhmm(j.planned_departure)} och är framme i ${dest} ${hhmm(j.planned_arrival)} enligt tidtabell.` +
        (j.forecast_delay > 0 ? ` Trafikverket räknar med avgång ${hhmm(j.estimated_departure)}.` : "") + (j.forecast_delay > 0 ? cause : "");
    }
    const eta = j.estimated_arrival || j.planned_arrival;
    return `Väntas till ${dest} ${hhmm(eta)}${eta !== j.planned_arrival ? ` i stället för ${hhmm(j.planned_arrival)}` : ""}.` + lostText(j);
  }
  if (j.status === "cancelled") {
    const advance = journeyCost(j)?.flag === "advance";
    return `Hela avgången ställdes in${advance ? ", känt i förväg" : ""}.` + cause;
  }
  if (j.status === "partial") {
    const last = [...j.stops].reverse().find((s) => !s.canceled && s.actual);
    return `Tåget kom inte längre än ${last ? last.station : origin}, resten av sträckan ställdes in.` + cause + lostText(j);
  }
  if (j.status === "unknown") return "Trafikverket har ingen ankomsttid för den här avgången.";
  if (j.delay > 0 && j.status === "delayed") return `Framme i ${dest} ${hhmm(j.actual_arrival)} i stället för ${hhmm(j.planned_arrival)}.` + lostText(j) + (lostText(j) ? "" : cause);
  return `Framme i ${dest} ${hhmm(j.actual_arrival)}` +
    (j.delay < 0 ? `, ${-j.delay} min före tidtabell.` : j.delay > 0 ? `, ${j.delay} min efter tidtabell – räknas som i tid.` : ", enligt tidtabell.");
}

/** "i tid", "3 min sent" eller "2 min tidigt" för en avgång. */
function departureText(delay) {
  if (delay === null || delay === undefined) return "";
  return delay > 0 ? `${delay} min sent` : delay < 0 ? `${-delay} min tidigt` : "i tid";
}

function costFact(j) {
  const jc = journeyCost(j);
  if (!jc) return ["Samhällskostnad", "–", state.data?.cost ? "utanför vald period" : "räknas bara för tåg till eller från Stockholm"];
  const note = jc.total === 0 ? "ingen kostnad"
    : jc.flag === "advance" ? "inställt, känt i förväg"
    : jc.flag === "capped" ? "sent redan vid avgång, räknas som inställt"
    : j.status === "cancelled" || j.status === "partial" ? "akut inställt" : "försening under resan";
  return ["Samhällskostnad", jc.total === 0 ? "0 kr" : `≈ ${fmtKr(jc.total)}`, note];
}

/** Uppgifterna under linjen: [rubrik, värde, förklaring]. Statusen står redan i rubriken. */
function nowFacts(j) {
  if (!j.stops.length) return [["Försening", fmtDelay(j.delay), `importerad uppgift (${j.source})`], costFact(j)];
  if (j.status === "pending") {
    if (j.current_delay !== null && j.current_delay !== undefined) {
      const lastSeen = [...j.points].reverse().find((p) => p.actual_arr || p.actual_dep);
      return [
        ["Avgick", hhmm(j.actual_departure), departureText(j.departure_delay)],
        ["Senast rapporterad", j.last_station ?? "–", lastSeen ? hhmm(lastSeen.actual_dep || lastSeen.actual_arr) : ""],
        ["Väntas fram", hhmm(j.estimated_arrival || j.planned_arrival), `tidtabell ${hhmm(j.planned_arrival)}`]];
    }
    return [
      ["Avgår", hhmm(j.forecast_delay > 0 ? j.estimated_departure : j.planned_departure), j.forecast_delay > 0 ? `tidtabell ${hhmm(j.planned_departure)}` : j.origin],
      ["Framme", hhmm(j.planned_arrival), j.destination]];
  }
  if (j.status === "cancelled") return [["Planerad avgång", hhmm(j.planned_departure), j.origin], costFact(j)];
  if (j.status === "partial") {
    const last = [...j.stops].reverse().find((s) => !s.canceled && s.actual);
    return [
      ["Avgick", hhmm(j.actual_departure), departureText(j.departure_delay)],
      ["Kom till", last ? last.station : "–", last ? hhmm(last.actual) : ""],
      costFact(j)];
  }
  return [
    ["Avgick", hhmm(j.actual_departure), departureText(j.departure_delay)],
    ["Ankom", hhmm(j.actual_arrival), `tidtabell ${hhmm(j.planned_arrival)}`],
    costFact(j)];
}

function renderNow() {
  const j = nowJourney();
  $("now").hidden = !j;
  if (!j) return;
  const long = dayName(j.date);
  $("now-label").textContent = j.date === todayIso() ? `I dag · ${long}` : cap(long);
  const h = headline(j);
  $("now-status").replaceChildren(dot(h.key, h.hollow), document.createTextNode(h.text));
  $("now-text").textContent = storyText(j);
  $("now-facts").replaceChildren(...nowFacts(j).map(([label, value, note]) => el("div", { class: "fact" },
    el("dt", { text: label }), el("dd", { class: "fact-value", text: value }), note ? el("dd", { class: "fact-note", text: note }) : null)));
  const list = state.replayable;
  const i = list.findIndex((r) => r.date === j.date);
  $("now-prev").disabled = !list.length || i >= list.length - 1;
  $("now-next").disabled = !list.length || i === 0;
  document.querySelector(".now-nav").hidden = !list.length;
}

/** Bläddra mellan avgångar med hållplatsdata. dir = 1 är en äldre avgång. */
function stepDay(dir) {
  const list = state.replayable;
  if (!list.length) return;
  const i = list.findIndex((r) => r.date === nowJourney()?.date);
  const n = i === -1 ? 0 : Math.min(list.length - 1, Math.max(0, i + dir));
  pickLineDate(list[n].date);
}
$("now-prev").addEventListener("click", () => stepDay(1));
$("now-next").addEventListener("click", () => stepDay(-1));

// ---------------------------------------------------------------- historiken
function renderHistory(d) {
  const s = d.summary, c = d.cost;
  const has = s.journeys > 0;
  $("hist-title").textContent = has ? `${nf(s.ontime)} av ${nf(s.journeys)} avgångar kom fram i tid` : "Ingen historik i perioden";
  const parts = [periodText(d)];
  if (has) {
    parts.push(`${nf(s.punctuality, s.punctuality % 1 ? 1 : 0)} % punktlighet`);
    if (s.cancelled + s.partial) parts.push(`${nf(s.cancelled + s.partial)} inställda${s.partial ? `, varav ${nf(s.partial)} delvis` : ""}`);
    if (s.avg_delay !== null) parts.push(`medelförsening ${nf(s.avg_delay, 1)} min`);
    if (c && c.journeys && c.total) parts.push(`≈ ${fmtKr(c.total)} i samhällskostnad`);
  }
  $("hist-sub").textContent = parts.join(" · ");
  $("history-body").hidden = !has;
  $("empty").hidden = has;
  if (!has) {
    $("empty").textContent = d.journeys.length
      ? "Inga avslutade avgångar i den valda perioden ännu. Statistiken fylls på efter varje avgång."
      : "Trafikverket har inga uppgifter om det här tågnumret just nu. Kontrollera numret – bevakningen fortsätter och data dyker upp när tåget går.";
  } else renderDaily(d.journeys, d.threshold);
}

function renderDaily(journeys, threshold) {
  const MAX = 90;
  const finished = journeys.filter((j) => FINISHED.includes(j.status)).reverse();
  const shown = finished.slice(-MAX);
  const playable = new Set(state.replayable.map((r) => r.date));
  const selected = nowJourney()?.date;
  $("daily-sub").textContent = `Minuter efter tidtabell vid slutstationen. Välj en stapel för att se den resan ovanför.` +
    (finished.length > MAX ? ` Visar de ${MAX} senaste avgångarna.` : "");
  const used = FINISHED.filter((k) => shown.some((j) => j.status === k));
  $("daily-legend").replaceChildren(...used.map((k) => el("span", {},
    k === "cancelled" || k === "partial" ? el("span", { class: "mark-key", text: k === "cancelled" ? "✕" : "╱" })
      : el("span", { class: "swatch", style: `background:${STATUS[k].color}` }),
    document.createTextNode(STATUS[k].label))),
    el("span", {}, el("span", { class: "dash-key" }), document.createTextNode(`Gräns för försenat: ${threshold} min`)));
  columnChart($("daily"), {
    height: 220,
    items: shown.map((j) => ({
      label: fmtDate(j.date),
      value: j.delay,
      color: STATUS[j.status].color,
      mark: j.status,
      selected: j.date === selected,
      onclick: playable.has(j.date) ? () => { pickLineDate(j.date); $("now").scrollIntoView({ behavior: "smooth", block: "start" }); } : null,
      tip: { color: STATUS[j.status].color, value: j.delay === null ? STATUS[j.status].label : fmtDelay(j.delay), label: fmtLongDate(j.date),
             extra: (j.delay === null ? "" : STATUS[j.status].label + (j.actual_arrival ? `, ankom ${hhmm(j.actual_arrival)}` : "")) +
               (playable.has(j.date) ? " · välj för att se resan" : "") },
    })),
    yFormat: (v) => nf(v),
    max: Math.max(threshold * 2, ...shown.map((j) => j.delay ?? 0)),
    threshold: { value: threshold },
  });
}

// ------------------------------------------------------------------ avsnitten
const WEEKDAY_PLURAL = { Mån: "måndagar", Tis: "tisdagar", Ons: "onsdagar", Tors: "torsdagar", Fre: "fredagar", Lör: "lördagar", Sön: "söndagar" };

function punctTake(d) {
  const days = d.weekdays.filter((w) => w.journeys >= 2);
  if (!d.summary.journeys) return "Visas när det finns avslutade avgångar.";
  if (days.length < 2) return `${nf(d.summary.punctuality ?? 0)} % i tid i perioden.`;
  const ok = (w) => Math.round((w.punctuality * w.journeys) / 100);
  const best = days.reduce((a, b) => (b.punctuality > a.punctuality ? b : a));
  const worst = days.reduce((a, b) => (b.punctuality < a.punctuality ? b : a));
  if (best.punctuality === worst.punctuality) return "Ingen veckodag sticker ut.";
  return `Bäst på ${WEEKDAY_PLURAL[best.weekday]} (${ok(best)} av ${best.journeys} i tid), sämst på ${WEEKDAY_PLURAL[worst.weekday]} (${ok(worst)} av ${worst.journeys}).`;
}

function whereTake(d) {
  const rows = d.stations.filter((s) => s.avg_delay !== null);
  if (rows.length < 2) return "Bara för avgångar som samlats in från Trafikverket.";
  let top = null;
  for (let i = 1; i < rows.length; i++) {
    const diff = rows[i].avg_delay - rows[i - 1].avg_delay;
    if (!top || diff > top.diff) top = { diff, from: rows[i - 1].station, to: rows[i].station };
  }
  if (top.diff < 1) return "Förseningen ökar inte märkbart på någon sträcka.";
  const diff = Math.round(top.diff * 10) / 10;
  return `Mest tillkommer mellan ${top.from} och ${top.to}, i snitt +${nf(diff, diff % 1 ? 1 : 0)} min.`;
}

function costTake(d) {
  const c = d.cost;
  if (!c) return "Räknas bara för tåg till eller från Stockholm.";
  if (!c.journeys) return "Inga avslutade avgångar i perioden.";
  if (!c.total) return "Ingen kostnad i perioden.";
  const top = KIND_ORDER.reduce((a, b) => (c.kinds[b] > c.kinds[a] ? b : a));
  return `≈ ${fmtKr(c.total)} i perioden, mest genom ${c.kind_labels[top].toLowerCase()}.`;
}

function upcomingTake(upcoming) {
  if (!upcoming.length) return { text: "Inga kommande avgångar kända ännu." };
  const notable = upcoming.filter(upcomingKind);
  if (!notable.length) return { text: `Inga kända störningar t.o.m. ${fmtDate(upcoming[upcoming.length - 1].date, { weekday: "short", day: "numeric", month: "long" })}.` };
  const j = notable[0];
  return { key: upcomingKind(j), text: `${cap(upcomingWhat(j))} ${dayName(j.date)}` +
    (notable.length > 1 ? ` och ${notable.length - 1} ${notable.length === 2 ? "dag" : "dagar"} till.` : ".") };
}

function renderSections(d) {
  $("take-punct").textContent = punctTake(d);
  $("take-where").textContent = whereTake(d);
  $("take-cost").textContent = costTake(d);
  const up = upcomingTake(d.upcoming ?? []);
  $("take-upcoming").replaceChildren(up.key ? dot(up.key) : "", document.createTextNode(up.text));
  const s = d.summary;
  $("take-table").textContent = `${nf(s.journeys)} avslutade avgångar i perioden, ${nf(s.delayed + s.partial + s.cancelled)} med störning.`;
  renderCost();
  renderUpcoming(d.upcoming ?? []);
  renderTable(tableRows(d.journeys));
  renderSectionCharts();
}

/** Diagram ritas bara i utfällda avsnitt – i ett stängt avsnitt har de ingen bredd. */
function renderSectionCharts() {
  const d = state.data;
  if (!d || state.view !== "train") return;
  const has = d.summary.journeys > 0;
  if ($("sec-punct").open) {
    if (has) {
      renderSplit(d.summary);
      renderWeekly(d.weeks);
      renderWeekday(d.weekdays);
    } else for (const id of ["split", "weekly", "weekday"]) placeholder($(id), "Inga avslutade avgångar i perioden.");
  }
  if ($("sec-where").open) renderStations(d.stations);
  if ($("sec-cost").open && d.cost && d.cost.journeys) renderCostChart();
}

for (const id of SECTIONS) {
  const sec = $(id);
  if ((store.get("open") ?? "").split(",").includes(id)) sec.open = true;
  sec.addEventListener("toggle", () => {
    renderSectionCharts();
    store.set("open", SECTIONS.filter((s) => $(s).open).join(","));
  });
}

/** Kommande dagar: en rad med dagar, text bara för dagar med kända störningar. */
function renderUpcoming(upcoming) {
  const days = upcoming.slice(0, 7);
  $("upcoming-days").replaceChildren(...days.map((j) => {
    const k = upcomingKind(j);
    const label = `${dayName(j.date)}: ${k ? upcomingWhat(j) : "inga kända störningar"}`;
    return el("li", { class: "uday" + (k ? " issue" : ""), title: label },
      el("span", { class: "uday-name", text: fmtDate(j.date, { weekday: "short" }) }),
      el("span", { class: "uday-num", text: fmtDate(j.date, { day: "numeric" }) }),
      el("span", { class: "dot" + (k ? "" : " hollow"), style: k ? `background:${STATUS[k].color}` : null, role: "img", "aria-label": label }));
  }));
  const notable = upcoming.filter(upcomingKind);
  $("upcoming-notes").replaceChildren(...(notable.length
    ? notable.map((j) => el("li", {},
        el("strong", { text: `${cap(dayName(j.date))}: ` }),
        document.createTextNode(upcomingWhat(j) + (j.deviations.length ? ` – ${j.deviations.slice(0, 2).join(", ")}` : "") + ".")))
    : [el("li", { class: "quiet", text: upcomingTake(upcoming).text })]));
}

function renderSplit(s) {
  const box = $("split");
  const parts = FINISHED.map((k) => ({ key: k, n: s[k] })).filter((p) => p.n > 0);
  $("split-sub").textContent = `${nf(s.journeys)} avslutade avgångar i perioden`;
  const bar = el("div", { class: "split-bar", role: "img", "aria-label": parts.map((p) => `${STATUS[p.key].label}: ${p.n}`).join(", ") });
  const legend = el("div", { class: "legend split-legend" });
  for (const p of parts) {
    const share = (100 * p.n) / s.journeys;
    const hatched = p.key === "partial";
    const seg = el("div", { class: (STATUS[p.key].darkInk ? "dark-ink" : "") + (hatched ? " hatched" : ""),
      style: `flex:${p.n} 1 0;` + (hatched ? "" : `background:${STATUS[p.key].color}`), text: `${nf(share)} %` });
    const tipData = { color: STATUS[p.key].color, value: `${nf(p.n)} avgångar`, label: STATUS[p.key].label, extra: `${nf(share, 1)} % av perioden` };
    seg.addEventListener("pointermove", (e) => showTip(e, tipData));
    seg.addEventListener("pointerleave", hideTip);
    bar.append(seg);
    legend.append(el("span", {}, el("span", { class: "swatch" + (hatched ? " hatched" : ""), style: hatched ? null : `background:${STATUS[p.key].color}` }),
      document.createTextNode(STATUS[p.key].label + " "), el("b", { text: nf(p.n) })));
  }
  box.replaceChildren(bar, legend);
  for (const seg of bar.children) if (seg.scrollWidth > seg.clientWidth) seg.textContent = "";
}

function renderWeekly(weeks) {
  if (weeks.length < 2) return placeholder($("weekly"), "Visas när det finns data från minst två veckor.");
  lineChart($("weekly"), {
    points: weeks.map((w) => ({
      label: w.label, value: w.punctuality,
      tip: { color: "var(--accent)", value: `${nf(w.punctuality, 1)} % i tid`, label: `${w.label}, från ${fmtDate(w.week_start)}`,
             extra: `${nf(w.journeys)} avgångar` + (w.avg_delay !== null ? `, medel ${fmtDelay(w.avg_delay)}` : "") },
    })),
  });
}

function renderWeekday(days) {
  columnChart($("weekday"), {
    items: days.map((d) => ({
      label: d.weekday, value: d.punctuality, color: "var(--accent)", capLabel: `${nf(d.punctuality)} %`,
      tip: { color: "var(--accent)", value: `${nf(d.punctuality, 1)} % i tid`, label: d.weekday,
             extra: `${nf(d.journeys)} avgångar` + (d.avg_delay !== null ? `, medel ${fmtDelay(d.avg_delay)}` : "") },
    })),
    yFormat: (v) => v + " %",
    max: 100,
    labelCaps: true,
  });
}

function renderStations(stations) {
  const rows = stations.filter((s) => s.avg_delay !== null);
  if (!rows.length) return placeholder($("stations"), "Stationsdata finns bara för avgångar som samlats in från Trafikverket.");
  const max = Math.max(1, ...rows.map((s) => s.avg_delay));
  const grid = el("div", { class: "stations" });
  for (const s of rows) {
    const track = el("div", { class: "track" }, el("div", { class: "bar", style: `width:${(100 * Math.max(0, s.avg_delay)) / max}%` }));
    const tipData = { color: "var(--accent)", value: `${fmtDelay(s.avg_delay)} i medel`, label: s.station,
                      extra: `${nf(s.observations)} avgångar, ${nf(s.late_share ?? 0)} % försenade` + (s.canceled ? `, ${s.canceled} inställda` : "") };
    track.addEventListener("pointermove", (e) => showTip(e, tipData));
    track.addEventListener("pointerleave", hideTip);
    grid.append(el("div", { class: "name", text: s.station }), track,
      el("div", { class: "val", text: fmtDelay(s.avg_delay).replace("+", "") }));
  }
  $("stations").replaceChildren(grid);
}

function stopsRow(j) {
  if (!j.stops.length) {
    return el("tr", { class: "stops" }, el("td", { colspan: 6, text: `Importerad uppgift (${j.source}) – stationsdetaljer saknas.` }));
  }
  const body = el("tbody");
  for (const s of j.stops) {
    body.append(el("tr", {},
      el("td", { text: s.station, class: s.canceled ? "struck" : "" }),
      el("td", { text: s.type === "Ankomst" ? "Ankomst" : "Avgång" }),
      el("td", { class: "num", text: hhmm(s.planned) }),
      el("td", { class: "num", text: s.canceled ? "Inställt" : hhmm(s.actual) }),
      el("td", { class: "num", text: s.canceled ? "–" : fmtDelay(s.delay) }),
      el("td", { text: s.track ? `Spår ${s.track}` : "" })));
  }
  const table = el("table", {},
    el("thead", {}, el("tr", {}, ...["Station", "", "Planerad", "Verklig", "Avvikelse", ""].map((h, i) => el("th", { class: i >= 2 && i <= 4 ? "num" : "", text: h })))),
    body);
  const showBtn = j.points.length > 1
    ? el("button", { type: "button", class: "show-line", text: "Visa resan överst ↑", onclick: (e) => { e.stopPropagation(); showOnLine(j.date); } })
    : null;
  return el("tr", { class: "stops" }, el("td", { colspan: 6 }, showBtn, table));
}

const PAGE = 30;
/** Avgångarna i tabellen efter valt urval och sortering. */
function tableRows(journeys) {
  let rows = journeys;
  if (state.filter === "issues") rows = rows.filter((j) => ["delayed", "partial", "cancelled"].includes(j.status));
  const costOf = (j) => state.data?.cost?.by_date?.[j.date] ?? -1;
  const delayOf = (j) => (j.status === "cancelled" || j.status === "partial" ? 1e6 : j.delay ?? -1e6);
  if (state.sort === "cost") rows = [...rows].sort((a, b) => costOf(b) - costOf(a));
  else if (state.sort === "delay") rows = [...rows].sort((a, b) => delayOf(b) - delayOf(a));
  return rows;
}

function renderTableTools() {
  for (const b of document.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
  for (const b of document.querySelectorAll("[data-sort]")) b.setAttribute("aria-pressed", String(b.dataset.sort === state.sort));
}

function renderTable(journeys, limit = PAGE) {
  renderTableTools();
  const body = document.querySelector("#journeys tbody");
  body.replaceChildren();
  const more = $("more");
  more.hidden = journeys.length <= limit;
  more.textContent = `Visa fler (${journeys.length - limit} till)`;
  more.onclick = () => renderTable(journeys, limit + 60);
  const shown = journeys.slice(0, limit);
  if (!shown.length) {
    body.append(el("tr", {}, el("td", { colspan: 6, text: state.filter === "issues" ? "Inga störningar i perioden." : "Inga avgångar i perioden ännu." })));
  }
  for (const j of shown) {
    const row = el("tr", { class: "journey", tabindex: 0, "aria-expanded": "false" },
      el("td", { text: fmtLongDate(j.date) }),
      el("td", {}, statusBadge(j.status, j.status === "pending" && j.current_delay !== null ? "På väg"
        : state.data?.cost?.flags?.[j.date] === "advance" ? `${STATUS[j.status].label} i förväg` : undefined)),
      el("td", { class: "num", text: j.status === "cancelled" ? "–" : hhmm(j.actual_arrival) }),
      el("td", { class: "num", text: fmtDelay(j.delay) }),
      el("td", { class: "num cost-col", text: costCell(j.date) }),
      el("td", { class: "dev", text: j.deviations.join(", ") }));
    const toggle = () => {
      const open = row.nextElementSibling?.classList.contains("stops");
      if (open) row.nextElementSibling.remove(); else row.after(stopsRow(j));
      row.setAttribute("aria-expanded", String(!open));
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    body.append(row);
  }
}

for (const b of document.querySelectorAll("[data-filter]")) {
  b.addEventListener("click", () => { state.filter = b.dataset.filter; if (state.data) renderTable(tableRows(state.data.journeys)); });
}
for (const b of document.querySelectorAll("[data-sort]")) {
  b.addEventListener("click", () => { state.sort = b.dataset.sort; if (state.data) renderTable(tableRows(state.data.journeys)); });
}

// ---------------------------------------------------------- samhällskostnad
// Fasta färger per kostnadsslag (samma slag har alltid samma färg, oavsett vilka som syns).
const KIND_COLORS = { time: "var(--series-1)", meetings: "var(--series-2)", nextday: "var(--series-3)",
                      hotel: "var(--series-4)", travel: "var(--series-5)", ops: "var(--series-6)" };
const KIND_ORDER = ["time", "meetings", "nextday", "hotel", "travel", "ops"];
// Slag som inte kan förekomma i en riktning visas inte i uppdelningen.
const KIND_PROFILE = { meetings: "out", nextday: "home", hotel: "home" };

/** Kronor i läsbar form: "1,2 milj. kr", "350 000 kr". */
function fmtKr(n, { short = false } = {}) {
  if (n === null || n === undefined) return "–";
  if (Math.abs(n) >= 1e6) return `${nf(n / 1e6, n >= 1e7 ? 0 : 1)} milj.${short ? "" : " kr"}`;
  if (Math.abs(n) >= 1e4) return `${nf(Math.round(n / 1000) * 1000)}${short ? "" : " kr"}`;
  return `${nf(Math.round(n / 100) * 100)}${short ? "" : " kr"}`;
}

/** Kostnaden för en avgång: {total, flag} eller null om den inte är räknad (planerad, okänd, utanför perioden). */
function journeyCost(j) {
  const c = state.data?.cost;
  if (c?.by_date?.[j.date] !== undefined) return { total: c.by_date[j.date], flag: c.flags?.[j.date] ?? null };
  if (j.cost) return { total: j.cost.total, flag: j.cost.advance ? "advance" : j.cost.capped ? "capped" : null };
  return null;
}

function costCell(date) {
  const c = state.data?.cost?.by_date?.[date];
  return c === undefined ? "–" : c === 0 ? "0 kr" : fmtKr(c);
}

/** Staplade staplar. items: {label, parts: [{key, value, color}], total, tip}. */
function stackedChart(container, { items, height = 240 }) {
  const max = Math.max(1, ...items.map((i) => i.total));
  const ticks = niceTicks(0, max);
  const { root, inner, y } = frame(container, height, ticks, (v) => fmtKr(v, { short: true }), { l: 58, r: 12, t: 14, b: 26 });
  const band = inner.w / items.length;
  const barW = Math.max(2, Math.min(28, band - 4));
  const every = Math.ceil(items.length / Math.max(1, Math.floor(inner.w / 62)));
  items.forEach((item, i) => {
    const g = svg("g", { class: "band" }, root);
    const cx = inner.x + band * i + band / 2;
    svg("rect", { class: "hit", x: cx - band / 2, y: inner.y, width: band, height: inner.h }, g);
    const parts = item.parts.filter((p) => p.value > 0);
    let base = 0;
    parts.forEach((part, n) => {
      const y0 = y(base), y1 = y(base + part.value);
      base += part.value;
      const top = n === parts.length - 1;
      const gap = n > 0 ? 2 : 0; // 2 px yta mellan segmenten
      const h = y0 - y1 - gap;
      if (h <= 0.5) return;
      if (top) svg("path", { class: "mark", d: barPath(cx - barW / 2, barW, y0 - gap, y1), fill: part.color }, g);
      else svg("rect", { class: "mark", x: cx - barW / 2, y: y1, width: barW, height: h, fill: part.color }, g);
    });
    if (i % every === 0) {
      const t = svg("text", { x: cx, y: inner.y + inner.h + 18, "text-anchor": "middle" }, root);
      t.textContent = item.label;
    }
    g.addEventListener("pointermove", (e) => { g.classList.add("hover"); showTip(e, item.tip); });
    g.addEventListener("pointerleave", () => { g.classList.remove("hover"); hideTip(); });
  });
}

function renderCostChart() {
  const c = state.data?.cost;
  if (!c || !c.periods.length) return placeholder($("cost-chart"), "Ingen kostnad att visa i perioden.");
  const labels = c.kind_labels;
  stackedChart($("cost-chart"), {
    items: c.periods.map((p) => ({
      label: c.period === "week" ? p.label : fmtDate(p.start + "-01", { month: "short", year: "2-digit" }),
      total: p.total,
      parts: KIND_ORDER.map((k) => ({ key: k, value: p.kinds[k], color: KIND_COLORS[k] })),
      tip: {
        color: "var(--series-1)", value: fmtKr(p.total),
        label: c.period === "week" ? `${p.label}, från ${fmtDate(p.start)}` : fmtDate(p.start + "-01", { month: "long", year: "numeric" }),
        extra: `${nf(p.journeys)} avgångar. ` + KIND_ORDER.filter((k) => p.kinds[k] > 0).map((k) => `${labels[k]}: ${fmtKr(p.kinds[k])}`).join(", "),
      },
    })),
  });
}

function renderCost() {
  const c = state.data.cost;
  const has = c && c.journeys;
  $("cost-body").hidden = !has;
  $("cost-none").hidden = !!has;
  if (!has) {
    $("cost-sub").textContent = "";
    $("cost-none").textContent = c ? "Inga avslutade avgångar i den valda perioden ännu."
      : "Samhällskostnaden räknas bara för tåg till eller från Stockholm.";
    return;
  }
  const dir = c.profile === "out" ? "utresa till Stockholm" : "hemresa från Stockholm";
  $("cost-sub").textContent = `Ungefärlig kostnad för samhället, räknad som ${dir} med ${nf(c.passengers)} resenärer per avgång. ` +
    "Förväntade värden enligt schabloner – en enskild avgång kan kosta mer eller mindre.";
  $("cost-total").textContent = fmtKr(c.total);
  $("cost-range").textContent = `spann ${fmtKr(c.low)} – ${fmtKr(c.high)}`;
  $("cost-avg").textContent = fmtKr(c.per_journey);
  $("cost-avg-note").textContent = `${nf(c.journeys)} avslutade avgångar`;
  $("cost-hidden-tile").hidden = c.hidden === null;
  if (c.hidden !== null) {
    $("cost-hidden").textContent = fmtKr(c.hidden);
    $("cost-hidden-note").textContent = `${nf(c.hidden_per_day)} resenärer per avgång åker kvällen före för säkerhets skull. Ingår inte i summan.`;
  }
  const s = state.data.summary;
  const cancelCost = c.by_status.cancelled + c.by_status.partial;
  const delayCost = c.by_status.delayed + c.by_status.ontime;
  const pctOf = (v) => (c.total ? `${nf((100 * v) / c.total)} %` : "–");
  $("cost-split").textContent = `Inställda avgångar (${nf(s.cancelled + s.partial)} st) kostade ${fmtKr(cancelCost)}, ${pctOf(cancelCost)} av summan. ` +
    `Försenade avgångar (${nf(s.delayed)} st) kostade ${fmtKr(delayCost)}, ${pctOf(delayCost)}.`;

  const labels = c.kind_labels;
  const used = KIND_ORDER.filter((k) => c.kinds[k] > 0);
  $("cost-period-title").textContent = c.period === "week" ? "Kostnad per vecka" : "Kostnad per månad";
  $("cost-legend").replaceChildren(...used.map((k) => el("span", {},
    el("span", { class: "swatch", style: `background:${KIND_COLORS[k]}` }), document.createTextNode(labels[k]))));
  if ($("sec-cost").open) renderCostChart();

  const kinds = el("div", { class: "stations cost-kinds" });
  const maxKind = Math.max(1, ...KIND_ORDER.map((k) => c.kinds[k]));
  for (const k of KIND_ORDER) {
    if (!c.kinds[k] && KIND_PROFILE[k] && KIND_PROFILE[k] !== c.profile) continue;
    kinds.append(el("div", { class: "name" }, el("span", { class: "swatch", style: `background:${KIND_COLORS[k]}` }), document.createTextNode(" " + labels[k])),
      el("div", { class: "track" }, el("div", { class: "bar", style: `width:${(100 * c.kinds[k]) / maxKind}%;background:${KIND_COLORS[k]}` })),
      el("div", { class: "val", text: fmtKr(c.kinds[k]) }));
  }
  $("cost-kinds").replaceChildren(kinds);

  const notes = [];
  if (c.advance_days) notes.push(`${nf(c.advance_days)} inställda avgångar var kända i förväg och räknas lägre än akuta inställningar.`);
  if (c.capped_days) notes.push(`${nf(c.capped_days)} avgångar var redan mycket sena vid avgång och räknas högst som ett inställt tåg.`);
  if (c.paired_days) notes.push(`${nf(c.paired_days)} dagar var morgontåget till Stockholm inställt. Resenärer som då aldrig åkte upp räknas inte igen på hemresan.`);
  $("cost-note").textContent = notes.join(" ");
}

// -------------------------------------------------------- informationsrutan
let costModel = null;
const pct0 = (v) => `${nf(v, v % 1 ? 1 : 0)} %`;
const unitText = (v, unit) => unit === "%" ? pct0(v) : unit === "kr" ? `${nf(v)} kr` : unit === "kr/h" ? `${nf(v)} kr/h`
  : unit === "h" ? `${nf(v, v % 1 ? 1 : 0)} h` : unit === "min" ? `${nf(v)} min` : nf(v);

function infoTable(head, rows, numeric = []) {
  return el("div", { class: "table-wrap" }, el("table", { class: "info-table" },
    el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { class: numeric.includes(i) ? "num" : "", text: h })))),
    el("tbody", {}, ...rows.map((r) => el("tr", { class: r.strong ? "strong" : "" },
      ...r.cells.map((c, i) => el("td", { class: numeric.includes(i) ? "num" : "", text: c })))))));
}

/** Kostnad mot försening för båda riktningarna, i samma skala. */
function curveChart(container, explain) {
  container.replaceChildren();
  const series = [
    { key: "out", label: "Utresa (morgon)", color: "var(--series-1)", pts: explain.out.curve },
    { key: "home", label: "Hemresa (kväll)", color: "var(--series-2)", pts: explain.home.curve },
  ];
  const max = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => p.total)));
  const ticks = niceTicks(0, max);
  const { root, inner, y, width } = frame(container, 220, ticks, (v) => fmtKr(v, { short: true }), { l: 58, r: 16, t: 14, b: 30 });
  const pts = series[0].pts;
  const maxD = pts[pts.length - 1].delay;
  const x = (d) => inner.x + (inner.w * d) / maxD;
  for (let d = 0; d <= maxD; d += 30) {
    const t = svg("text", { x: x(d), y: inner.y + inner.h + 18, "text-anchor": "middle" }, root);
    t.textContent = `${d} min`;
  }
  for (const s of series) {
    svg("path", { d: s.pts.map((p, i) => `${i ? "L" : "M"}${x(p.delay)},${y(p.total)}`).join(" "),
      fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round" }, root);
  }
  const cross = svg("line", { y1: inner.y, y2: inner.y + inner.h, stroke: "var(--axis)", visibility: "hidden" }, root);
  const dots = series.map((s) => svg("circle", { r: 5, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, root));
  const hit = svg("rect", { class: "hit", x: inner.x, y: inner.y, width: inner.w, height: inner.h }, root);
  hit.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - inner.x) / inner.w) * (pts.length - 1))));
    const d = pts[i].delay;
    cross.setAttribute("x1", x(d)); cross.setAttribute("x2", x(d)); cross.setAttribute("visibility", "visible");
    series.forEach((s, n) => { dots[n].setAttribute("cx", x(d)); dots[n].setAttribute("cy", y(s.pts[i].total)); dots[n].setAttribute("visibility", "visible"); });
    showTip(e, { color: "var(--series-1)", value: `+${d} min försening`, label: series.map((s) => `${s.label}: ${fmtKr(s.pts[i].total)}`).join(" · ") });
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); });
  container.prepend(el("div", { class: "legend" }, ...series.map((s) => el("span", {},
    el("span", { class: "swatch", style: `background:${s.color}` }), document.createTextNode(s.label)))));
}

function renderCostInfo(m) {
  const v = Object.fromEntries(m.params.map((p) => [p.key, p.value]));
  const changed = m.params.filter((p) => p.value !== p.default);
  const ex = m.explain;
  const h = (text) => el("h3", { text });
  const p = (text) => el("p", { text });
  const sumShares = (keys) => keys.reduce((a, k) => a + v[k], 0) || 1;
  const share = (key, keys) => pct0((100 * v[key]) / sumShares(keys));
  const groupKeys = ["share_consult", "share_public", "share_other"];
  const kr = (n) => `${nf(Math.round(n))} kr`;

  const purposeKeys = m.purposes.map((x) => `purpose_${x.key}_share`);
  const purposeRows = m.purposes.map((x) => {
    const sh = v[`purpose_${x.key}_share`] / sumShares(purposeKeys);
    return { cells: [x.label, pct0(100 * sh), pct0(v[`purpose_${x.key}_prob`]), kr(v[`purpose_${x.key}_cost`]),
      kr(sh * v[`purpose_${x.key}_prob`] / 100 * v[`purpose_${x.key}_cost`])] };
  });
  purposeRows.push({ strong: true, cells: ["Förväntad mötesförlust per tjänsteresenär", "", "", "", kr(ex.out.meeting_loss)] });

  const outKeys = ["out_next_share", "out_car_share", "out_digital_share", "out_stay_share"];
  const homeKeys = ["home_next_share", "home_hotel_share", "home_alt_share", "home_other_share"];
  const marginKeys = m.margins.map((x) => `margin_${x.key}`);
  const exampleRows = (list) => list.map((e) => ({ cells: [`+${e.delay} min`, ...KIND_ORDER.filter((k) => k !== "ops" && k !== "hotel" && k !== "travel").map((k) => fmtKr(e.kinds[k])), fmtKr(e.total)] }));
  const sc = (prof) => ex[prof].scenarios;

  const curve = el("div", { class: "chart info-curve" });
  $("cost-info-body").replaceChildren(
    el("p", { class: "lead", text: "Tågkoll räknar ut en ungefärlig kostnad för samhället för varje avgång: antal drabbade resenärer × kostnad per resenär, plus ersättningstrafik när tåget ställs in. " +
      "Beloppen är förväntade värden som bygger på schabloner. En enskild avgång kan i verkligheten kosta mer eller mindre, men över många avgångar ger genomsnittet en rimlig bild av storleksordningen." }),
    changed.length ? el("p", { class: "info-changed", text: `${changed.length} schabloner har ändrats av administratören. Siffrorna nedan visar värdena som gäller nu.` }) : "",

    h("Resenärerna"),
    p(`${nf(v.seats)} platser × ${pct0(v.occupancy)} beläggning = ${nf(ex.out.passengers)} resenärer per avgång. De delas i tre grupper:`),
    infoTable(["Grupp", "Andel", "Värde per timme"], [
      { cells: ["Konsulter och näringsliv", share("share_consult", groupKeys), `${nf(v.hour_consult)} kr/h i arbetstid`] },
      { cells: ["Offentlig sektor", share("share_public", groupKeys), `${nf(v.hour_public)} kr/h i arbetstid`] },
      { cells: ["Övriga (pendlare, studenter, privatresor)", share("share_other", groupKeys), `${nf(ex.out.delay_hour)} kr/h förseningstid`] },
    ], [1]),
    p(`Förseningstid på fritid värderas enligt Trafikverkets kalkylvärden (ASEK): restidsvärdet för långväga privata tågresor, ${nf(v.hour_leisure)} kr/h, × ${nf(v.delay_factor, 1)} = ${nf(ex.out.delay_hour)} kr/h. ` +
      `På kvällen värderas allas tid så, eftersom hemresan sker efter arbetstid.`),
    p("ASEK använder faktorn 3,5 även för tjänsteresor. Tågkoll gör inte det: faktorn fångar i ASEK följderna av att inte kunna planera, och de följderna – missade möten, att vända hem, förmiddagen efter – räknas här var för sig. Att göra både och vore att räkna samma sak två gånger."),
    p(`Arbetstid går bara delvis förlorad. Ombord på ett försenat tåg antas tjänsteresenärerna kunna arbeta ${pct0(v.prod_onboard)} av tiden, på perrongen, i ersättningsbuss eller bakom ratten ${pct0(v.prod_offboard)}.`),

    h("Kostnad över försening"),
    p("Kurvan visar vad en avgång kostar vid olika förseningar. Utresan tar hopp när marginalerna till mötena tar slut och när en del vänder hem. Hemresan växer när man kommer hem så sent att förmiddagen efter påverkas."),
    curve,

    h("Utresa: förväntad mötesförlust"),
    p("Vad kostar det när en tjänsteresenär inte kommer fram alls? Det beror på vad hen skulle göra i Stockholm, och det är inte säkert att frånvaron får betydelse. Därför vägs varje ändamål med en sannolikhet."),
    infoTable(["Ändamål", "Andel", "Sannolikhet", "Kostnad när den får betydelse", "Förväntat"], purposeRows, [1, 2, 3, 4]),

    h("Utresa: försenat tåg"),
    p("Mötesförlusten räknas bara för den som har mindre marginal mellan ankomst och mötets början än förseningen. Inom varje intervall antas resenärerna vara jämnt fördelade."),
    infoTable(["Marginal till mötet", "Andel"], m.margins.map((x) => ({ cells: [x.label, share(`margin_${x.key}`, marginKeys)] })), [1]),
    p(`Den som kommer för sent förlorar ${pct0(v.effect_lt30)} av mötesförlusten vid under 30 minuter, ${pct0(v.effect_30_90)} vid 30–90 minuter och ${pct0(v.effect_gt90)} vid mer än 90 minuter. ` +
      `Från 30 minuters försening deltar ${pct0(v.digital_onboard_share)} av de sena digitalt från tåget och förlorar då bara ${pct0(v.out_digital_effect)}. ` +
      `Är tåget mer än ${nf(v.abort_after)} minuter sent vänder ${pct0(v.abort_share)} av tjänsteresenärerna hem: de förlorar ${unitText(v.abort_hours, "h")} arbetstid och hela mötesförlusten.`),
    infoTable(["Försening", "Tid", "Möten", "Dagen efter", `Summa (${nf(ex.out.passengers)} resenärer)`], exampleRows(ex.out.delay_examples), [1, 2, 3, 4]),

    h("Utresa: inställt tåg"),
    infoTable(["Vad tjänsteresenären gör", "Andel", "Antagande"], [
      { cells: ["Tar nästa tåg", share("out_next_share", outKeys), `${unitText(v.out_next_hours, "h")} senare med ${pct0(v.prod_offboard)} arbetsförmåga, ${pct0(v.effect_gt90)} av mötesförlusten`] },
      { cells: ["Tar bilen", share("out_car_share", outKeys), `${kr(v.out_car_cost)} och ${unitText(v.out_car_hours, "h")} utan arbete, ${pct0(v.out_car_effect)} av mötesförlusten`] },
      { cells: ["Deltar digitalt", share("out_digital_share", outKeys), `${unitText(v.out_digital_hours, "h")} omplanering, ${pct0(v.out_digital_effect)} av mötesförlusten`] },
      { cells: ["Ställer in resan", share("out_stay_share", outKeys), `${unitText(v.out_stay_hours, "h")} förlorad arbetstid, hela mötesförlusten`] },
      { strong: true, cells: [`Per avgång (${nf(ex.out.passengers)} resenärer)`, "", fmtKr(ex.out.cancelled.total)] },
    ], [1]),
    p(`Övriga resenärer tar nästa tåg (förseningstid). I summan ingår ersättningstrafik och hantering, ${kr(v.ops_cost)} per inställd avgång.`),

    h("Hemresa: försenat tåg"),
    p(`Förseningen värderas till ${nf(ex.home.delay_hour)} kr per timme och resenär. Kommer man hem mer än ${nf(v.late_after)} minuter för sent förlorar tjänsteresenärerna ${unitText(v.nextday_hours, "h")} arbetstid förmiddagen efter, ` +
      `och ${pct0(v.family_share)} måste lösa hämtning eller barnomsorg (${kr(v.family_cost)}). Den effekten växer gradvis under timmen före gränsen.`),
    infoTable(["Försening", "Tid", "Möten", "Dagen efter", `Summa (${nf(ex.home.passengers)} resenärer)`], exampleRows(ex.home.delay_examples), [1, 2, 3, 4]),

    h("Hemresa: inställt tåg"),
    infoTable(["Vad resenären gör", "Andel", "Antagande"], [
      { cells: ["Väntar på nästa tåg", share("home_next_share", homeKeys), `${unitText(v.home_next_hours, "h")} senare`] },
      { cells: ["Hotellnatt", share("home_hotel_share", homeKeys), `${kr(v.home_hotel_cost)}, ${unitText(v.home_hotel_evening, "h")} förlorad kväll, ${unitText(v.home_hotel_work, "h")} arbetstid dagen efter`] },
      { cells: ["Hyrbil eller buss", share("home_alt_share", homeKeys), `${unitText(v.home_alt_hours, "h")} senare, ${kr(v.home_alt_cost)}`] },
      { cells: ["Annat (taxi, skjuts, sitter fast)", share("home_other_share", homeKeys), kr(v.home_other_cost)] },
      { strong: true, cells: [`Per avgång (${nf(ex.home.passengers)} resenärer)`, "", fmtKr(ex.home.cancelled.total)] },
    ], [1]),
    p(`Alla som kommer hem sent räknas också med förmiddagen efter och familjelogistik, och ersättningstrafiken (${kr(v.ops_cost)}) ingår.`),

    h("Känt i förväg eller akut"),
    p(`Ett inställt tåg som var känt minst ${unitText(v.advance_hours, "h")} före avgång kostar mindre: resenärerna hinner boka om, flytta mötet eller åka på annat sätt, och ingen står och väntar. ` +
      `Resenärernas kostnad räknas då som ${pct0(v.advance_out)} av en akut inställning för utresan och ${pct0(v.advance_home)} för hemresan; ersättningstrafiken räknas fullt.`),
    p(`En försening som är minst ${nf(v.known_delay_after)} minuter redan vid avgång är också känd: resenärerna kan välja som vid ett inställt tåg. Den avgången räknas därför högst som ett akut inställt tåg. ` +
      "En försening som uppstår under resan har inget sådant tak – då sitter resenärerna fast och kan inte välja, och det kan bli dyrare än ett inställt tåg."),
    infoTable(["", "Utresa", "Hemresa"], [
      { cells: ["Inställt, akut", fmtKr(ex.out.cancelled.total), fmtKr(ex.home.cancelled.total)] },
      { cells: ["Inställt, känt i förväg", fmtKr(ex.out.cancelled_advance), fmtKr(ex.home.cancelled_advance)] },
      ...ex.out.late_examples.map((e, i) => ({ cells: [`+${e.delay} min, uppstod under resan / känd vid avgång`,
        `${fmtKr(e.en_route)} / ${fmtKr(e.at_start)}`, `${fmtKr(ex.home.late_examples[i].en_route)} / ${fmtKr(ex.home.late_examples[i].at_start)}`] })),
    ], [1, 2]),
    p("Tågkoll ser när Trafikverket senast ändrade en inställd avgång och hur sent tåget var när det lämnade startstationen. Importerad historik saknar de uppgifterna och räknas som akut och som försening under resan."),

    h("Kopplingen mellan morgon och kväll"),
    p(`Den som inte kom iväg på morgonen åker inte hem på kvällen. Om ett bevakat tåg till Stockholm ställdes in samma dag antas ${pct0(v.home_paired_share)} av hemresenärerna ha åkt upp med det, ` +
      "och de tjänsteresenärer som då deltog digitalt eller ställde in resan räknas inte igen på hemresan. Var morgontåget bara försenat påverkas inte hemresan."),

    h("Spannet: lågt och högt scenario"),
    p(`Spannet räknas med andra schabloner för det som är mest osäkert. Lågt: ${pct0(v.low_occupancy)} beläggning, konsulttimme ${nf(v.low_hour_consult)} kr (arbetskostnad), ${pct0(v.low_prod_onboard)} arbetsförmåga ombord. ` +
      `Högt: ${pct0(v.high_occupancy)} beläggning, konsulttimme ${nf(v.high_hour_consult)} kr (debitering), ${pct0(v.high_prod_onboard)} arbetsförmåga ombord.`),
    infoTable(["", "Lågt", "Grund", "Högt"], [
      { cells: ["Utresa, inställt", fmtKr(sc("out").low.cancelled), fmtKr(sc("out").base.cancelled), fmtKr(sc("out").high.cancelled)] },
      { cells: ["Utresa, +60 min", fmtKr(sc("out").low.delay60), fmtKr(sc("out").base.delay60), fmtKr(sc("out").high.delay60)] },
      { cells: ["Hemresa, inställt", fmtKr(sc("home").low.cancelled), fmtKr(sc("home").base.cancelled), fmtKr(sc("home").high.cancelled)] },
      { cells: ["Hemresa, +60 min", fmtKr(sc("home").low.delay60), fmtKr(sc("home").base.delay60), fmtKr(sc("home").high.delay60)] },
    ], [1, 2, 3]),

    h("Dold kostnad: resor kvällen före"),
    p(`När morgontåget är opålitligt åker en del till Stockholm kvällen före och bor på hotell för att säkert hinna till mötet. Tågkoll räknar med ${nf(v.hidden_per_day)} resenärer per avgång, ` +
      `${kr(v.hidden_hotel)} i hotell och traktamente och ${unitText(v.hidden_evening, "h")} förlorad kväll: ${fmtKr(ex.out.hidden_per_journey)} per avgång. Beloppet är osäkert och visas därför separat, utanför summan.`),

    h("Jämfört med andra beräkningar"),
    p("En annan beräkning för samma tågpar landar betydligt högre: ungefär 2,1 miljoner kronor för ett inställt morgontåg och 1,3 miljoner för ett inställt kvällståg, med 300 resenärer. Skillnaden beror främst på:"),
    el("ul", {},
      el("li", { text: "Produktivitet ombord: den som sitter kvar på ett försenat tåg kan oftast arbeta. Bara väntan på perrong, buss och bil räknas med låg arbetsförmåga." }),
      el("li", { text: "Alla som ska på möte missar inte: mötesförlusten vägs med marginal och sannolikhet, och en del deltar digitalt eller tar nästa tåg." }),
      el("li", { text: "Förseningsfaktorn 3,5 används bara för fritid. För tjänsteresenärerna räknas följderna av förseningen (möten, vända hem, dagen efter) var för sig i stället." }),
      el("li", { text: "Den andra beräkningen antar i praktiken att alla resenärer förlorar en halv arbetsdag när morgontåget ställs in. Här tar många nästa tåg eller deltar digitalt." })),
    p("Det höga scenariot använder den andra beräkningens antaganden om beläggning, konsulternas timvärde och arbetsförmåga ombord. Resten av skillnaden kommer av punkterna ovan."),

    h("Det här räknas inte in"),
    el("ul", {},
      el("li", { text: "SJ:s förseningsersättning – den är en överföring mellan SJ och resenären, inte en kostnad för samhället. Hanteringen ingår i ersättningstrafiken." }),
      el("li", { text: "Följdförseningar för andra tåg." }),
      el("li", { text: "Dold kostnad för resor kvällen före – den visas separat." })),

    el("p", { class: "sub", text: "Schablonerna kan ändras av administratören på adminsidan. Hela modellen beskrivs i docs/kostnadsmodell.md i Tågkolls källkod." }),
  );
  curveChart(curve, ex);
}

async function openCostInfo() {
  const dlg = $("cost-info");
  dlg.showModal();
  try {
    costModel = await api("/api/cost/model");
    renderCostInfo(costModel);
  } catch (e) {
    $("cost-info-body").replaceChildren(el("p", { class: "sub", text: e.message }));
  }
}
$("cost-info-open").addEventListener("click", openCostInfo);
$("cost-info-close").addEventListener("click", () => $("cost-info").close());
$("cost-info").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("cost-info").addEventListener("close", hideTip);

// ------------------------------------------------------------- datans ålder
function fmtAge(days) {
  if (days === null || days === undefined) return "";
  if (days < 1) return "i dag";
  if (days === 1) return "i går";
  if (days < 14) return `för ${days} dagar sedan`;
  if (days < 60) return `för ${Math.round(days / 7)} veckor sedan`;
  const months = Math.round(days / 30.44);
  if (months < 12) return `för ${months} månader sedan`;
  const years = Math.floor(months / 12), rest = months % 12;
  return `för ${years} år${rest ? ` och ${rest} mån` : ""} sedan`;
}
const longDate = (iso) => fmtDate(iso, { day: "numeric", month: "long", year: "numeric" });

function ageText(t) {
  if (!t.first_date) return "Inga datapunkter ännu.";
  let text = `Äldsta datapunkt ${longDate(t.first_date)} (${fmtAge(t.age_days)}).`;
  if (t.first_imported_date && t.first_collected_date) {
    text += ` Egen insamling från Trafikverket sedan ${longDate(t.first_collected_date)}, äldre dagar är importerad historik.`;
  } else if (t.first_imported_date) {
    text += " Bara importerad historik, ingen egen insamling ännu.";
  }
  return text;
}

// ------------------------------------------------------------------- linjen
const TRACKS = { 1: "Enkelspår", 2: "Dubbelspår" };
const segTrackLabel = (s) => (s.split
  ? `${trackLabel(s.split.before)} till ${s.split.at}, sedan ${trackLabel(s.split.after).toLowerCase()}`
  : trackLabel(s.tracks));
const trackLabel = (n) => (n === "mixed" ? "Enkel- och dubbelspår" : TRACKS[n] ?? "Okänt antal spår");

function segmentColor(s) {
  if (s.canceled) return "var(--critical)";
  if (s.added === null) return "var(--neutral)";
  if (s.added >= 2) return "var(--late)";
  return "var(--axis)";
}

/** Tidpunkter då tåget passerar varje punkt. planned = enligt tidtabell, annars verkligt/beräknat. */
function timeline(points, planned) {
  const seq = [];
  let lastDelay = 0, last = -Infinity, stoppedAt = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!planned && p.canceled) { stoppedAt = Math.max(0, i - 1); break; }
    for (const key of ["arr", "dep"]) {
      const plan = ms(p[`planned_${key}`]);
      if (plan === null) continue;
      let t = plan;
      if (!planned) {
        if (p[`canceled_${key}`]) continue;
        const actual = ms(p[`actual_${key}`]);
        if (actual !== null) { t = actual; lastDelay = p[`delay_${key}`]; }
        else t = ms(p[`estimated_${key}`]) ?? plan + lastDelay * 60000;
      }
      t = Math.max(t, last);
      last = t;
      seq.push({ t, i, plan, delay: Math.round((t - plan) / 60000), known: planned || p[`actual_${key}`] !== null });
    }
  }
  if (!planned && !seq.length) stoppedAt = 0;
  return { seq, stoppedAt };
}

/** Läge (x) och försening vid tiden t. xEv ger x för en händelse i tidslinjen. */
function positionAt(tl, t, xEv, x0) {
  const { seq } = tl;
  if (!seq.length) return { x: x0, delay: 0, index: 0 };
  if (t <= seq[0].t) return { x: xEv(seq[0]), delay: seq[0].delay, index: seq[0].i };
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1], b = seq[k];
    if (t < b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      // Mellan två olika punkter rullar tåget; mellan ankomst och avgång på samma station står det still.
      return { x: xEv(a) + (xEv(b) - xEv(a)) * f, delay: a.delay, index: f < 0.5 ? a.i : b.i, moving: a.i !== b.i };
    }
  }
  const z = seq[seq.length - 1];
  return { x: xEv(z), delay: z.delay, index: z.i };
}

/** Tågets siluett med fronten i (0,0) och färdriktning åt höger. */
function trainShape(parent, scale) {
  const g = svg("g", { class: "train" }, parent);
  const body = svg("g", { transform: `scale(${scale})` }, g);
  svg("path", { class: "train-body", d: "M-46-17h28c9 0 14 6 18 13v2a2 2 0 0 1-2 2h-44a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" }, body);
  svg("rect", { class: "train-win", x: -43, y: -13, width: 22, height: 4, rx: 1.5 }, body);
  svg("path", { class: "train-win", d: "M-17-13h2c3 0 5.5 2 7 4h-9z" }, body);
  return g;
}

/**
 * Spåret med stationer, tåget och platsen där tåget borde vara enligt tidtabell.
 * Körd sträcka är svart, återstående grå, inställd sträcka rödprickad. Avståndet mellan tåget och
 * tidtabellen ritas orange. Returnerar update(t), som flyttar tåget till tiden t.
 */
function railScene(root, j, { xT, railY, scale, mini }) {
  const pts = j.points, last = pts.length - 1;
  const xOf = (i) => xT(ms(pts[i].planned_arr ?? pts[i].planned_dep));
  const xEv = (e) => xT(e.plan);
  const real = timeline(pts, false), plan = timeline(pts, true);
  const fully = j.status === "cancelled";
  const x0 = xOf(0), xN = xOf(last);
  svg("line", { class: "rail rail-todo", x1: x0, x2: xN, y1: railY, y2: railY }, root);
  const cutFrom = fully ? 0 : real.stoppedAt;
  let cutX = null;
  if (cutFrom !== null) {
    cutX = fully ? x0 + 7 : Math.min(xN - 4, xOf(cutFrom) + 8);
    svg("line", { class: "rail rail-cut", x1: cutX + 6, x2: xN, y1: railY, y2: railY }, root);
  }
  const done = svg("line", { class: "rail rail-done", x1: x0, x2: x0, y1: railY, y2: railY }, root);
  const gap = svg("line", { class: "rail-gap", y1: railY, y2: railY }, root);
  if (cutX !== null) svg("line", { class: "cut-bar", x1: cutX, x2: cutX, y1: railY - 9, y2: railY + 8 }, root);
  const dots = [];
  pts.forEach((p, i) => {
    const end = i === 0 || i === last;
    if (!p.advertised && !end) return;
    const cut = cutFrom !== null && (fully || i > cutFrom);
    dots.push([xOf(i), svg("circle", { class: "st" + (cut ? " st-cut" : ""), cx: xOf(i), cy: railY, r: end ? 4.5 : 3.5 }, root)]);
  });
  const ghost = svg("circle", { class: "ghost", cy: railY, r: 7 }, root);
  const train = trainShape(root, scale);
  const bracket = svg("path", { class: "gap-bracket" }, root);
  const label = svg("text", { class: "gap-label", "text-anchor": "middle" }, root);
  const note = svg("text", { class: "mini-note" }, root);

  const startT = ms(pts[0].planned_dep ?? pts[0].planned_arr);
  const arrival = ms(pts[last].planned_arr ?? pts[last].planned_dep);
  const lastReal = real.seq.length ? real.seq[real.seq.length - 1].t : arrival;
  const firstReal = real.seq.length ? real.seq[0].t : startT;
  const endT = j.status === "pending" ? Math.max(Date.now(), startT) : Math.max(arrival, lastReal);
  // Ett tåg som har kommit fram står vid slutstationen; uppspelningen visar resan dit.
  const arrived = j.status !== "pending" && !fully && real.stoppedAt === null;
  const defaultT = j.status === "pending" ? Date.now() : endT;

  function update(t) {
    const r = fully ? { x: x0, delay: 0, index: 0 } : positionAt(real, t, xEv, x0);
    const g = positionAt(plan, t, xEv, x0);
    const stopped = fully || (real.stoppedAt !== null && t >= lastReal);
    const idle = stopped || t <= firstReal || (arrived && t >= lastReal);
    train.setAttribute("transform", `translate(${r.x},${railY - 3})`);
    train.classList.toggle("idle", idle);
    done.setAttribute("x2", cutX === null ? r.x : Math.min(r.x, cutX));
    for (const [x, c] of dots) c.classList.toggle("passed", !fully && x <= r.x + 0.5);
    const late = stopped ? 0 : Math.max(0, r.delay ?? 0);
    const apart = !stopped && g.x - r.x > 12 * scale;
    show(ghost, apart);
    ghost.setAttribute("cx", g.x);
    const showGap = apart && late > 0;
    show(gap, showGap);
    gap.setAttribute("x1", r.x);
    gap.setAttribute("x2", g.x);
    show(label, mini && showGap);
    show(bracket, mini && showGap);
    if (mini && showGap) {
      const ty = railY - 24;
      bracket.setAttribute("d", `M${r.x},${ty + 5} v-4 H${g.x} v4`);
      label.setAttribute("x", (r.x + g.x) / 2);
      label.setAttribute("y", ty - 4);
      label.textContent = `+${late} min`;
    }
    const waiting = j.status === "pending" && t <= firstReal && !apart;
    show(note, mini && waiting);
    if (mini && waiting) {
      note.setAttribute("x", r.x + 10);
      note.setAttribute("y", railY - 9);
      note.textContent = `avgår ${hhmm(j.forecast_delay > 0 ? j.estimated_departure : j.planned_departure)}`;
    }
    return { ...r, g, stopped, idle, late, apart };
  }
  return { update, startT, endT, defaultT, arrived, fully, xOf, real };
}

/** Spåret i liten skala för startsidan. */
function drawMini(box, j) {
  box.replaceChildren();
  if (!j || !(j.points?.length > 1)) return;
  const width = Math.max(220, box.clientWidth), height = 62, railY = 38;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, class: "line-svg mini", "aria-hidden": "true" }, box);
  const pts = j.points, last = pts.length - 1;
  const m = { l: 42, r: 12 };
  const tp = (p) => ms(p.planned_arr ?? p.planned_dep);
  const t0 = tp(pts[0]), span = (tp(pts[last]) - t0) || 1;
  const xT = (t) => m.l + ((t - t0) / span) * (width - m.l - m.r);
  const sc = railScene(root, j, { xT, railY, scale: 0.72, mini: true });
  const a = svg("text", { x: m.l - 6, y: railY + 20, class: "end-name" }, root);
  a.textContent = pts[0].station;
  const b = svg("text", { x: width - m.r + 6, y: railY + 20, "text-anchor": "end", class: "end-name" }, root);
  b.textContent = pts[last].station;
  sc.update(sc.defaultT);
}

/** Tidtext för en station: verklig tid, prognos eller tidtabell. */
function stationTime(j, p, first) {
  const [k1, k2] = first ? ["dep", "arr"] : ["arr", "dep"];
  const planned = p[`planned_${k1}`] ?? p[`planned_${k2}`];
  const actual = p[`actual_${k1}`] ?? p[`actual_${k2}`];
  const delay = p[`delay_${k1}`] ?? p[`delay_${k2}`];
  if (p.canceled) return { planned, cls: "cut", text: "inställt" };
  if (actual) return { planned, actual, delay, cls: delay > state.data.threshold ? "late" : "", text: hhmm(actual) + (delay >= 2 ? ` (+${delay})` : "") };
  if (j.status === "pending") {
    const est = p[`estimated_${k1}`] ?? p[`estimated_${k2}`];
    const fd = est ? Math.round((ms(est) - ms(planned)) / 60000) : (j.current_delay ?? j.forecast_delay ?? 0);
    if (fd >= 1) return { planned, forecast: est ? hhmm(est) : clock(ms(planned) + fd * 60000), fd, cls: "fc", text: `≈ ${est ? hhmm(est) : clock(ms(planned) + fd * 60000)}` };
  }
  return { planned, cls: "plan", text: hhmm(planned) };
}

/** Förseningsprofilen: höjden över spåret är minuter efter tidtabell. Används på breda skärmar. */
function renderProfile(box, j) {
  box.replaceChildren();
  const width = Math.max(300, box.clientWidth);
  const wide = width >= 760;
  const thr = state.data.threshold;
  const pts = j.points, last = pts.length - 1;
  const m = { l: 46, r: 20 };
  const tp = (p) => ms(p.planned_arr ?? p.planned_dep);
  const t0 = tp(pts[0]), span = (tp(pts[last]) - t0) || 1;
  const xT = (t) => m.l + ((t - t0) / span) * (width - m.l - m.r);
  const xOf = (i) => xT(tp(pts[i]));

  // Kurvan: verkliga förseningar (heldragen) och prognos för resten av ett pågående tåg (streckad).
  const curve = [], fc = [];
  let stop = false;
  pts.forEach((p) => {
    if (stop || p.canceled) { stop = true; return; }
    for (const key of ["arr", "dep"]) {
      const plan = ms(p[`planned_${key}`]);
      if (plan === null || p[`canceled_${key}`]) continue;
      if (p[`actual_${key}`]) curve.push([xT(plan), p[`delay_${key}`]]);
      else if (j.status === "pending") {
        const est = ms(p[`estimated_${key}`]);
        const fallback = curve.length ? curve[curve.length - 1][1] : (j.forecast_delay ?? 0);
        fc.push([xT(plan), est !== null ? Math.round((est - plan) / 60000) : fallback]);
      }
    }
  });
  const delays = [...curve, ...fc].map(([, v]) => v);
  // Utan verkliga tider eller prognos finns ingen kurva: då räcker spåret.
  const flat = !curve.length && !fc.some(([, v]) => v > 0);
  const top = flat ? 26 : 34, railY = flat ? 44 : 200, height = railY + 50;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img", class: "line-svg profile" }, box);
  const ticks = niceTicks(0, Math.max(thr * 2, ...delays), 3);
  const hi = ticks[ticks.length - 1];
  const yOf = (v) => railY - (Math.max(0, v) / hi) * (railY - top);

  // Enkelspår som ljusgrå zon bakom kurvan.
  const runs = j.segments.filter((s) => s.kind === "run");
  const bands = [];
  runs.forEach((s, k) => {
    const a = xOf(k), b = xOf(k + 1);
    const parts = s.split ? [[a, a + (b - a) * s.split.fraction, s.split.before], [a + (b - a) * s.split.fraction, b, s.split.after]] : [[a, b, s.tracks]];
    for (const [x1, x2, n] of parts) {
      if (n !== 1) continue;
      const prev = bands[bands.length - 1];
      if (prev && Math.abs(prev[1] - x1) < 0.5) prev[1] = x2; else bands.push([x1, x2]);
    }
  });
  if (!flat) bands.forEach(([x1, x2], n) => {
    svg("rect", { class: "band-single", x: x1, y: top - 10, width: Math.max(0, x2 - x1), height: railY - top + 10 }, root);
    if (n === 0 && x2 - x1 > 64) { const t = svg("text", { class: "band-label", x: x1 + 6, y: top + 4 }, root); t.textContent = "enkelspår"; }
  });

  if (!flat) for (const v of ticks.slice(1)) {
    svg("line", { class: "grid", x1: m.l, x2: width - m.r, y1: yOf(v), y2: yOf(v) }, root);
    const t = svg("text", { class: "tick", x: m.l - 8, y: yOf(v) + 4, "text-anchor": "end" }, root);
    t.textContent = v === hi ? `${v} min` : String(v);
  }
  if (!flat) {
    svg("line", { class: "threshold", x1: m.l, x2: width - m.r, y1: yOf(thr), y2: yOf(thr) }, root);
    const thrText = svg("text", { class: "tick", x: width - m.r, y: yOf(thr) - 5, "text-anchor": "end" }, root);
    thrText.textContent = wide ? `gräns för försenat, ${thr} min` : `${thr} min`;
  }

  const clipId = `clip-${Math.random().toString(36).slice(2)}`;
  const clip = svg("clipPath", { id: clipId }, root);
  const clipRect = svg("rect", { x: 0, y: 0, width, height }, clip);
  const layer = svg("g", { "clip-path": `url(#${clipId})` }, root);
  if (curve.length) {
    const line = curve.map(([x, v], k) => `${k ? "L" : "M"}${x},${yOf(v)}`).join(" ");
    svg("path", { class: "curve-fill", d: `M${curve[0][0]},${railY} ${line.replace(/^M/, "L")} L${curve[curve.length - 1][0]},${railY} Z` }, layer);
    svg("path", { class: "curve", d: line }, layer);
  }
  if (fc.length && fc.some(([, v]) => v > 0)) {
    const start = curve.length ? [curve[curve.length - 1]] : [];
    const d = [...start, ...fc].map(([x, v], k) => `${k ? "L" : "M"}${x},${yOf(v)}`).join(" ");
    svg("path", { class: "curve-fc", d }, root);
    const lastFc = fc[fc.length - 1];
    if (wide && Math.abs(yOf(lastFc[1]) - yOf(thr)) > 14) {
      const t = svg("text", { class: "tick fc-label", x: lastFc[0], y: yOf(lastFc[1]) - 6, "text-anchor": "end" }, root);
      t.textContent = "prognos";
    }
  }

  // Största ökningen får en etikett på breda skärmar, vänster om sträckan där kurvan ännu ligger lågt.
  const worst = worstSegment(j);
  if (wide && worst && !worst.canceled) {
    const i = pts.findIndex((p, k) => worst.kind === "stop" ? p.sig === worst.from_sig : p.sig === worst.from_sig && pts[k + 1]?.sig === worst.to_sig);
    if (i >= 0) {
      const x1 = worst.kind === "stop" ? xT(ms(pts[i].planned_arr)) : xOf(i);
      const x2 = worst.kind === "stop" ? xT(ms(pts[i].planned_dep)) : xOf(i + 1);
      const why = [lower(worst.deviations[0]), worst.kind === "stop" ? `uppehållet i ${worst.from}` : `${worst.from}–${worst.to}`].filter(Boolean).join(", ");
      const w = Math.max(why.length * 6.4, 60);
      const left = x1 - 10 - w > m.l;
      const tx = left ? x1 - 10 : x2 + 10;
      const ty = Math.max(top + 14, Math.min(railY - 24, yOf(worst.delay_to) + (left ? 4 : 18)));
      const a = svg("text", { class: "worst", x: tx, y: ty, "text-anchor": left ? "end" : "start" }, root);
      a.textContent = `+${worst.added} min`;
      const b = svg("text", { class: "worst-why", x: tx, y: ty + 14, "text-anchor": left ? "end" : "start" }, root);
      b.textContent = why;
    }
  }

  // Träffytor för delsträckorna (tooltip med detaljer).
  runs.forEach((s, k) => {
    const x1 = xOf(k), x2 = xOf(k + 1);
    const g = svg("g", { class: "seg" }, root);
    svg("rect", { class: "hit", x: x1, y: flat ? railY - 14 : top - 10, width: Math.max(2, x2 - x1), height: flat ? 28 : railY - top + 22 }, g);
    const tipData = {
      color: segmentColor(s), label: `${s.from} → ${s.to}`,
      value: s.canceled ? "Inställd sträcka" : s.added === null ? "Ej körd ännu" : `${s.added > 0 ? "+" : ""}${s.added} min på sträckan`,
      extra: [segTrackLabel(s), s.line, ...s.deviations].filter(Boolean).join(" · "),
    };
    g.addEventListener("pointermove", (e) => { g.classList.add("hover"); showTip(e, tipData); });
    g.addEventListener("pointerleave", () => { g.classList.remove("hover"); hideTip(); });
  });

  const sc = railScene(root, j, { xT, railY, scale: wide ? 1 : 0.85, mini: false });

  // Stationsnamn och tider under spåret. Start och slut får alltid plats, övriga där det finns utrymme.
  const placed = [];
  const fits = (a, b) => placed.every(([c, d]) => b + 10 < c || a > d + 10);
  const boxOf = (i, w) => {
    const x = xOf(i);
    const anchor = i === 0 ? "start" : i === last ? "end" : "middle";
    const left = anchor === "start" ? x - 6 : anchor === "end" ? x - w + 6 : x - w / 2;
    return { anchor, left, right: left + w, tx: anchor === "start" ? x - 6 : anchor === "end" ? x + 6 : x };
  };
  const order = [0, last, ...pts.map((_, i) => i).filter((i) => i !== 0 && i !== last && pts[i].advertised)];
  for (const i of order) {
    const p = pts[i], time = stationTime(j, p, i === 0);
    const w = Math.max(p.station.length * 6.6, time.text.length * 6.3);
    const b = boxOf(i, w);
    if (i !== 0 && i !== last && !fits(b.left, b.right)) continue;
    placed.push([b.left, b.right]);
    const g = svg("g", { class: "station" }, root);
    const n = svg("text", { x: b.tx, y: railY + 22, "text-anchor": b.anchor, class: "st-name" + (i === 0 || i === last ? " end" : "") }, g);
    n.textContent = p.station;
    const t = svg("text", { x: b.tx, y: railY + 38, "text-anchor": b.anchor, class: `st-time ${time.cls}` }, g);
    t.textContent = time.text;
  }
  // Träffytor för stationerna.
  pts.forEach((p, i) => {
    if (!p.advertised && i !== 0 && i !== last) return;
    const x = xOf(i);
    const g = svg("g", {}, root);
    svg("rect", { class: "hit", x: x - 9, y: railY - 12, width: 18, height: 24 }, g);
    const plan = p.planned_dep ?? p.planned_arr, actual = p.actual_dep ?? p.actual_arr;
    const delay = p.delay_dep ?? p.delay_arr;
    const tipData = { color: "var(--ink-2)", label: p.station,
      value: p.canceled ? "Inställt" : actual ? `${hhmm(actual)} (${fmtDelay(delay)})` : `Planerat ${hhmm(plan)}`,
      extra: [`Tidtabell ${hhmm(plan)}`, p.track ? `spår ${p.track}` : null, ...p.deviations].filter(Boolean).join(" · ") };
    g.addEventListener("pointermove", (e) => showTip(e, tipData));
    g.addEventListener("pointerleave", hideTip);
  });

  const total = svg("text", { class: "total-label", "text-anchor": "middle" }, root);
  const ghostTag = svg("text", { class: "ghost-tag" }, root);
  ghostTag.textContent = "här enligt tidtabell";

  function update(t, playing) {
    const r = sc.update(t);
    clipRect.setAttribute("width", playing ? Math.max(0, r.x + 1) : width);
    const showTotal = r.late >= 1 && !sc.fully;
    show(total, showTotal);
    if (showTotal) {
      total.setAttribute("x", Math.min(width - m.r - 24, Math.max(m.l + 24, r.x)));
      total.setAttribute("y", Math.max(14, yOf(r.late) - 12));
      total.textContent = `+${r.late} min`;
    }
    show(ghostTag, wide && r.apart);
    ghostTag.setAttribute("x", r.g.x + 11);
    ghostTag.setAttribute("y", railY - 11);
    $("line-clock").textContent = playing ? `kl ${clock(t)}` : "";
    return r;
  }
  root.setAttribute("aria-label", storyText(j));
  return { update, sc };
}

/** Delsträckor och uppehåll grupperade efter punkt: idx = punkten där de börjar. */
function segmentsByPoint(j) {
  let i = 0;
  const out = [];
  for (const s of j.segments ?? []) {
    out.push({ s, idx: i });
    if (s.kind === "run") i++;
  }
  return out;
}

/** Stationslistan: spåret på högkant, som i en reseapp. Används i smala fönster. */
function renderStationList(box, j) {
  const pts = j.points, last = pts.length - 1, thr = state.data.threshold;
  const listed = pts.map((_, i) => i).filter((i) => i === 0 || i === last || pts[i].advertised);
  const fully = j.status === "cancelled";
  const lastSeen = pts.reduce((k, p, i) => (p.actual_arr || p.actual_dep ? i : k), -1);
  const onWay = j.status === "pending" && lastSeen >= 0;
  const dIn = (p) => p.delay_arr ?? p.delay_dep;
  const segs = segmentsByPoint(j);
  const items = [];
  if (fully) items.push({ type: "cut", title: "Hela avgången inställd" });
  listed.forEach((i, n) => {
    const p = pts[i];
    if (n > 0) {
      const a = listed[n - 1], pa = pts[a];
      if (!fully && !pa.canceled && p.canceled) items.push({ type: "cut", title: "Inställt härifrån" });
      else if (!p.canceled) {
        const da = dIn(pa), db = dIn(p);
        if (da !== null && db !== null && db - da >= 2) items.push({ type: "gap", added: db - da, segs: segs.filter((x) => x.idx >= a && x.idx < i).map((x) => x.s) });
      }
      if (onWay && a <= lastSeen && i > lastSeen) items.push({ type: "here" });
    }
    items.push({ type: "row", i, p, passed: Boolean(p.actual_arr || p.actual_dep), cut: fully || p.canceled });
  });
  const topOf = (it) => it.type === "gap" ? "late" : it.type === "here" || it.type === "cut" ? "done" : it.cut ? "cut" : it.passed ? "done" : "todo";

  const list = el("ol", { class: "sl", "aria-label": "Stationer" });
  items.forEach((it, k) => {
    const topCls = k === 0 || (it.type === "cut" && fully) ? "none" : topOf(it);
    const bot = k === items.length - 1 ? "none" : topOf(items[k + 1]);
    const rail = el("span", { class: "sl-rail", "aria-hidden": "true" });
    const li = el("li", { class: `sl-${it.type} top-${topCls} bot-${bot}` });
    if (it.type === "row") {
      const end = it.i === 0 || it.i === last;
      const t = stationTime(j, it.p, it.i === 0);
      rail.append(el("span", { class: "sl-dot" + (end ? " end" : "") + (it.cut ? " cut" : it.passed ? " passed" : "") }));
      const time = el("span", { class: "sl-time" });
      if (it.cut) time.append(el("s", { text: hhmm(t.planned) }));
      else if (t.actual && Math.abs(t.delay) >= 1) time.append(el("s", { text: hhmm(t.planned) }), el("span", { text: hhmm(t.actual) }));
      else if (t.actual) time.append(el("span", { text: hhmm(t.actual) }));
      else if (t.forecast) time.append(el("s", { text: hhmm(t.planned) }), el("span", { class: "muted", text: `≈ ${t.forecast}` }));
      else time.append(el("span", { class: "muted", text: hhmm(t.planned) }));
      let badge = null;
      if (it.cut) badge = el("span", { class: "sl-cut-text", text: "inställt" });
      else if (t.actual) badge = t.delay > thr ? el("span", { class: "pill", text: `+${t.delay}` }) : el("span", { class: "sl-quiet", text: t.delay >= 1 ? `+${t.delay}` : "i tid" });
      else if (t.forecast) badge = el("span", { class: "pill fc", text: `+${t.fd}`, title: "prognos" });
      li.append(time, rail, el("span", { class: "sl-name" + (end ? " end" : "") + (!it.passed || it.cut ? " ahead" : ""), text: it.p.station }), badge ?? el("span"));
    } else if (it.type === "gap") {
      const why = [...new Set(it.segs.filter((s) => s.added > 0).flatMap((s) => s.deviations).map(lower))];
      const runsLate = it.segs.filter((s) => s.kind === "run" && s.added > 0);
      if (runsLate.length && runsLate.every((s) => s.tracks === 1)) why.push("enkelspår");
      li.append(el("span"), rail, el("div", { class: "sl-box late" },
        el("strong", { text: `+${it.added} min på sträckan` }), why.length ? el("span", { text: why.join(" · ") }) : null));
    } else if (it.type === "here") {
      const seen = pts[lastSeen];
      rail.append(el("span", { class: "sl-train" }));
      li.append(el("span", { class: "sl-time muted", text: clock(Date.now()) }), rail, el("div", { class: "sl-here" },
        el("strong", { text: "Tåget är här" }),
        el("span", { text: `senast rapporterat ${seen.station} ${hhmm(seen.actual_dep || seen.actual_arr)}` })));
    } else {
      const why = reasons(j);
      li.append(el("span"), rail, el("div", { class: "sl-box cut" }, el("strong", { text: it.title }), why.length ? el("span", { text: why.map(lower).join(", ") }) : null));
    }
    list.append(li);
  });
  box.replaceChildren(list);
}

let linePlay = null;
function stopPlay() {
  if (linePlay) cancelAnimationFrame(linePlay.raf);
  linePlay = null;
  $("line-play").textContent = "▶ Spela upp resan";
}

function lineJourney(journeys) {
  const withPoints = journeys.filter((j) => j.points.length > 1);
  if (state.lineDate) {
    const hit = withPoints.find((j) => j.date === state.lineDate) ??
      (state.lineExtra?.date === state.lineDate ? state.lineExtra : null);
    if (hit) return hit;
  }
  return withPoints[0] ?? null;
}

/** Datum i väljaren: årtalet bara när det inte är innevarande år. */
const pickDate = (iso) => fmtDate(iso, iso.slice(0, 4) === todayIso().slice(0, 4)
  ? { weekday: "short", day: "numeric", month: "short" } : { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function replayLabel(r) {
  if (r.status === "pending") return `${pickDate(r.date)} · ${r.current_delay !== null && r.current_delay !== undefined ? "på väg" : "planerat"}`;
  const outcome = (r.status === "ontime" || r.status === "delayed") && r.delay !== null
    ? (r.delay > 0 ? fmtDelay(r.delay) : "i tid") : STATUS[r.status].label.toLowerCase();
  return `${pickDate(r.date)} · ${outcome}`;
}

/** Väljaren med alla avgångar som har egna hållplatsdata. */
function renderLinePicker(date) {
  const pick = $("line-date");
  const list = state.replayable.some((r) => r.date === date) ? state.replayable : [{ date, status: "unknown", delay: null }, ...state.replayable];
  const key = list.map((r) => `${r.date}${r.status}${r.delay}`).join();
  if (pick.dataset.key !== key) {
    pick.replaceChildren(...list.map((r) => el("option", { value: r.date, text: replayLabel(r) })));
    pick.dataset.key = key;
  }
  pick.value = date;
}

async function pickLineDate(date) {
  const train = state.train;
  state.lineDate = date;
  stopPlay();
  if (state.view === "train") history.replaceState(null, "", `#${train}/${date}`);
  const inStats = state.data?.journeys.some((j) => j.date === date && j.points.length > 1);
  if (!inStats && state.lineExtra?.date !== date) {
    try {
      state.lineExtra = await api(`/api/journey?${new URLSearchParams({ train, date })}`);
    } catch (e) {
      if (state.train === train) showMessage(e.message);
    }
  }
  if (state.train === train && state.lineDate === date && !linePlay && state.data) {
    renderNow();
    renderLine();
    if (state.data.summary.journeys) renderDaily(state.data.journeys, state.data.threshold);
  }
}

$("line-date").addEventListener("change", (e) => pickLineDate(e.target.value));

function renderLine() {
  const card = $("line-card");
  const j = state.data ? lineJourney(state.data.journeys) : null;
  // Perioden kan sakna avgångar med hållplatsdata fast äldre finns – visa då den senaste av dem.
  if (!j && !state.lineDate && state.replayable.length) { pickLineDate(state.replayable[0].date); return; }
  card.hidden = !j;
  const notStarted = j && j.status === "pending" && (j.current_delay === null || j.current_delay === undefined);
  $("delay-details").hidden = !j || j.status === "cancelled" || notStarted;
  if (!j) { $("line-play").hidden = true; $("line-clock").textContent = ""; return; }
  if (linePlay) return;
  renderLinePicker(j.date);
  const box = $("line");
  if (box.clientWidth < 560) {
    renderStationList(box, j);
    $("line-play").hidden = true;
  } else {
    const prof = renderProfile(box, j);
    const sc = prof.sc;
    prof.update(sc.defaultT, false);
    $("line-play").hidden = sc.fully || notStarted;
    $("line-play").onclick = () => {
      if (linePlay) { stopPlay(); prof.update(sc.defaultT, false); return; }
      const duration = 8000, began = performance.now();
      $("line-play").textContent = "■ Stoppa";
      const step = (now) => {
        const f = Math.min(1, (now - began) / duration);
        prof.update(sc.startT + (sc.endT - sc.startT) * f, true);
        if (f < 1) linePlay.raf = requestAnimationFrame(step);
        else { stopPlay(); setTimeout(() => { if (!linePlay) prof.update(sc.defaultT, false); }, 1500); }
      };
      linePlay = { raf: requestAnimationFrame(step) };
    };
  }
  if (j.status !== "cancelled" && !notStarted) renderDelayDetails(j);
}

function worstSegment(j) {
  return (j.segments ?? []).filter((s) => s.added >= 2).sort((a, b) => b.added - a.added)[0] ?? null;
}

function renderDelayDetails(j) {
  const body = $("delay-body");
  const segs = j.segments;
  const name = (s) => (s.kind === "stop" ? `Uppehåll i ${s.from}` : `${s.from} → ${s.to}`);
  const worst = segs.filter((s) => s.added >= 2);
  const canceled = segs.find((s) => s.canceled);
  $("delay-summary").textContent = canceled ? `inställt från ${canceled.from}`
    : worst.length ? `${worst.length} ${worst.length === 1 ? "ställe" : "ställen"} där förseningen ökade`
    : segs.some((s) => s.added !== null) ? "ingen försening uppstod längs vägen" : "inga rapporterade tider ännu";

  const showAll = body.dataset.all === "1";
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.canceled && s.canceled && s.kind === "run" && prev.kind === "run") {
      merged[merged.length - 1] = { ...prev, to: s.to, tracks: prev.tracks === s.tracks && !prev.split && !s.split ? s.tracks : "mixed", split: null,
        line: prev.line === s.line ? s.line : null, deviations: [...new Set([...prev.deviations, ...s.deviations])] };
    } else merged.push(s);
  }
  const shown = merged.filter((s) => showAll || s.canceled || (s.added !== null && Math.abs(s.added) >= 1) || (s.deviations.length && s.added !== 0));
  const hiddenCount = merged.length - shown.length;
  const rows = shown.map((s) => el("tr", { class: s.canceled ? "canceled" : "" },
    el("td", {}, el("span", { class: "swatch", style: `background:${segmentColor(s)}` }), document.createTextNode(name(s))),
    el("td", {}, document.createTextNode(s.kind === "stop" ? "–" : segTrackLabel(s)),
      s.kind === "run" && s.line ? el("span", { class: "line-name", text: ` (${s.line})` }) : null),
    el("td", { class: "num", text: s.canceled ? "–" : `${fmtDelay(s.delay_from)} → ${fmtDelay(s.delay_to)}` }),
    el("td", { class: "num strong", text: s.canceled ? "Inställd" : s.added === null ? "–" : `${s.added > 0 ? "+" : s.added < 0 ? "−" : ""}${Math.abs(s.added)} min` }),
    el("td", { class: "dev", text: s.deviations.join(", ") })));
  const parts = [];
  if (rows.length) {
    parts.push(el("div", { class: "table-wrap" }, el("table", { class: "delay-table" },
      el("thead", {}, el("tr", {}, ...["Sträcka", "Spår", "Försening före → efter", "Tillkommet", "Orsak enligt Trafikverket"]
        .map((h, i) => el("th", { class: i === 2 || i === 3 ? "num" : "", text: h })))),
      el("tbody", {}, ...rows))));
  } else {
    parts.push(el("p", { class: "sub", text: "Inga delsträckor med ändrad försening." }));
  }
  const note = el("p", { class: "sub details-note" });
  note.append(document.createTextNode(
    "Tillkommet = hur mycket förseningen ökade på sträckan eller under uppehållet (negativt = tåget tog igen tid). " +
    "Delsträckorna går mellan alla platser där Trafikverket rapporterar tåget, även sådana utan resandeutbyte. "));
  if (hiddenCount || showAll) {
    note.append(el("button", { type: "button", class: "link-btn", text: showAll ? "Visa bara ändringar" : `Visa alla ${merged.length} delsträckor`,
      onclick: () => { body.dataset.all = showAll ? "" : "1"; renderDelayDetails(j); } }));
  }
  parts.push(note);
  body.replaceChildren(...parts);
}

function showOnLine(date) {
  pickLineDate(date);
  $("now").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSync(d) {
  const text = $("sync-text");
  if (d.last_poll_ok) {
    const t = new Date(d.last_poll_ok).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    text.textContent = `Senast hämtat ${t}`;
  } else {
    text.textContent = "Ingen hämtning har lyckats ännu";
  }
  text.classList.toggle("err", Boolean(d.fetch_error));
  if (d.fetch_error) text.textContent += " – senaste försöket misslyckades";
  $("foot").textContent = `Tågkoll ${d.version === "dev" ? "(utvecklingsversion)" : "v" + d.version}. Trafikverket tillfrågas var ${Math.round(d.poll_seconds / 60)}:e minut. Ett tåg räknas som försenat när det ankommer slutstationen mer än ${d.threshold} minuter efter tidtabell.`;
}

// ------------------------------------------------------------------- vyerna
function renderTrainSwitch() {
  $("trains").replaceChildren(...state.trains.map((t) => {
    const on = t.ident === state.train;
    return el("button", { type: "button", "aria-pressed": String(on), onclick: () => { if (!on) location.hash = t.ident; } },
      el("b", { text: t.ident }), t.destination ? document.createTextNode(` → ${t.destination}`) : null);
  }));
}

function render() {
  const d = state.data;
  const t = d.train;
  const product = [t.product, t.operator && t.operator !== t.product ? t.operator : null].filter(Boolean).join(", ");
  $("about").textContent = [`Tåg ${t.ident}${t.origin ? ` ${t.origin} → ${t.destination}` : ""}${product ? ` (${product})` : ""}.`, ageText(t)]
    .filter(Boolean).join(" ");
  document.title = `Tåg ${t.ident} – Tågkoll`;
  renderSync(d);
  renderPeriods();
  renderTrainSwitch();
  renderNow();
  renderLine();
  renderHistory(d);
  renderSections(d);
}

function showView(view) {
  if (state.view !== view) { stopPlay(); hideTip(); }
  state.view = view;
  $("board").hidden = view !== "board";
  $("content").hidden = view !== "train";
  if (view === "board") document.title = "Tågkoll";
}

/** Adressen styr vyn: tom = alla tåg, #620 = tåg 620, #620/2026-11-24 = en viss avgång. */
function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  const day = h.match(/^dag\/(\d{4}-\d{2}-\d{2})$/);
  if (day) return { view: "board", date: day[1] };
  if (h in OLD_TABS) {
    const ident = state.trains.some((t) => t.ident === state.train) ? state.train : state.trains[0]?.ident;
    return ident ? { view: "train", ident, open: OLD_TABS[h], legacy: true } : { view: "board" };
  }
  const m = h.match(/^([0-9A-Za-z]{1,10})(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (m && state.trains.some((t) => t.ident === m[1])) return { view: "train", ident: m[1], date: m[2] ?? null };
  return { view: "board" };
}

async function route() {
  if (!state.trains.length) {
    showView("none");
    showMessage("Inga tåg bevakas. Lägg till tåg på adminsidan /admin för att börja samla data.", true);
    return;
  }
  const r = parseHash();
  if (r.view === "board") {
    const from = state.view;
    state.boardDate = r.date && r.date !== todayIso() ? r.date : null;
    showView("board");
    renderBoard();
    if (from === "train") window.scrollTo(0, 0);
    await loadBoard();
    return;
  }
  if (r.legacy) history.replaceState(null, "", `#${r.ident}`);
  if (r.open) $(r.open).open = true;
  const fresh = r.ident !== state.train || state.view !== "train";
  if (r.ident !== state.train) {
    state.data = null;
    state.lineExtra = null;
    state.replayable = [];
    $("line-date").dataset.key = "";
  }
  state.train = r.ident;
  state.lineDate = r.date;
  store.set("train", r.ident);
  showView("train");
  renderTrainSwitch();
  if (fresh) window.scrollTo(0, 0);
  await loadStats();
  if (r.date && !state.data.journeys.some((j) => j.date === r.date && j.points.length > 1)) await pickLineDate(r.date);
}

// ------------------------------------------------------------------ actions
const statsQuery = (ident) => {
  const q = new URLSearchParams({ train: ident });
  if (state.days) q.set("days", state.days);
  return q;
};

async function loadBoard() {
  $("board").classList.add("loading");
  try {
    const [results, playable] = await Promise.all([
      Promise.all(state.trains.map((t) => api(`/api/stats?${statsQuery(t.ident)}`).catch((e) => { showMessage(e.message); return null; }))),
      Promise.all(state.trains.map((t) => api(`/api/journeys?${new URLSearchParams({ train: t.ident })}`).catch(() => null))),
    ]);
    state.trains.forEach((t, i) => {
      if (results[i]) state.board[t.ident] = results[i];
      if (playable[i]) state.boardPlayable[t.ident] = playable[i];
    });
    if (results.every(Boolean)) showMessage("");
    if (state.view === "board") renderBoard();
  } finally {
    $("board").classList.remove("loading");
  }
}

async function loadStats() {
  const train = state.train;
  $("content").classList.add("loading");
  try {
    const [data, replayable] = await Promise.all([
      api(`/api/stats?${statsQuery(train)}`),
      api(`/api/journeys?${new URLSearchParams({ train })}`).catch(() => state.replayable),
    ]);
    if (state.train !== train) return;
    state.data = data;
    state.board[train] = data;
    state.replayable = replayable;
    if (state.view === "train") render();
  } finally {
    $("content").classList.remove("loading");
  }
}

async function loadTrains() {
  state.trains = await api("/api/trains");
}

for (const group of document.querySelectorAll(".periods")) {
  group.addEventListener("click", (e) => {
    const b = e.target.closest("[data-days]");
    if (!b) return;
    state.days = b.dataset.days;
    store.set("days", state.days);
    renderPeriods();
    (state.view === "board" ? loadBoard() : loadStats()).catch((err) => showMessage(err.message));
  });
}

window.addEventListener("hashchange", () => route().catch((e) => showMessage(e.message)));

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === "board") renderBoard();
    else if (state.data) {
      renderLine();
      if (state.data.summary.journeys) renderDaily(state.data.journeys, state.data.threshold);
      renderSectionCharts();
    }
    if (costModel && $("cost-info").open) curveChart(document.querySelector(".info-curve"), costModel.explain);
  }, 120);
}).observe(document.querySelector("main"));

async function loadVisitors() {
  try {
    const { today } = await api("/api/visitors");
    $("visitors-text").textContent = `${nf(today)} besökare i dag`;
    $("visitors").hidden = false;
  } catch { /* räknaren är inte viktig nog att visa fel för */ }
}

(async function start() {
  loadVisitors();
  try {
    await loadTrains();
    await route();
  } catch (e) { showMessage(e.message); }
  setInterval(() => {
    if (document.hidden) return;
    (state.view === "board" ? loadBoard() : state.view === "train" ? loadStats() : Promise.resolve()).catch(() => {});
    loadVisitors();
  }, 60000);
})();
