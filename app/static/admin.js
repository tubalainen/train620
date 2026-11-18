"use strict";

const $ = (id) => document.getElementById(id);
const nf = (n) => n.toLocaleString("sv-SE");
let trains = [];

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

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, credentials: "same-origin" });
  if (res.status === 401 && !path.endsWith("/login")) { showView("login"); throw new Error("Du har loggats ut. Logga in igen."); }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* inget JSON-svar */ }
    throw new Error(typeof detail === "string" ? detail : "Något gick fel");
  }
  return res.status === 204 ? null : res.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

function showMessage(text, ok = false) {
  const m = $("message");
  m.textContent = text;
  m.className = "message" + (ok ? " ok" : "");
  m.hidden = !text;
}

function showView(view) {
  $("disabled").hidden = view !== "disabled";
  $("login").hidden = view !== "login";
  $("panel").hidden = view !== "panel";
  $("logout").hidden = view !== "panel";
  if (view === "login") $("password").focus();
}

function fmtAge(days) {
  if (days < 1) return "i dag";
  if (days < 14) return `${days} d`;
  if (days < 60) return `${Math.round(days / 7)} v`;
  const months = Math.round(days / 30.44);
  return months < 12 ? `${months} mån` : `${Math.floor(months / 12)} år ${months % 12} mån`;
}

const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });

// ------------------------------------------------------------------- tåg
async function loadTrains() {
  trains = await api("/api/trains");
  const rows = $("train-rows");
  rows.replaceChildren();
  if (!trains.length) rows.append(el("tr", {}, el("td", { colspan: 5, text: "Inga tåg bevakas." })));
  for (const t of trains) {
    rows.append(el("tr", {},
      el("td", {}, el("strong", { text: t.ident })),
      el("td", { class: "route", text: t.origin ? `${t.origin} → ${t.destination}` : "Inga uppgifter från Trafikverket ännu" }),
      el("td", { class: "num", text: nf(t.journeys) }),
      el("td", { text: t.first_date ? `${fmtDate(t.first_date)} (${fmtAge(t.age_days)})` : "–",
                 title: t.first_collected_date ? `Egen insamling sedan ${fmtDate(t.first_collected_date)}` : "" }),
      el("td", { class: "actions" }, el("button", { type: "button", class: "remove-btn", text: "Ta bort", onclick: () => removeTrain(t.ident) }))));
  }
  const select = $("import-train");
  const previous = select.value;
  select.replaceChildren(...trains.map((t) => el("option", { value: t.ident, text: t.origin ? `${t.ident} · ${t.origin} → ${t.destination}` : t.ident })));
  if (trains.some((t) => t.ident === previous)) select.value = previous;
}

async function removeTrain(ident) {
  if (!confirm(`Ta bort tåg ${ident}? All insamlad och importerad data för tåget raderas.`)) return;
  try {
    await api(`/api/trains/${ident}`, { method: "DELETE" });
    showMessage(`Tåg ${ident} togs bort.`, true);
    await loadTrains();
  } catch (e) { showMessage(e.message); }
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    const added = await post("/api/trains", { ident: $("add-input").value.trim() });
    $("add-input").value = "";
    showMessage(added.found
      ? `Tåg ${added.ident} bevakas nu.`
      : `Tåg ${added.ident} bevakas nu, men Trafikverket har inga uppgifter om det just nu.`, Boolean(added.found));
    await loadTrains();
    $("import-train").value = added.ident;
  } catch (err) { showMessage(err.message); }
  button.disabled = false;
});

// ---------------------------------------------------------------- spår
let tracks = [];
const TRACK_OPTIONS = [["", "Okänt"], ["1", "Enkelspår"], ["2", "Dubbelspår"]];

function renderTracks() {
  const q = $("track-filter").value.trim().toLowerCase();
  const rows = $("track-rows");
  const shown = tracks.filter((t) => !q || `${t.from} ${t.to} ${t.line ?? ""}`.toLowerCase().includes(q));
  rows.replaceChildren();
  if (!shown.length) rows.append(el("tr", {}, el("td", { colspan: 5, text: tracks.length ? "Inga sträckor matchar." : "Inga sträckor ännu – de läggs till när tågen har gått." })));
  for (const t of shown) {
    const select = el("select", { class: "field", "aria-label": `Antal spår ${t.from}–${t.to}` },
      ...TRACK_OPTIONS.map(([v, label]) => el("option", { value: v, text: label })));
    select.value = t.tracks === null ? "" : String(t.tracks);
    const line = el("input", { class: "field line-input", value: t.line ?? "", maxlength: 60, placeholder: "Bana", "aria-label": `Bana ${t.from}–${t.to}` });
    const save = async () => {
      try {
        await api("/api/tracks", { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_sig: t.from_sig, to_sig: t.to_sig, tracks: select.value ? Number(select.value) : null, line: line.value }) });
        showMessage(`${t.from}–${t.to} sparades.`, true);
        await loadTracks();
      } catch (err) { showMessage(err.message); }
    };
    select.addEventListener("change", save);
    line.addEventListener("change", save);
    const reset = t.source === "admin"
      ? el("button", { type: "button", text: "Återställ", title: "Använd den inbyggda uppgiften igen", onclick: async () => {
          try {
            await api(`/api/tracks/${encodeURIComponent(t.from_sig)}/${encodeURIComponent(t.to_sig)}`, { method: "DELETE" });
            showMessage(`${t.from}–${t.to} återställdes.`, true);
            await loadTracks();
          } catch (err) { showMessage(err.message); }
        } })
      : null;
    rows.append(el("tr", {},
      el("td", { text: `${t.from} – ${t.to}` }),
      el("td", {}, line),
      el("td", {}, select),
      el("td", { class: "route", text: t.source === "admin" ? "Ändrad här" : "Inbyggd" }),
      el("td", { class: "actions" }, reset)));
  }
}

