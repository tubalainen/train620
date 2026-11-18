"use strict";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const nf = (n, digits = 0) =>
  n.toLocaleString("sv-SE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const STATUS = {
  ontime: { label: "I tid", color: "var(--good)", icon: "✓" },
  delayed: { label: "Försenat", color: "var(--warning)", icon: "!", darkInk: true },
  partial: { label: "Delvis inställt", color: "var(--serious)", icon: "–", darkInk: true },
  cancelled: { label: "Inställt", color: "var(--critical)", icon: "✕" },
  pending: { label: "Planerat", color: "var(--neutral)", icon: "…", darkInk: true },
  unknown: { label: "Uppgift saknas", color: "var(--neutral)", icon: "?", darkInk: true },
};
const FINISHED = ["ontime", "delayed", "partial", "cancelled"];

const state = {
  trains: [],
  train: localStorage.getItem("train"),
  days: localStorage.getItem("days") ?? "30",
  data: null,
  lineDate: null,
  lineExtra: null,   // en äldre avgång som hämtats separat för uppspelning
  replayable: [],    // alla avgångar med hållplatsdata, nyast först
  tab: storedTab(),
  filter: "all",     // Avgångar-fliken: alla eller bara störningar
  sort: "date",      // Avgångar-fliken: date, delay eller cost
};

function storedTab() {
  const fromHash = location.hash.replace("#", "");
  if (["overview", "punct", "cost", "table"].includes(fromHash)) return fromHash;
  try { return localStorage.getItem("tab") || "overview"; } catch { return "overview"; }
}

// ------------------------------------------------------------------ helpers
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}
function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}
const fmtDate = (iso, opts = { day: "numeric", month: "short" }) =>
  new Date(iso + "T12:00:00").toLocaleDateString("sv-SE", opts);
const fmtLongDate = (iso) => fmtDate(iso, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "–");
function fmtDelay(min) {
  if (min === null || min === undefined) return "–";
  if (min === 0) return "0 min";
  return `${min > 0 ? "+" : "−"}${nf(Math.abs(min))} min`;
}

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

/** Stapeldiagram. items: {label, value|null, color, tip, capLabel} – value null ritas som en markör på baslinjen. */
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
    const g = svg("g", { class: "band" }, root);
    const cx = inner.x + band * i + band / 2;
    svg("rect", { class: "hit", x: cx - band / 2, y: inner.y, width: band, height: inner.h }, g);
    if (item.value === null) {
      const s = 4, by = y(0) - 8;
      svg("path", { class: "mark", d: `M${cx - s},${by - s} L${cx + s},${by + s} M${cx + s},${by - s} L${cx - s},${by + s}`, stroke: item.color, "stroke-width": 2.5, "stroke-linecap": "round" }, g);
    } else if (item.value === 0) {
      svg("rect", { class: "mark", x: cx - barW / 2, y: y(0) - 2, width: barW, height: 2, fill: item.color }, g);
    } else {
      svg("path", { class: "mark", d: barPath(cx - barW / 2, barW, y(0), y(item.value)), fill: item.color }, g);
    }
    if (labelCaps && item.value !== null) {
      const t = svg("text", { class: "val", x: cx, y: y(Math.max(0, item.value)) - 6, "text-anchor": "middle" }, g);
      t.textContent = item.capLabel;
    }
    if (i % every === 0) {
      const t = svg("text", { x: cx, y: inner.y + inner.h + 18, "text-anchor": "middle" }, root);
      t.textContent = item.label;
    }
    g.addEventListener("pointermove", (e) => { g.classList.add("hover"); showTip(e, item.tip); });
    g.addEventListener("pointerleave", () => { g.classList.remove("hover"); hideTip(); });
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

function placeholder(container, text) {
  container.replaceChildren(el("p", { class: "sub", text }));
}

// ------------------------------------------------------------------ renders
function statusBadge(key, labelOverride) {
  const s = STATUS[key];
  return el("span", { class: "status" },
    el("i", { class: s.darkInk ? "dark-ink" : "", style: `background:${s.color}`, "aria-hidden": "true", text: s.icon }),
    el("span", { text: labelOverride ?? s.label }));
}

function renderTrains() {
  $("trains").replaceChildren(...state.trains.map((t) => {
    const active = t.ident === state.train;
    return el("button", { type: "button", class: "train" + (active ? " active" : ""), "aria-pressed": String(active),
      onclick: () => selectTrain(t.ident) },
      el("span", { class: "train-id", text: t.ident }),
      el("span", { class: "train-route", text: t.origin ? `${t.origin} → ${t.destination}` : "Inga uppgifter ännu" }));
  }));
  for (const b of $("periods").children) b.setAttribute("aria-pressed", String(b.dataset.days === state.days));
}

// ------------------------------------------------------------------ nu-kortet
/** Avgången som Nu-kortet visar: vald avgång på linjen, annars den senaste. */
function nowJourney() {
  const d = state.data;
  if (!d) return null;
  return lineJourney(d.journeys) ?? d.journeys[0] ?? null;
}

/** Statusrubriken: färgnyckel och kort text. */
function statusHeadline(j) {
  if (j.status === "ontime") return { key: "ontime", text: "I tid" };
  if (j.status === "delayed") return { key: "delayed", text: `Försenat ${j.delay} min` };
  if (j.status === "cancelled") return { key: "cancelled", text: "Inställt" };
  if (j.status === "partial") return { key: "partial", text: "Delvis inställt" };
  if (j.status === "unknown") return { key: "unknown", text: "Uppgift saknas" };
  if (j.current_delay !== null && j.current_delay !== undefined) {
    return j.current_delay > state.data.threshold
      ? { key: "delayed", text: `På väg, ${j.current_delay} min sent` }
      : { key: "ontime", text: "På väg, i tid" };
  }
  if (j.forecast_delay > 0) return { key: "delayed", text: `Väntas bli ${j.forecast_delay} min sent` };
  return { key: "pending", text: "Planerat" };
}

