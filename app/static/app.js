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
  const box = $("trains");
  box.replaceChildren();
  for (const t of state.trains) {
    const active = t.ident === state.train;
    box.append(el("span", { class: "chip" + (active ? " active" : "") },
      el("button", { type: "button", role: "tab", "aria-selected": active, text: t.ident, title: t.origin ? `${t.origin} → ${t.destination}` : "", onclick: () => selectTrain(t.ident) }),
      el("button", { type: "button", class: "remove", "aria-label": `Ta bort tåg ${t.ident}`, title: "Ta bort", text: "✕", onclick: () => removeTrain(t.ident) })));
  }
  for (const b of $("periods").children) b.setAttribute("aria-pressed", String(b.dataset.days === state.days));
}

function renderToday(journeys) {
  const box = $("today");
  const latest = journeys[0];
  box.hidden = !latest;
  if (!latest) return;
  const isToday = latest.date === new Date().toLocaleDateString("sv-SE");
  let label, detail;
  if (latest.status === "pending") {
    const moving = latest.current_delay !== null;
    label = moving ? "På väg" : "Planerat";
    detail = moving
      ? `Senast rapporterat: ${fmtDelay(latest.current_delay)}. Beräknad ankomst ${hhmm(latest.estimated_arrival || latest.planned_arrival)}.`
      : `Avgår ${hhmm(latest.planned_departure)}, ankomst ${hhmm(latest.planned_arrival)}.`;
  } else if (latest.status === "cancelled") {
    detail = "Hela avgången ställdes in.";
  } else if (latest.delay !== null) {
    detail = `Ankom ${latest.destination ?? "slutstationen"} ${hhmm(latest.actual_arrival)} (${fmtDelay(latest.delay)}).`;
  } else {
    detail = latest.status === "partial" ? "Delar av sträckan ställdes in." : "Ingen ankomsttid har rapporterats.";
  }
  box.replaceChildren(
    el("strong", { text: isToday ? "I dag" : `Senaste avgång, ${fmtLongDate(latest.date)}` }),
    statusBadge(latest.status, label),
    el("span", { class: "detail", text: detail }));
}

function renderKpis(s, threshold) {
  const share = (n) => (s.journeys ? `${nf((100 * n) / s.journeys, 1)} % av avgångarna` : "");
  $("kpi-punct").textContent = s.punctuality === null ? "–" : `${nf(s.punctuality, s.punctuality % 1 ? 1 : 0)} %`;
  $("kpi-punct-note").textContent = `Högst ${threshold} min sent till slutstationen. Inställda tåg räknas som ej i tid.`;
  $("kpi-count").textContent = nf(s.journeys);
  $("kpi-count-note").textContent = `${nf(s.ontime)} i tid`;
  $("kpi-delayed").textContent = nf(s.delayed);
  $("kpi-delayed-note").textContent = share(s.delayed);
  $("kpi-cancelled").textContent = nf(s.cancelled + s.partial);
  $("kpi-cancelled-note").textContent = s.partial ? `varav ${nf(s.partial)} delvis` : share(s.cancelled);
  $("kpi-avg").textContent = s.avg_delay === null ? "–" : `${nf(s.avg_delay, 1)} min`;
  $("kpi-avg-note").textContent = s.max_delay === null ? "" : `Störst: ${fmtDelay(s.max_delay)} (${fmtDate(s.max_delay_date)})`;
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
  return el("tr", { class: "stops" }, el("td", { colspan: 6 }, table));
}