async function loadTracks() {
  tracks = await api("/api/tracks");
  renderTracks();
}
$("track-filter").addEventListener("input", renderTracks);

// ------------------------------------------------------------ kostnadsmodell
let costModel = null;
const SHARE_GROUPS = {
  common: (k) => k.startsWith("share_"),
  out_purpose: (k) => k.endsWith("_share"),
  out_margin: () => true,
  out_cancel: (k) => k.endsWith("_share"),
  home_cancel: (k) => k.endsWith("_share"),
};
const fmtNum = (v) => v.toLocaleString("sv-SE", { maximumFractionDigits: 2 });
const parseNum = (text) => Number(String(text).trim().replace(/\s/g, "").replace(",", "."));

function costInputs() { return [...document.querySelectorAll("#cost-groups input[data-key]")]; }

function costDirty() {
  return costInputs().filter((i) => i.value.trim() !== "" && parseNum(i.value) !== Number(i.dataset.value));
}

function updateCostForm() {
  for (const input of costInputs()) {
    const v = parseNum(input.value);
    input.closest(".cost-row").classList.toggle("changed", Number.isFinite(v) && v !== Number(input.dataset.default));
  }
  for (const [group, isShare] of Object.entries(SHARE_GROUPS)) {
    const note = document.querySelector(`[data-share-note="${group}"]`);
    if (!note) continue;
    const sum = costInputs().filter((i) => i.dataset.group === group && isShare(i.dataset.key))
      .reduce((a, i) => a + (parseNum(i.value) || 0), 0);
    note.textContent = `${group === "common" ? "Resenärsgruppernas andelar" : "Andelarna"} summerar till ${fmtNum(sum)} %` + (Math.abs(sum - 100) > 0.01 ? " – de skalas om till 100 % i beräkningen." : ".");
    note.classList.toggle("warn", Math.abs(sum - 100) > 0.01);
  }
  const dirty = costDirty().length;
  $("cost-save").disabled = !dirty;
  $("cost-undo").disabled = !dirty;
}

function renderCostResult(m) {
  const e = m.explain;
  const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
  $("cost-result").textContent = `${e.out.passengers} resenärer · mötesförlust ${kr(e.out.meeting_loss)} · inställd utresa ${kr(e.out.cancelled.total)} · inställd hemresa ${kr(e.home.cancelled.total)}`;
}

function renderCostForm(m) {
  costModel = m;
  const box = $("cost-groups");
  box.replaceChildren();
  for (const [group, title] of Object.entries(m.groups)) {
    const fs = el("details", { class: "cost-group", open: ["common", "values"].includes(group) ? "" : null },
      el("summary", { text: title }));
    if (SHARE_GROUPS[group]) fs.append(el("p", { class: "group-note", "data-share-note": group }));
    for (const p of m.params.filter((x) => x.group === group)) {
      const id = `cp-${p.key}`;
      const input = el("input", { id, class: "field", inputmode: "decimal", value: fmtNum(p.value), "data-key": p.key,
        "data-group": group, "data-value": p.value, "data-default": p.default, "aria-describedby": `${id}-help` });
      input.addEventListener("input", updateCostForm);
      fs.append(el("div", { class: "cost-row" },
        el("label", { for: id, text: p.label }),
        el("span", { class: "cost-input" }, input, el("span", { class: "unit", text: p.unit }),
          el("span", { class: "default", text: `standard ${fmtNum(p.default)}` })),
        el("span", { class: "help", id: `${id}-help`, text: p.help })));
    }
    box.append(fs);
  }
  updateCostForm();
  renderCostResult(m);
}

async function loadCostModel() { renderCostForm(await api("/api/cost/model")); }

$("cost-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = {};
  for (const input of costDirty()) {
    const v = parseNum(input.value);
    if (!Number.isFinite(v)) { input.focus(); return showMessage(`Ange ett tal: ${input.closest(".cost-row").querySelector("label").textContent}`); }
    values[input.dataset.key] = v;
  }
  try {
    const m = await api("/api/admin/cost-params", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
    renderCostForm(m);
    showMessage(`${Object.keys(values).length} schabloner sparades. Statistiken är omräknad.`, true);
  } catch (err) { showMessage(err.message); }
});
$("cost-undo").addEventListener("click", () => costModel && renderCostForm(costModel));
$("cost-reset").addEventListener("click", async () => {
  if (!confirm("Återställ alla schabloner till standardvärdena?")) return;
  try {
    renderCostForm(await post("/api/admin/cost-params/reset", {}));
    showMessage("Alla schabloner är återställda till standard.", true);
  } catch (err) { showMessage(err.message); }
});