function costFact(j) {
  if (!FINISHED.includes(j.status)) return ["Samhällskostnad", "–", "räknas när tåget är framme"];
  const jc = journeyCost(j);
  if (!jc) return ["Samhällskostnad", "–", state.data?.cost ? "utanför vald period" : "räknas bara för tåg till eller från Stockholm"];
  const note = jc.total === 0 ? "ingen kostnad"
    : jc.flag === "advance" ? "inställt, känt i förväg"
    : jc.flag === "capped" ? "sent redan vid avgång, räknas som inställt"
    : j.status === "cancelled" || j.status === "partial" ? "akut inställt" : "försening under resan";
  return ["Samhällskostnad", jc.total === 0 ? "0 kr" : `≈ ${fmtKr(jc.total)}`, note];
}

function worstSegment(j) {
  return (j.segments ?? []).filter((s) => s.added >= 2).sort((a, b) => b.added - a.added)[0] ?? null;
}

/** De fyra uppgifterna i Nu-kortet: [rubrik, värde, förklaring]. */
function nowFacts(j) {
  const origin = j.origin ?? "", dest = j.destination ?? "";
  if (!j.stops.length) {
    return [["Försening", fmtDelay(j.delay), `importerad uppgift (${j.source})`], costFact(j)];
  }
  if (j.status === "pending") {
    if (j.current_delay !== null && j.current_delay !== undefined) {
      return [
        ["Avgick", hhmm(j.actual_departure), departureText(j.departure_delay) || origin],
        ["Senast rapporterat", j.last_station ?? "–", j.current_delay > 0 ? `${j.current_delay} min sent` : "i tid"],
        ["Beräknad ankomst", hhmm(j.estimated_arrival || j.planned_arrival), `planerat ${hhmm(j.planned_arrival)}`],
        costFact(j)];
    }
    return [
      ["Planerad avgång", hhmm(j.planned_departure), origin],
      ["Planerad ankomst", hhmm(j.planned_arrival), dest],
      j.forecast_delay > 0
        ? ["Väntad avgång", hhmm(j.estimated_departure), `${fmtDelay(j.forecast_delay)} enligt Trafikverket`]
        : ["Prognos", "Enligt tidtabell", "enligt Trafikverket"],
      costFact(j)];
  }
  if (j.status === "cancelled") {
    return [
      ["Planerad avgång", hhmm(j.planned_departure), origin],
      ["Planerad ankomst", hhmm(j.planned_arrival), dest],
      ["Försening", "–", "hela avgången inställd"],
      costFact(j)];
  }
  if (j.status === "partial") {
    const last = [...j.stops].reverse().find((s) => !s.canceled && s.actual);
    return [
      ["Avgick", hhmm(j.actual_departure), departureText(j.departure_delay) || origin],
      ["Kom till", last ? last.station : "–", last ? `${hhmm(last.actual)}, resten inställd` : "resten inställd"],
      ["Försening", "–", "kom inte fram"],
      costFact(j)];
  }
  const w = worstSegment(j);
  return [
    ["Avgick", hhmm(j.actual_departure), departureText(j.departure_delay) || origin],
    ["Ankom", hhmm(j.actual_arrival), `planerat ${hhmm(j.planned_arrival)}`],
    ["Försening", fmtDelay(j.delay), j.delay > 0 && w
      ? (w.kind === "stop" ? `mest vid uppehållet i ${w.from}` : `mest ${w.from}–${w.to}`)
      : j.delay > 0 ? "" : "enligt tidtabell"],
    costFact(j)];
}