const PAGE = 30;
function renderTable(journeys, limit = PAGE) {
  const body = document.querySelector("#journeys tbody");
  body.replaceChildren();
  const more = $("more");
  more.hidden = journeys.length <= limit;
  more.textContent = `Visa fler (${journeys.length - limit} till)`;
  more.onclick = () => renderTable(journeys, limit + 60);
  journeys = journeys.slice(0, limit);
  if (!journeys.length) body.append(el("tr", {}, el("td", { colspan: 6, text: "Inga avgångar i perioden ännu." })));
  for (const j of journeys) {
    const row = el("tr", { class: "journey", tabindex: 0, "aria-expanded": "false" },
      el("td", { text: fmtLongDate(j.date) }),
      el("td", {}, statusBadge(j.status, j.status === "pending" && j.current_delay !== null ? "På väg" : undefined)),
      el("td", { class: "num", text: hhmm(j.planned_arrival) }),
      el("td", { class: "num", text: hhmm(j.actual_arrival) }),
      el("td", { class: "num", text: fmtDelay(j.delay) }),
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

function renderSync(d) {
  const text = $("sync-text");
  if (d.last_poll_ok) {
    const t = new Date(d.last_poll_ok).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    text.textContent = `Senast hämtat ${t}`;
  } else {
    text.textContent = "Ingen hämtning har lyckats ännu";
  }
  text.classList.toggle("err", Boolean(d.last_error));
  if (d.last_error) text.textContent += " – senaste försöket misslyckades";
  $("foot").textContent = `Tågkoll ${d.version === "dev" ? "(utvecklingsversion)" : "v" + d.version}. Trafikverket tillfrågas var ${Math.round(d.poll_seconds / 60)}:e minut. Ett tåg räknas som försenat när det ankommer slutstationen mer än ${d.threshold} minuter efter tidtabell.`;
}

function renderCharts() {
  const d = state.data;
  if (!d || !d.summary.journeys) return;
  renderSplit(d.summary);
  renderDaily(d.journeys, d.threshold);
  renderWeekly(d.weeks);
  renderWeekday(d.weekdays);
  renderStations(d.stations);
}

function render() {
  const d = state.data;
  const t = d.train;
  $("content").hidden = false;
  $("train-title").textContent = `Tåg ${t.ident}` + (t.origin ? ` · ${t.origin} → ${t.destination}` : "");
  $("train-sub").textContent = [t.product, t.operator && t.operator !== t.product ? t.operator : null,
    t.first_date ? `data sedan ${fmtDate(t.first_date, { day: "numeric", month: "long", year: "numeric" })}` : null].filter(Boolean).join(" · ");
  renderSync(d);
  renderToday(d.journeys);
  renderKpis(d.summary, d.threshold);
  const has = d.summary.journeys > 0;
  $("charts").hidden = !has;
  $("empty").hidden = has;
  if (!has) {
    $("empty").textContent = d.journeys.length
      ? "Inga avslutade avgångar i den valda perioden ännu. Statistiken fylls på efter varje avgång."
      : "Trafikverket har inga uppgifter om det här tågnumret just nu. Kontrollera numret – bevakningen fortsätter och data dyker upp när tåget går.";
  }
  renderCharts();
  renderTable(d.journeys);
}

// ------------------------------------------------------------------ actions
async function loadStats() {
  if (!state.train) {
    $("content").hidden = true;
    showMessage("Inga tåg bevakas. Lägg till ett tågnummer för att börja samla data.", true);
    return;
  }
  $("charts").classList.add("loading");
  document.querySelector(".kpis").classList.add("loading");
  try {
    const q = new URLSearchParams({ train: state.train });
    if (state.days) q.set("days", state.days);
    state.data = await api(`/api/stats?${q}`);
    render();
  } finally {
    $("charts").classList.remove("loading");
    document.querySelector(".kpis").classList.remove("loading");
  }
}

async function loadTrains() {
  state.trains = await api("/api/trains");
  if (!state.trains.some((t) => t.ident === state.train)) state.train = state.trains[0]?.ident ?? null;
  renderTrains();
}

function selectTrain(ident) {
  state.train = ident;
  localStorage.setItem("train", ident);
  renderTrains();
  loadStats().catch((e) => showMessage(e.message));
}

async function removeTrain(ident) {
  if (!confirm(`Ta bort tåg ${ident}? All insamlad data för tåget raderas.`)) return;
  try {
    await api(`/api/trains/${ident}`, { method: "DELETE" });
    showMessage(`Tåg ${ident} togs bort.`, true);
    await loadTrains();
    await loadStats();
  } catch (e) { showMessage(e.message); }
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("add-input");
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    const added = await api("/api/trains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ident: input.value.trim() }) });
    input.value = "";
    showMessage(added.found
      ? `Tåg ${added.ident} bevakas nu.`
      : `Tåg ${added.ident} bevakas nu, men Trafikverket har inga uppgifter om det just nu.`, Boolean(added.found));
    state.train = added.ident;
    localStorage.setItem("train", added.ident);
    await loadTrains();
    await loadStats();
  } catch (err) { showMessage(err.message); }
  button.disabled = false;
});

$("periods").addEventListener("click", (e) => {
  if (e.target.dataset.days === undefined) return;
  state.days = e.target.dataset.days;
  localStorage.setItem("days", state.days);
  renderTrains();
  loadStats().catch((err) => showMessage(err.message));
});

$("refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    await api("/api/refresh", { method: "POST" });
    await loadTrains();
    await loadStats();
  } catch (err) { showMessage(err.message); }
  e.target.disabled = false;
});

$("import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await api(`/api/trains/${state.train}/import`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: $("import-text").value, source: $("import-source").value.trim() || "import" }) });
    showMessage(`${res.imported} dagar importerades.` + (res.skipped_lines.length ? ` Rader som inte gick att tolka: ${res.skipped_lines.join(", ")}.` : ""), !res.skipped_lines.length);
    if (res.imported) $("import-text").value = "";
    await loadTrains();
    await loadStats();
  } catch (err) { showMessage(err.message); }
});

let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 120); }).observe(document.querySelector("main"));

(async function start() {
  try {
    await loadTrains();
    await loadStats();
  } catch (e) { showMessage(e.message); }
  setInterval(() => { if (!document.hidden) loadStats().catch(() => {}); }, 60000);
})();