// ---------------------------------------------------------------- import
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const mentions = (name, ident) => new RegExp(`(^|\\D)${ident}(\\D|$)`).test(name);

async function loadImportFile(file) {
  if (!file) return;
  const info = $("drop-info");
  info.hidden = false;
  if (file.size > MAX_IMPORT_BYTES) { info.textContent = `${file.name} är för stor (högst 2 MB).`; return; }
  const text = (await file.text()).replace(/^﻿/, "");
  if (text.includes("\u0000")) { info.textContent = `${file.name} ser inte ut att vara en textfil.`; return; }
  $("import-text").value = text.trim();
  const rows = text.split(/\r?\n/).filter((l) => /^\s*\d{4}-\d{2}-\d{2}/.test(l)).length;
  info.textContent = `${file.name} – ${nf(rows)} rader med datum. Granska nedan och klicka på Importera.`;
  // Pekar filnamnet på exakt ett bevakat tåg väljs det; annars varnas om det verkar fel.
  const matches = trains.filter((t) => mentions(file.name, t.ident));
  if (matches.length === 1 && matches[0].ident !== $("import-train").value) {
    $("import-train").value = matches[0].ident;
    showMessage(`Tåg ${matches[0].ident} valdes utifrån filnamnet. Kontrollera innan du importerar.`, true);
  } else {
    showMessage("");
  }
}

const drop = $("drop");
$("import-file").addEventListener("change", (e) => { loadImportFile(e.target.files[0]); e.target.value = ""; });
for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const type of ["dragleave", "drop"]) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => loadImportFile(e.dataTransfer.files[0]));
// En fil som släpps utanför rutan ska inte öppnas av webbläsaren i stället för sidan.
for (const type of ["dragover", "drop"]) window.addEventListener(type, (e) => e.preventDefault());

$("import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ident = $("import-train").value;
  if (!ident) return showMessage("Lägg till ett tåg innan du importerar.");
  try {
    const res = await post(`/api/trains/${ident}/import`, { csv: $("import-text").value, source: $("import-source").value.trim() || "import" });
    showMessage(`${nf(res.imported)} dagar importerades till tåg ${ident}.` +
      (res.skipped_lines.length ? ` Rader som inte gick att tolka: ${res.skipped_lines.join(", ")}.` : ""), !res.skipped_lines.length);
    if (res.imported) { $("import-text").value = ""; $("drop-info").hidden = true; }
    await loadTrains();
  } catch (err) { showMessage(err.message); }
});

// ---------------------------------------------------------------- radera
$("reset-confirm").addEventListener("input", (e) => { $("reset-button").disabled = e.target.value.trim() !== "RADERA"; });
$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!confirm("Radera alla tåg och all data? Det går inte att ångra.")) return;
  try {
    const res = await post("/api/admin/reset", { confirm: $("reset-confirm").value });
    $("reset-confirm").value = "";
    $("reset-button").disabled = true;
    showMessage(`All data är raderad. Insamlingen börjar om för tåg ${res.trains.join(", ") || "–"}.`, true);
    $("initial-trains").textContent = res.trains.join(", ") || "inga";
    await loadTrains();
  } catch (err) { showMessage(err.message); }
});

// --------------------------------------------------------------- inloggning
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await post("/api/admin/login", { password: $("password").value });
    $("password").value = "";
    showMessage("");
    await enterPanel();
  } catch (err) { showMessage(err.message); $("password").select(); }
  button.disabled = false;
});

$("logout").addEventListener("click", async () => {
  await post("/api/admin/logout");
  showMessage("Du är utloggad.", true);
  showView("login");
});

// ---------------------------------------------------------------- hämtning
function renderPoll(h) {
  const status = $("poll-status");
  const t = h.last_poll_ok
    ? new Date(h.last_poll_ok).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  status.textContent = (t ? `Senast hämtat ${t}.` : "Ingen hämtning har lyckats ännu.") +
    (h.last_error ? " Senaste försöket misslyckades." : "");
  status.classList.toggle("err", Boolean(h.last_error));
}

$("refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    renderPoll(await api("/api/refresh", { method: "POST" }));
    await loadTrains();
  } catch (err) { showMessage(err.message); }
  e.target.disabled = false;
});

async function enterPanel() {
  showView("panel");
  await Promise.all([loadTrains(), loadTracks(), loadCostModel(), api("/api/health").then(renderPoll)]);
}

(async function start() {
  try {
    const s = await api("/api/admin/session");
    if (!s.enabled) return showView("disabled");
    $("initial-trains").textContent = s.initial_trains.join(", ") || "inga";
    if (!s.logged_in) return showView("login");
    await enterPanel();
  } catch (e) { showMessage(e.message); }
})();