function renderNow() {
  const j = nowJourney();
  $("now").hidden = !j;
  if (!j) return;
  const isToday = j.date === new Date().toLocaleDateString("sv-SE");
  const long = fmtDate(j.date, { weekday: "long", day: "numeric", month: "long" });
  $("now-label").textContent = `${isToday ? `I dag · ${long}` : long.charAt(0).toUpperCase() + long.slice(1)} · tåg ${state.train}`;
  const h = statusHeadline(j);
  $("now-status").replaceChildren(el("span", { class: "dot", style: `background:${STATUS[h.key].color}`, "aria-hidden": "true" }),
    document.createTextNode(h.text));
  const repeats = /^inställt( tåg)?$/i;
  $("now-reason").textContent = j.deviations.filter((d) => !(repeats.test(d) && (j.status === "cancelled" || j.status === "partial"))).slice(0, 2).join(", ");
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

/** "i tid", "3 min sent" eller "2 min tidigt" för en avgång. */
function departureText(delay) {
  if (delay === null || delay === undefined) return "";
  return delay > 0 ? `${delay} min sent` : delay < 0 ? `${-delay} min tidigt` : "i tid";
}

function forecastText(j) {
  return `Väntas avgå ${hhmm(j.estimated_departure)} i stället för ${hhmm(j.planned_departure)} (${fmtDelay(j.forecast_delay)})` +
    (j.estimated_arrival ? `, beräknad ankomst ${hhmm(j.estimated_arrival)}.` : ".");
}

/** Kommande avgångar: inställningar och prognoser som Trafikverket redan känner till. */
function upcomingKind(j) {
  return j.status === "cancelled" ? "cancelled" : j.status === "partial" ? "partial" : j.forecast_delay > 0 ? "delayed" : null;
}

/** Kommande dagar: en rad med dagar, text bara för dagar med kända störningar. */
function renderUpcoming(upcoming) {
  const days = upcoming.slice(0, 7);
  $("upcoming").hidden = !days.length;
  if (!days.length) return;
  const what = (j) => j.status === "cancelled" ? "inställt" : j.status === "partial" ? "delvis inställt"
    : `väntas bli ${j.forecast_delay} min sent (avgång ${hhmm(j.estimated_departure)})`;
  $("upcoming-days").replaceChildren(...days.map((j) => {
    const k = upcomingKind(j);
    const label = `${fmtDate(j.date, { weekday: "long", day: "numeric", month: "long" })}: ${k ? what(j) : "inga kända störningar"}`;
    return el("li", { class: "uday" + (k ? " issue" : ""), title: label },
      el("span", { class: "uday-name", text: fmtDate(j.date, { weekday: "short" }) }),
      el("span", { class: "uday-num", text: fmtDate(j.date, { day: "numeric" }) }),
      el("span", { class: "dot" + (k ? "" : " hollow"), style: k ? `background:${STATUS[k].color}` : null, role: "img", "aria-label": label }));
  }));
  const notable = upcoming.filter(upcomingKind);
  const last = upcoming[upcoming.length - 1].date;
  $("upcoming-notes").replaceChildren(...(notable.length
    ? notable.map((j) => el("li", {},
        el("strong", { text: `${fmtDate(j.date, { weekday: "long", day: "numeric", month: "long" })}: ` }),
        document.createTextNode(what(j) + (j.deviations.length ? ` – ${j.deviations.slice(0, 2).join(", ")}` : "") + ".")))
    : [el("li", { class: "quiet", text: `Inga kända inställningar eller förseningar t.o.m. ${fmtDate(last, { weekday: "short", day: "numeric", month: "long" })}.` })]));
}

function renderKpis(s, threshold, cost) {
  $("kpi-punct").textContent = s.punctuality === null ? "–" : `${nf(s.punctuality, s.punctuality % 1 ? 1 : 0)} %`;
  $("kpi-punct-note").textContent = s.journeys ? `${nf(s.ontime)} av ${nf(s.journeys)} i tid (högst ${threshold} min sent)` : "";
  $("kpi-cancelled").textContent = nf(s.cancelled + s.partial);
  $("kpi-cancelled-note").textContent = s.partial ? `varav ${nf(s.partial)} delvis`
    : s.journeys ? `${nf((100 * s.cancelled) / s.journeys, 1)} % av avgångarna` : "";
  $("kpi-avg").textContent = s.avg_delay === null ? "–" : `${nf(s.avg_delay, 1)} min`;
  $("kpi-avg-note").textContent = s.max_delay === null ? "" : `störst ${fmtDelay(s.max_delay)} (${fmtDate(s.max_delay_date)})`;
  const has = cost && cost.journeys;
  $("kpi-cost").textContent = has ? fmtKr(cost.total) : "–";
  $("kpi-cost-note").textContent = has ? `spann ${fmtKr(cost.low)} – ${fmtKr(cost.high)}` : "räknas bara för tåg till eller från Stockholm";
  $("kpi-cost-tile").disabled = !has;
}

function overviewSummary(d) {
  const s = d.summary, t = d.train, c = d.cost;
  const span = d.days ? `De senaste ${d.days} dagarna` : t.first_date ? `Sedan ${longDate(t.first_date)}` : "Hittills";
  const parts = [`${span} kom tåg ${t.ident} fram i tid ${nf(s.ontime)} gånger av ${nf(s.journeys)}.`];
  if (s.cancelled + s.partial) parts.push(`${nf(s.cancelled + s.partial)} avgångar ställdes helt eller delvis in.`);
  if (c && c.journeys && c.total) {
    const top = KIND_ORDER.reduce((a, b) => (c.kinds[b] > c.kinds[a] ? b : a));
    parts.push(`Förseningarna och inställningarna har kostat samhället omkring ${fmtKr(c.total)}, mest genom ${c.kind_labels[top].toLowerCase()}.`);
  }
  return parts.join(" ");
}

function renderSplit(s) {
  const box = $("split");
  const parts = FINISHED.map((k) => ({ key: k, n: s[k] })).filter((p) => p.n > 0);
  $("split-sub").textContent = `${nf(s.journeys)} avslutade avgångar i perioden`;
  const bar = el("div", { class: "split-bar", role: "img", "aria-label": parts.map((p) => `${STATUS[p.key].label}: ${p.n}`).join(", ") });
  const legend = el("div", { class: "legend split-legend" });
  for (const p of parts) {
    const share = (100 * p.n) / s.journeys;
    const seg = el("div", { class: STATUS[p.key].darkInk ? "dark-ink" : "", style: `flex:${p.n} 1 0;background:${STATUS[p.key].color}`, text: `${nf(share)} %` });
    const tipData = { color: STATUS[p.key].color, value: `${nf(p.n)} avgångar`, label: STATUS[p.key].label, extra: `${nf(share, 1)} % av perioden` };
    seg.addEventListener("pointermove", (e) => showTip(e, tipData));
    seg.addEventListener("pointerleave", hideTip);
    bar.append(seg);
    legend.append(el("span", {}, el("span", { class: "swatch", style: `background:${STATUS[p.key].color}` }),
      document.createTextNode(STATUS[p.key].label + " "), el("b", { text: nf(p.n) })));
  }
  box.replaceChildren(bar, legend);
  for (const seg of bar.children) if (seg.scrollWidth > seg.clientWidth) seg.textContent = "";
}

function renderDaily(journeys, threshold) {
  const MAX = 90;
  const finished = journeys.filter((j) => FINISHED.includes(j.status)).reverse();
  const shown = finished.slice(-MAX);
  $("daily-sub").textContent = "Minuter efter tidtabell vid slutstationen. Negativt värde = före tidtabell." +
    (finished.length > MAX ? ` Visar de ${MAX} senaste avgångarna.` : "");
  const used = FINISHED.filter((k) => shown.some((j) => j.status === k));
  $("daily-legend").replaceChildren(...used.map((k) => el("span", {},
    el("span", { class: "swatch", style: `background:${STATUS[k].color}` }),
    document.createTextNode(STATUS[k].label + (k === "cancelled" ? " (✕)" : "")))),
    el("span", {}, el("span", { class: "dash-key" }), document.createTextNode(`Gräns för försenat: ${threshold} min`)));
  columnChart($("daily"), {
    items: shown.map((j) => ({
      label: fmtDate(j.date),
      value: j.delay,
      color: STATUS[j.status].color,
      tip: { color: STATUS[j.status].color, value: j.delay === null ? STATUS[j.status].label : fmtDelay(j.delay), label: fmtLongDate(j.date),
             extra: j.delay === null ? "" : STATUS[j.status].label + (j.actual_arrival ? `, ankom ${hhmm(j.actual_arrival)}` : "") },
    })),
    yFormat: (v) => nf(v),
    max: Math.max(threshold * 2, ...shown.map((j) => j.delay ?? 0)),
    threshold: { value: threshold },
  });
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
  const show = j.points.length > 1
    ? el("button", { type: "button", class: "show-line", text: "Visa överst ↑", onclick: (e) => { e.stopPropagation(); showOnLine(j.date); } })
    : null;
  return el("tr", { class: "stops" }, el("td", { colspan: 6 }, show, table));
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
  if (state.tab === "cost") renderCostChart();

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
const ms = (iso) => (iso ? Date.parse(iso) : null);
const TRACKS = { 1: "Enkelspår", 2: "Dubbelspår" };
const segTrackLabel = (s) => (s.split
  ? `${trackLabel(s.split.before)} till ${s.split.at}, sedan ${trackLabel(s.split.after).toLowerCase()}`
  : trackLabel(s.tracks));
const trackLabel = (n) => (n === "mixed" ? "Enkel- och dubbelspår" : TRACKS[n] ?? "Okänt antal spår");

function segmentColor(s) {
  if (s.canceled) return "var(--critical)";
  if (s.added === null) return "var(--neutral)";
  if (s.added >= 5) return "var(--serious)";
  if (s.added >= 2) return "var(--warning)";
  return "var(--rail)";
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
      seq.push({ t, i, delay: Math.round((t - plan) / 60000), known: planned || p[`actual_${key}`] !== null });
    }
  }
  if (!planned && !seq.length) stoppedAt = 0;
  return { seq, stoppedAt };
}

/** Läge (x) och försening vid tiden t. */
function positionAt(tl, t, xOf) {
  const { seq } = tl;
  if (!seq.length) return { x: xOf(0), delay: 0, index: 0 };
  if (t <= seq[0].t) return { x: xOf(seq[0].i), delay: seq[0].delay, index: seq[0].i };
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1], b = seq[k];
    if (t < b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      // Mellan två olika punkter rullar tåget; mellan ankomst och avgång på samma station står det still.
      return { x: xOf(a.i) + (xOf(b.i) - xOf(a.i)) * f, delay: a.delay, index: f < 0.5 ? a.i : b.i, moving: a.i !== b.i };
    }
  }
  const z = seq[seq.length - 1];
  return { x: xOf(z.i), delay: z.delay, index: z.i };
}

/** Lokets färg efter förseningen: grönt i tid, orange runt 5 min, rött från 20 min. */
function locoColor(delay) {
  const d = Math.max(0, delay ?? 0);
  if (d <= 1) return "var(--good)";
  if (d < 6) return `color-mix(in oklab, var(--late) ${Math.round(((d - 1) / 5) * 100)}%, var(--good))`;
  if (d < 20) return `color-mix(in oklab, var(--critical) ${Math.round(((d - 6) / 14) * 100)}%, var(--late))`;
  return "var(--critical)";
}

/** Ett ånglok i SVG med fronten i (0,0) på rälsen och färdriktning åt höger. */
function locomotive(parent, cls) {
  const g = svg("g", { class: `loco ${cls}` }, parent);
  const steam = svg("g", { class: "steam" }, g);
  for (let i = 0; i < 4; i++) svg("circle", { class: "puff", cx: -10, cy: -33, r: 4 }, steam);
  const body = svg("g", { class: "body" }, g);
  svg("rect", { x: -48, y: -31, width: 17, height: 3, rx: 1 }, body);               // tak
  svg("rect", { x: -46, y: -29, width: 13, height: 21, rx: 1.5 }, body);            // hytt
  svg("rect", { class: "window", x: -43, y: -25, width: 7, height: 6, rx: 1 }, body);
  svg("rect", { x: -34, y: -21, width: 28, height: 13, rx: 4 }, body);              // panna
  svg("rect", { x: -14, y: -29, width: 6, height: 9 }, body);                       // skorsten
  svg("rect", { x: -16, y: -32, width: 10, height: 3, rx: 1 }, body);
  svg("path", { d: "M-25,-21 a3.5,3.5 0 0 1 7,0 Z" }, body);                        // dom
  svg("rect", { x: -47, y: -10, width: 43, height: 3 }, body);                      // ram
  svg("path", { d: "M-6,-9 L0,-1 L-6,-1 Z" }, body);                                // plog
  svg("circle", { class: "lamp", cx: -6, cy: -17, r: 2 }, g);
  for (const [cx, r] of [[-39, 5.5], [-25, 4], [-14, 4]]) svg("circle", { class: "wheel", cx, cy: -r - 0.5, r }, g);
  return g;
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

function replayLabel(r) {
  if (r.status === "pending") return `${fmtLongDate(r.date)} · ${r.current_delay !== null && r.current_delay !== undefined ? "på väg" : "planerat"}`;
  const outcome = (r.status === "ontime" || r.status === "delayed") && r.delay !== null
    ? (r.delay > 0 ? fmtDelay(r.delay) : "i tid") : STATUS[r.status].label.toLowerCase();
  return `${fmtLongDate(r.date)} · ${outcome}`;
}

/** Väljaren med alla avgångar som går att spela upp (bara dagar med egna hållplatsdata). */
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
  const inStats = state.data?.journeys.some((j) => j.date === date && j.points.length > 1);
  if (!inStats && state.lineExtra?.date !== date) {
    try {
      state.lineExtra = await api(`/api/journey?${new URLSearchParams({ train, date })}`);
    } catch (e) {
      if (state.train === train) showMessage(e.message);
    }
  }
  if (state.train === train && state.lineDate === date && !linePlay) { renderNow(); renderLine(); }
}

$("line-date").addEventListener("change", (e) => pickLineDate(e.target.value));

function renderLine() {
  const card = $("line-card");
  const j = state.data ? lineJourney(state.data.journeys) : null;
  // Perioden kan sakna avgångar med hållplatsdata fast äldre finns – visa då den senaste av dem.
  if (!j && !state.lineDate && state.replayable.length) { pickLineDate(state.replayable[0].date); return; }
  card.hidden = !j;
  if (!j || linePlay) return;
  renderLinePicker(j.date);
  const box = $("line");
  box.replaceChildren();
  const points = j.points;
  const width = Math.max(300, box.clientWidth);
  const narrow = width < 560;
  const height = narrow ? 158 : 178;
  const scale = narrow ? 0.95 : 1.25;
  const m = { l: Math.round(48 * scale) + 6, r: narrow ? 14 : 22 };
  const railY = narrow ? 92 : 108;
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img", class: "line-svg" }, box);
  const tp = (p) => ms(p.planned_arr ?? p.planned_dep);
  const t0 = tp(points[0]), span = (tp(points[points.length - 1]) - t0) || 1;
  const xOf = (i) => m.l + ((tp(points[i]) - t0) / span) * (width - m.l - m.r);
  const idx = new Map(points.map((p, i) => [p, i]));

  // Spåret: sliprar, räls per delsträcka och osynliga träffytor för tooltip.
  svg("line", { x1: xOf(0), x2: xOf(points.length - 1), y1: railY, y2: railY, class: "sleepers" }, root);
  const runs = j.segments.filter((s) => s.kind === "run");
  runs.forEach((s, k) => {
    const x1 = xOf(k), x2 = xOf(k + 1);
    const color = segmentColor(s);
    const g = svg("g", { class: "seg" }, root);
    // En sträcka som går förbi en knutpunkt utan rapport (t.ex. Laxå) ritas i två delar.
    const xm = s.split ? x1 + (x2 - x1) * s.split.fraction : x2;
    const parts = s.split ? [[x1, xm, s.split.before], [xm, x2, s.split.after]] : [[x1, x2, s.tracks]];
    for (const [a, b, n] of parts) {
      for (const dy of n === 2 ? [-3.5, 3.5] : [0]) {
        svg("line", { x1: a, x2: b, y1: railY + dy, y2: railY + dy, stroke: color, "stroke-width": n === 2 ? 2.5 : 3.5,
          "stroke-dasharray": n ? null : "5 4", "stroke-linecap": "butt" }, g);
      }
    }
    if (s.split) {
      svg("line", { x1: xm, x2: xm, y1: railY - 7, y2: railY + 7, class: "junction" }, g);
      // Knutpunkten får alltid sitt namn, oavsett hur kort sträckan är och åt vilket håll tåget går.
      const t = svg("text", { x: xm, y: railY - 12, "text-anchor": "middle", class: "junction-label" }, g);
      t.textContent = s.split.at;
    }
    if (s.canceled) svg("line", { x1, x2, y1: railY, y2: railY, class: "strike" }, g);
    svg("rect", { class: "hit", x: x1, y: railY - 16, width: Math.max(2, x2 - x1), height: 32 }, g);
    const tipData = {
      color, label: `${s.from} → ${s.to}`,
      value: s.canceled ? "Inställd sträcka" : s.added === null ? "Ej körd ännu" : `${s.added > 0 ? "+" : ""}${s.added} min på sträckan`,
      extra: [segTrackLabel(s), s.line, ...s.deviations].filter(Boolean).join(" · "),
    };
    g.addEventListener("pointermove", (e) => { g.classList.add("hover"); showTip(e, tipData); });
    g.addEventListener("pointerleave", () => { g.classList.remove("hover"); hideTip(); });
  });

  // Stationer: prickar, uppehåll med tillkommen försening får färgad ring, namn glesas ut.
  const stopAdded = new Map(j.segments.filter((s) => s.kind === "stop").map((s) => [s.from_sig, s]));
  const labelY = [railY + 26, railY + 42];
  const placed = [[], []];
  const fits = (row, a, b) => placed[row].every(([c, d]) => b + 8 < c || a > d + 8);
  const labelBox = (i, name) => {
    const x = xOf(i), w = name.length * 6.4;
    const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
    const left = anchor === "start" ? x - 6 : anchor === "end" ? x - w + 6 : x - w / 2;
    return { anchor, left, right: left + w, tx: anchor === "start" ? x - 6 : anchor === "end" ? x + 6 : x };
  };
  // Start- och slutstation får alltid namn, övriga stationer där det finns plats.
  const labelRow = new Map();
  for (const i of [0, points.length - 1]) {
    const b = labelBox(i, points[i].station);
    const row = fits(0, b.left, b.right) ? 0 : 1;
    placed[row].push([b.left, b.right]);
    labelRow.set(i, row);
  }
  points.forEach((p, i) => {
    if (labelRow.has(i) || !p.advertised) return;
    const b = labelBox(i, p.station);
    const row = [0, 1].find((r) => fits(r, b.left, b.right));
    if (row !== undefined) { placed[row].push([b.left, b.right]); labelRow.set(i, row); }
  });
  points.forEach((p, i) => {
    if (!p.advertised && i !== 0 && i !== points.length - 1) return;
    const x = xOf(i), end = i === 0 || i === points.length - 1;
    const dwell = stopAdded.get(p.sig);
    const g = svg("g", { class: "station" }, root);
    svg("circle", { cx: x, cy: railY, r: end ? 7 : 5.5, class: "dot" + (p.canceled ? " canceled" : ""),
      stroke: dwell && dwell.added >= 2 ? segmentColor(dwell) : null }, g);
    if (labelRow.has(i)) {
      const b = labelBox(i, p.station);
      const t = svg("text", { x: b.tx, y: labelY[labelRow.get(i)], "text-anchor": b.anchor, class: end ? "end-label" : "" }, g);
      t.textContent = p.station;
    }
    svg("rect", { class: "hit", x: x - 9, y: railY - 12, width: 18, height: 24 }, g);
    const plan = p.planned_dep ?? p.planned_arr, actual = p.actual_dep ?? p.actual_arr;
    const delay = p.delay_dep ?? p.delay_arr;
    const tipData = { color: "var(--ink-2)", label: p.station,
      value: p.canceled ? "Inställt" : actual ? `${hhmm(actual)} (${fmtDelay(delay)})` : `Planerat ${hhmm(plan)}`,
      extra: [`Tidtabell ${hhmm(plan)}`, dwell ? `uppehållet ${dwell.added > 0 ? "+" : ""}${dwell.added} min` : null,
              p.track ? `spår ${p.track}` : null, ...p.deviations].filter(Boolean).join(" · ") };
    g.addEventListener("pointermove", (e) => showTip(e, tipData));
    g.addEventListener("pointerleave", hideTip);
  });

  // Loken: spöktåget efter tidtabell och ångloket efter verkliga tider.
  const real = timeline(points, false), plan = timeline(points, true);
  const ghost = locomotive(root, "ghost");
  const loco = locomotive(root, "real");
  const gap = svg("g", { class: "gap" }, root);
  const gapLine = svg("path", {}, gap);
  const gapText = svg("text", { "text-anchor": "middle" }, gap);
  const ghostTag = svg("text", { class: "ghost-tag", "text-anchor": "end" }, root);
  ghostTag.textContent = "Enligt tidtabell";
  const sign = svg("g", { class: "cancel-sign" }, root);
  const signRect = svg("rect", { rx: 4, height: 20 }, sign);
  const signText = svg("text", { "text-anchor": "middle" }, sign);
  const tagY = railY - 56 * scale;

  const fullyCanceled = j.status === "cancelled";
  const arrival = ms(points[points.length - 1].planned_arr ?? points[points.length - 1].planned_dep);
  const lastReal = real.seq.length ? real.seq[real.seq.length - 1].t : arrival;
  const startT = ms(points[0].planned_dep ?? points[0].planned_arr);
  const endT = j.status === "pending" ? Math.max(Date.now(), startT) : Math.max(arrival, lastReal);
  // Ett tåg som har kommit fram visas framme vid slutstationen; uppspelningen visar resan dit.
  const arrived = j.status !== "pending" && !fullyCanceled && real.stoppedAt === null;
  const defaultT = j.status === "pending" ? Date.now() : arrived ? endT : arrival;

  function update(t, playing) {
    const r = fullyCanceled ? { x: xOf(0), delay: 0, index: 0 } : positionAt(real, t, xOf);
    const g = positionAt(plan, t, xOf);
    const stopped = real.stoppedAt !== null && (!real.seq.length || t >= real.seq[real.seq.length - 1].t);
    loco.setAttribute("transform", `translate(${r.x},${railY - 4}) scale(${scale})`);
    ghost.setAttribute("transform", `translate(${g.x},${railY - 4}) scale(${scale})`);
    loco.classList.toggle("stopped", stopped || fullyCanceled);
    // Röken kommer bara när tåget rullar, inte när det står på en station, före avgång eller framme.
    loco.classList.toggle("moving", !stopped && !fullyCanceled && !!r.moving);
    loco.style.setProperty("--loco", stopped || fullyCanceled ? "var(--ink)" : locoColor(r.delay));
    const apart = g.x - r.x > 24 * scale;
    ghostTag.setAttribute("x", g.x - 24 * scale);
    ghostTag.setAttribute("text-anchor", "middle");
    ghostTag.setAttribute("y", railY - 41 * scale);
    ghostTag.style.display = apart ? "" : "none";
    const minutes = stopped || fullyCanceled ? null : r.delay;
    gap.style.display = apart && minutes > 0 ? "" : "none";
    if (apart && minutes > 0) {
      const x1 = r.x, x2 = g.x;
      gapLine.setAttribute("d", `M${x1},${tagY + 5} V${tagY} H${x2} V${tagY + 5}`);
      gapText.setAttribute("x", Math.min(width - 30, Math.max(x1 + 24, (x1 + x2) / 2)));
      gapText.setAttribute("y", tagY - 5);
      gapText.textContent = `+${minutes} min`;
    }
    sign.style.display = stopped && !fullyCanceled ? "" : "none";
    if (stopped && !fullyCanceled) {
      signText.textContent = fullyCanceled ? "INSTÄLLT" : `INSTÄLLT EFTER ${points[real.stoppedAt].station.toUpperCase()}`;
      const w = signText.textContent.length * 7 + 16;
      const sx = Math.min(Math.max(r.x - 24 * scale, m.l - 30 + w / 2), width - w / 2 - 2);
      signRect.setAttribute("x", sx - w / 2);
      signRect.setAttribute("width", w);
      signRect.setAttribute("y", tagY - 18);
      signText.setAttribute("x", sx);
      signText.setAttribute("y", tagY - 4);
    }
    $("line-clock").textContent = `kl ${new Date(t).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" })}` +
      (playing ? "" : j.status === "pending" ? " (nu)" : arrived ? " (framme)" : " (planerad ankomst)");
    return r;
  }

  const r = update(defaultT, false);
  root.setAttribute("aria-label", lineStatusText(j, points, fullyCanceled || j.status === "pending" ? r : positionAt(real, arrival, xOf), real));
  $("line-play").onclick = () => {
    if (linePlay) { stopPlay(); update(defaultT, false); return; }
    const duration = 8000, began = performance.now();
    $("line-play").textContent = "■ Stoppa";
    const step = (now) => {
      const f = Math.min(1, (now - began) / duration);
      update(startT + (endT - startT) * f, true);
      if (f < 1) linePlay.raf = requestAnimationFrame(step);
      else { stopPlay(); setTimeout(() => { if (!linePlay) update(defaultT, false); }, 1500); }
    };
    linePlay = { raf: requestAnimationFrame(step) };
  };

  const legend = [["var(--warning)", "Förseningen ökade 2–4 min"], ["var(--serious)", "Ökade 5 min eller mer"], ["var(--critical)", "Inställt"]];
  if (j.status === "pending") legend.push(["var(--neutral)", "Ej körd ännu"]);
  $("line-legend").replaceChildren(
    ...legend.map(([c, t]) => el("span", {}, el("span", { class: "swatch", style: `background:${c}` }), document.createTextNode(t))),
    el("span", {}, el("span", { class: "ghost-key" }), document.createTextNode("Enligt tidtabell")));
  $("delay-details").hidden = fullyCanceled;
  if (!fullyCanceled) renderDelayDetails(j);
}

function nearestStation(points, index) {
  for (let i = index; i >= 0; i--) if (points[i].advertised) return points[i].station;
  return points[index].station;
}

function lineStatusText(j, points, r, real) {
  const pos = nearestStation(points, r.index);
  const where = r.index === points.length - 1 ? `framme i ${points[r.index].station}` : `vid ${pos}`;
  if (j.status === "cancelled") return `Avgången ställdes in. Loket står kvar i ${points[0].station}.`;
  if (j.status === "pending") {
    if (j.current_delay === null) {
      return `Planerad avgång ${hhmm(j.planned_departure)} från ${points[0].station}.` +
        (j.forecast_delay > 0 ? ` Väntas avgå ${hhmm(j.estimated_departure)} (${fmtDelay(j.forecast_delay)}).` : "");
    }
    const dep = j.actual_departure ? `Avgick ${hhmm(j.actual_departure)}, ${departureText(j.departure_delay)}. ` : "";
    return `${dep}På väg, senast ${where}. ${j.current_delay > 0 ? `${j.current_delay} min efter tidtabell.` : "Enligt tidtabell."}`;
  }
  if (real.stoppedAt !== null) return `Tåget kom inte längre än ${points[real.stoppedAt].station}, resten av sträckan ställdes in.`;
  if (j.delay !== null && j.delay > 0) {
    const done = `Framme i ${points[points.length - 1].station} ${hhmm(j.actual_arrival)}, ${j.delay} min sent.`;
    if (r.index === points.length - 1) return `${done} Spela upp resan för att se var förseningen uppstod.`;
    return `${done} När tåget skulle ha varit framme (${hhmm(j.planned_arrival)}) var det ${where} – spela upp resan för att se var förseningen uppstod.`;
  }
  return `Tåget kom fram ${hhmm(j.actual_arrival)}, ${j.delay < 0 ? `${-j.delay} min före tidtabell` : "enligt tidtabell"}.`;
}

function renderDelayDetails(j) {
  const body = $("delay-body");
  const segs = j.segments;
  const name = (s) => (s.kind === "stop" ? `Uppehåll i ${s.from}` : `${s.from} → ${s.to}`);
  const worst = segs.filter((s) => s.added >= 2).sort((a, b) => b.added - a.added);
  const canceled = segs.find((s) => s.canceled);
  let summary;
  if (j.status === "cancelled") summary = "Hela avgången ställdes in.";
  else if (canceled) summary = `Inställd från ${canceled.from}.` + (worst[0] ? ` Mest tid förlorades ${name(worst[0])} (+${worst[0].added} min).` : "");
  else if (worst.length) {
    const s = worst[0];
    summary = `+${s.added} min ${s.kind === "stop" ? `vid uppehållet i ${s.from}` : `mellan ${s.from} och ${s.to}`}` +
      (s.kind === "run" ? `, ${segTrackLabel(s).toLowerCase()}` : "") + (worst.length > 1 ? ` och ${worst.length - 1} ${worst.length === 2 ? "ställe" : "ställen"} till` : "");
  } else summary = segs.some((s) => s.added !== null) ? "Ingen försening uppstod längs vägen." : "Inga rapporterade tider ännu.";
  $("delay-summary").textContent = summary;

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
    `Tillkommet = hur mycket förseningen ökade på sträckan eller under uppehållet (negativt = tåget tog igen tid). ` +
    `Delsträckorna går mellan alla platser där Trafikverket rapporterar tåget, även sådana utan resandeutbyte. ` +
    `På linjen betyder dubbla räler dubbelspår, en räl enkelspår och streckad okänt. `));
  if (hiddenCount || showAll) {
    note.append(el("button", { type: "button", class: "link-btn", text: showAll ? "Visa bara ändringar" : `Visa alla ${merged.length} delsträckor`,
      onclick: () => { body.dataset.all = showAll ? "" : "1"; renderDelayDetails(j); } }));
  }
  parts.push(note);
  body.replaceChildren(...parts);
}

function showOnLine(date) {
  pickLineDate(date);
  $("delay-details").open = true;
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

// ------------------------------------------------------------------- flikar
const TABS = ["overview", "punct", "cost", "table"];

function setTab(tab) {
  if (!TABS.includes(tab)) tab = "overview";
  state.tab = tab;
  try { localStorage.setItem("tab", tab); } catch { /* bara en bekvämlighet */ }
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  const has = Boolean(state.data?.summary.journeys);
  for (const t of TABS) {
    const on = t === tab;
    const b = $(`tab-${t}`);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    // Kostnad och Avgångar visas även utan avslutade avgångar (de har egna tomma lägen).
    $(`panel-${t}`).hidden = !on || (!has && (t === "overview" || t === "punct"));
  }
  $("empty").hidden = has || !(tab === "overview" || tab === "punct");
  renderTabCharts();
}

/** Diagram ritas bara i den synliga fliken – i en dold flik har de ingen bredd. */
function renderTabCharts() {
  const d = state.data;
  if (!d) return;
  if (d.summary.journeys && state.tab === "overview") renderDaily(d.journeys, d.threshold);
  if (d.summary.journeys && state.tab === "punct") {
    renderSplit(d.summary);
    renderWeekly(d.weeks);
    renderWeekday(d.weekdays);
    renderStations(d.stations);
  }
  if (state.tab === "cost" && d.cost && d.cost.journeys) renderCostChart();
}

const tabList = $("tabs");
tabList.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
tabList.addEventListener("keydown", (e) => {
  const i = TABS.indexOf(state.tab);
  const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length
    : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  setTab(TABS[next]);
  $(`tab-${TABS[next]}`).focus();
});
window.addEventListener("hashchange", () => { const t = location.hash.replace("#", ""); if (TABS.includes(t) && t !== state.tab) setTab(t); });
$("kpi-cost-tile").addEventListener("click", () => { setTab("cost"); document.querySelector(".tabbar").scrollIntoView({ behavior: "smooth", block: "start" }); });

function render() {
  const d = state.data;
  const t = d.train;
  $("content").hidden = false;
  const product = [t.product, t.operator && t.operator !== t.product ? t.operator : null].filter(Boolean).join(", ");
  $("about").textContent = [`Tåg ${t.ident}${t.origin ? ` ${t.origin} → ${t.destination}` : ""}${product ? ` (${product})` : ""}.`, ageText(t)]
    .filter(Boolean).join(" ");
  renderSync(d);
  renderNow();
  renderUpcoming(d.upcoming ?? []);
  renderLine();
  renderKpis(d.summary, d.threshold, d.cost);
  $("overview-summary").textContent = d.summary.journeys ? overviewSummary(d) : "";
  if (!d.summary.journeys) {
    $("empty").textContent = d.journeys.length
      ? "Inga avslutade avgångar i den valda perioden ännu. Statistiken fylls på efter varje avgång."
      : "Trafikverket har inga uppgifter om det här tågnumret just nu. Kontrollera numret – bevakningen fortsätter och data dyker upp när tåget går.";
  }
  renderCost();
  renderTable(tableRows(d.journeys));
  setTab(state.tab);
}

// ------------------------------------------------------------------ actions
async function loadStats() {
  if (!state.train) {
    $("content").hidden = true;
    showMessage("Inga tåg bevakas. Lägg till tåg på adminsidan /admin för att börja samla data.", true);
    return;
  }
  $("content").classList.add("loading");
  try {
    const q = new URLSearchParams({ train: state.train });
    if (state.days) q.set("days", state.days);
    const [data, replayable] = await Promise.all([
      api(`/api/stats?${q}`),
      api(`/api/journeys?${new URLSearchParams({ train: state.train })}`).catch(() => state.replayable),
    ]);
    state.data = data;
    state.replayable = replayable;
    render();
  } finally {
    $("content").classList.remove("loading");
  }
}

async function loadTrains() {
  state.trains = await api("/api/trains");
  if (!state.trains.some((t) => t.ident === state.train)) state.train = state.trains[0]?.ident ?? null;
  renderTrains();
}

function selectTrain(ident) {
  state.train = ident;
  state.lineDate = null;
  state.lineExtra = null;
  state.replayable = [];
  stopPlay();
  localStorage.setItem("train", ident);
  renderTrains();
  loadStats().catch((e) => showMessage(e.message));
}

$("periods").addEventListener("click", (e) => {
  if (e.target.dataset.days === undefined) return;
  state.days = e.target.dataset.days;
  localStorage.setItem("days", state.days);
  renderTrains();
  loadStats().catch((err) => showMessage(err.message));
});

let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderTabCharts();
    renderLine();
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
    await loadStats();
  } catch (e) { showMessage(e.message); }
  setInterval(() => {
    if (document.hidden) return;
    loadStats().catch(() => {});
    loadVisitors();
  }, 60000);
})();
