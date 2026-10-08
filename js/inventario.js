// =====================================================================
// INVENTARIO — conectado con Productos, Costeo y Ventas
//   • Existencias: materias primas e insumos, extras, acompañantes y
//     granizados (cuántos se pueden preparar con los ingredientes).
//   • NUEVA COMPRA: suma al stock y actualiza el costo de compra que usa
//     el Costeo (el inventario es la fuente del costo, sin duplicar datos).
//   • Ajustes manuales: entradas, salidas (merma, daño…) y conteo físico.
//   • Las ventas (pedidos pagados y ventas de extras) descuentan solas.
//   • Historial de compras, entradas, salidas por ventas y ajustes.
//   • Alerta cuando un artículo llega a su stock mínimo.
// =====================================================================
(function () {
"use strict";

const {
  db, COL, money, parseMoney, isValidPrice, esc, normalize, dateKey, timeLabel, dateLabel, toDate,
  productSizes, friendlyError, toast
} = window.Core;
const {
  collection, doc, query, where, orderBy, limit, getDocs, runTransaction, serverTimestamp, Timestamp
} = window.Store;
const Kit = window.AdminKit;
const C = window.Costing;
const S = window.Stock;
const { moneyDec } = C;
const $ = sel => document.querySelector(sel);

const GROUPS = [["supplies", "Materias primas e insumos"], ["extras", "Extras"], ["sides", "Acompañantes"]];
const PAY = { efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", otro: "Otro" };
const REASONS = ["Inventario inicial", "Conteo físico", "Merma", "Producto dañado", "Producto vencido",
  "Consumo interno", "Cortesía / regalo", "Devolución a proveedor", "Traslado"];
const MAX_ROWS = 500;
const round2 = n => Math.round(n * 100) / 100;
const qtyTxt = (n, unit) => `${C.qty(n)} ${esc(unit)}`;
const firstOfMonth = () => { const d = new Date(); return dateKey(new Date(d.getFullYear(), d.getMonth(), 1)); };
const ymd = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const spinner = `<div class="loading-screen small"><div class="spinner dark"></div></div>`;

const inv = {
  sub: "existencias",       // existencias | compras | historial
  kind: "",                 // "" | supplies | extras | sides | granizados
  status: "",               // "" | ok | bajo | agotado | none
  q: "",
  from: firstOfMonth(), to: dateKey(new Date()),
  htype: "", hq: "",
  moves: null, movesKey: "", token: 0,
  prevStatus: null,         // para detectar cuándo un artículo llega al mínimo
  alerts: new Map()         // alertas visibles en el aviso flotante
};

// =====================================================================
// DATOS
// =====================================================================
const ready = () => Kit.state.catalogReady && Kit.state.costingReady && (Kit.extrasReady ? Kit.extrasReady() : true);

function article(col, x) {
  return {
    key: col + "/" + x.id, col, id: x.id, x,
    name: x.name || "(sin nombre)",
    sub: col === "sides" ? "" : (x.category || ""),
    unit: S.stockUnit(col, x),
    tracked: S.isTracked(x),
    stock: S.stockOf(x),
    min: S.minOf(x),
    status: S.status(x),
    cost: S.unitCost(col, x)
  };
}

function articles() {
  return [
    ...Kit.state.supplies.map(x => article("supplies", x)),
    ...(Kit.extrasList ? Kit.extrasList() : []).map(x => article("extras", x)),
    ...Kit.state.sides.map(x => article("sides", x))
  ];
}
const findArt = key => articles().find(a => a.key === key) || null;
const kindLabel = col => (col === "supplies" ? "Materia prima" : col === "extras" ? "Extra" : "Acompañante");
const suppliers = () => [...new Set(articles().map(a => String(a.x.supplier || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));

/** Granizados: cuántos vasos de cada tamaño alcanzan con el stock de sus ingredientes. */
function granizadoRows() {
  const sup = new Map(Kit.state.supplies.map(s => [s.id, s]));
  const rows = [];
  for (const p of Kit.state.products) {
    for (const s of productSizes(p)) {
      const needs = new Map();
      ((s.costing && s.costing.recipe) || []).forEach(l => S.addNeed(needs, "supplies", l.supplyId, Number(l.qty), l.unit));
      let possible = Infinity, limiting = null, tracked = 0;
      const low = [];
      for (const n of needs.values()) {
        const x = sup.get(n.id);
        if (!x || !S.isTracked(x)) continue;
        const { qty } = S.needQty("supplies", x, n.parts);
        if (!(qty > 0)) continue;
        tracked++;
        const can = Math.max(0, Math.floor((S.stockOf(x) + 1e-9) / qty));
        if (can < possible) { possible = can; limiting = x; }
        const st = S.status(x);
        if (st === "bajo" || st === "agotado") low.push(x.name);
      }
      const status = !needs.size ? "norecipe" : !tracked ? "none" : possible <= 0 ? "agotado" : low.length ? "bajo" : "ok";
      rows.push({ p, s, possible: tracked ? possible : NaN, limiting, low, status });
    }
  }
  return rows;
}

// =====================================================================
// ALERTAS DE STOCK MÍNIMO (insignia en el menú + aviso flotante)
// =====================================================================
function checkAlerts() {
  if (!ready()) return;
  const list = articles();
  const low = list.filter(a => a.status === "bajo" || a.status === "agotado");
  Kit.setBadge("inventario", low.length);
  const prev = inv.prevStatus;
  inv.prevStatus = new Map(list.map(a => [a.key, a.status]));
  if (!prev) return; // al abrir solo se muestra la insignia
  const reached = low.filter(a => {
    const p = prev.get(a.key);
    return (p === "ok" && (a.status === "bajo" || a.status === "agotado")) || (p === "bajo" && a.status === "agotado");
  });
  // Las que se repusieron salen del aviso
  for (const k of [...inv.alerts.keys()]) {
    const a = list.find(x => x.key === k);
    if (!a || a.status === "ok" || a.status === "none") inv.alerts.delete(k);
  }
  reached.forEach(a => inv.alerts.set(a.key, a));
  if (reached.length) paintAlert();
  else if (!inv.alerts.size) $("#stockAlert")?.remove();
}

function paintAlert() {
  let el = $("#stockAlert");
  if (!inv.alerts.size) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "stockAlert";
    el.className = "stock-alert";
    el.setAttribute("role", "alert");
    document.body.appendChild(el);
    el.addEventListener("click", e => {
      if (e.target.closest("[data-sa-close]")) { inv.alerts.clear(); el.remove(); }
      if (e.target.closest("[data-sa-go]")) {
        inv.alerts.clear(); el.remove();
        inv.sub = "existencias"; inv.status = ""; inv.kind = "";
        Kit.showTab("inventario");
      }
    });
  }
  el.innerHTML = `
    <div class="sa-head"><b>⚠️ Alerta de inventario</b><button class="icon-x small" data-sa-close aria-label="Cerrar">×</button></div>
    <ul>${[...inv.alerts.values()].map(a => `
      <li><b>${esc(a.name)}</b> ${a.status === "agotado" ? `<span class="st-pill st-agotado">AGOTADO</span>` : `<span class="st-pill st-bajo">Bajo stock</span>`}
        <small>quedan ${qtyTxt(a.stock, a.unit)}${a.min ? ` · mínimo ${qtyTxt(a.min, a.unit)}` : ""}</small></li>`).join("")}</ul>
    <button class="btn btn-sm btn-block" data-sa-go>Ver inventario</button>`;
}

// Cualquier cambio de stock (ventas, compras, ajustes, otra pestaña) llega por aquí
let refreshTimer = null;
function onDataChange() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    checkAlerts();
    if (Kit.isTab("inventario")) refresh();
  }, 60);
}
["catalog", "supplies", "extras-stock"].forEach(ev => Kit.on(ev, onDataChange));

// =====================================================================
// PESTAÑA
// =====================================================================
function render(full) {
  const view = $("#view-inventario");
  if (!view) return;
  if (!full && view.querySelector("#invBody")) { refresh(); return; }
  // Al abrir Inventario el aviso flotante ya cumplió: la pantalla muestra las alertas
  inv.alerts.clear();
  $("#stockAlert")?.remove();
  const tabs = [["existencias", "📦 Existencias"], ["compras", "🧾 Compras"], ["historial", "📜 Historial"]];
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Inventario</h2>
      <div class="chips acc-tabs" id="invTabs">${tabs.map(([k, l]) => `<button data-sub="${k}" class="${inv.sub === k ? "active" : ""}">${l}</button>`).join("")}</div>
      <button class="btn btn-ghost" id="invAdjustBtn">± Ajuste manual</button>
      <button class="btn" id="invBuyBtn">+ NUEVA COMPRA</button>
    </div>
    <div id="invBody"></div>`;
  view.querySelector("#invTabs").onclick = e => {
    const b = e.target.closest("[data-sub]");
    if (!b || b.dataset.sub === inv.sub) return;
    inv.sub = b.dataset.sub;
    view.querySelectorAll("#invTabs [data-sub]").forEach(x => x.classList.toggle("active", x === b));
    renderBody();
  };
  view.querySelector("#invBuyBtn").onclick = () => openPurchaseModal("");
  view.querySelector("#invAdjustBtn").onclick = () => openAdjustModal("");
  renderBody();
}

function renderBody() {
  const body = $("#invBody");
  if (!body) return;
  inv.token++;
  if (!ready()) { body.innerHTML = spinner; return; }
  ({ existencias: renderStock, compras: renderPurchases, historial: renderHistory })[inv.sub](body);
}

/** Repinta solo los datos (sin perder lo que se escribe en los filtros). */
function refresh() {
  const body = $("#invBody");
  if (!body) return;
  if (!ready()) { body.innerHTML = spinner; return; }
  if (!body.querySelector("[data-inv-ready]")) { renderBody(); return; }
  if (inv.sub === "existencias") paintStock();
  else reloadMoves();
}

// =====================================================================
// EXISTENCIAS
// =====================================================================
const STATUS_ORDER = { agotado: 0, bajo: 1, ok: 2, none: 3 };
const statusPill = st => `<span class="st-pill st-${st}">${esc(S.STATUS[st] || "")}</span>`;

function renderStock(body) {
  const kinds = [["", "Todos"], ["supplies", "Materias primas e insumos"], ["extras", "Extras"], ["sides", "Acompañantes"], ["granizados", "Granizados"]];
  body.innerHTML = `
    <div data-inv-ready></div>
    <div class="kpis" id="invKpis"></div>
    <div id="invLowBox"></div>
    <div class="toolbar inv-filters">
      <input id="invQ" class="acc-search" type="search" placeholder="Buscar artículo o proveedor…" value="${esc(inv.q)}">
      <select id="invSt" class="acc-select" aria-label="Estado">
        <option value="">Todos los estados</option>
        ${Object.entries(S.STATUS).map(([k, l]) => `<option value="${k}" ${inv.status === k ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      <span class="spacer"></span>
      <select id="invNew" class="acc-select" aria-label="Nuevo artículo">
        <option value="">+ Nuevo artículo…</option>
        <option value="supplies">Materia prima / insumo</option>
        <option value="extras">Extra</option>
        <option value="sides">Acompañante</option>
      </select>
    </div>
    <div class="chips inv-kinds" id="invKinds">${kinds.map(([k, l]) => `<button data-kind="${k}" class="${inv.kind === k ? "active" : ""}">${l}</button>`).join("")}</div>
    <div id="invTable"></div>
    <div id="invGz"></div>`;
  body.querySelector("#invQ").addEventListener("input", e => { inv.q = e.target.value; paintStock(); });
  body.querySelector("#invSt").addEventListener("change", e => { inv.status = e.target.value; paintStock(); });
  body.querySelector("#invKinds").addEventListener("click", e => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    inv.kind = b.dataset.kind;
    body.querySelectorAll("#invKinds [data-kind]").forEach(x => x.classList.toggle("active", x === b));
    paintStock();
  });
  body.querySelector("#invNew").addEventListener("change", e => {
    const k = e.target.value;
    e.target.value = "";
    if (k === "supplies") Kit.openSupplyModal(null);
    else if (k === "extras") Kit.openExtraModal?.(null);
    else if (k === "sides") Kit.openSideModal(null);
  });
  body.addEventListener("click", e => {
    const b = e.target.closest("[data-inv]");
    if (!b) return;
    const key = b.dataset.key;
    if (b.dataset.inv === "buy") openPurchaseModal(key);
    else if (b.dataset.inv === "adjust") openAdjustModal(key);
    else if (b.dataset.inv === "edit") openArticleModal(key);
    else if (b.dataset.inv === "low") { inv.status = b.dataset.st; body.querySelector("#invSt").value = inv.status; paintStock(); }
  });
  paintStock();
}

function paintStock() {
  if (!$("#invTable")) return;
  const all = articles();
  const tracked = all.filter(a => a.tracked);
  const low = all.filter(a => a.status === "bajo");
  const out = all.filter(a => a.status === "agotado");
  const value = tracked.reduce((s, a) => s + (a.stock > 0 && Number.isFinite(a.cost) ? a.stock * a.cost : 0), 0);
  $("#invKpis").innerHTML = `
    <div class="kpi"><span>Artículos con control</span><b>${tracked.length} / ${all.length}</b></div>
    <div class="kpi ${low.length ? "warn" : "good"}"><span>Bajo stock</span><b>${low.length}</b><small>llegaron al mínimo</small></div>
    <div class="kpi ${out.length ? "warn" : "good"}"><span>Agotados</span><b>${out.length}</b></div>
    <div class="kpi"><span>Valor del inventario</span><b>${money(value)}</b><small>stock × costo de compra actual</small></div>`;
  const alertList = [...out, ...low];
  $("#invLowBox").innerHTML = alertList.length ? `
    <div class="inv-alert">
      <b>⚠️ ${alertList.length} artículo${alertList.length === 1 ? " llegó" : "s llegaron"} al stock mínimo:</b>
      ${alertList.slice(0, 12).map(a => `<span>${esc(a.name)} <small>(${qtyTxt(a.stock, a.unit)})</small></span>`).join(" · ")}${alertList.length > 12 ? " …" : ""}
      <button class="link" data-inv="low" data-st="${out.length ? "agotado" : "bajo"}">Ver</button>
    </div>` : "";

  // Tabla de artículos
  const showArticles = inv.kind !== "granizados";
  const q = normalize(inv.q);
  const list = all.filter(a =>
    (!inv.kind || a.col === inv.kind) &&
    (!inv.status || a.status === inv.status) &&
    (!q || normalize(`${a.name} ${a.sub} ${a.x.supplier || ""} ${kindLabel(a.col)}`).includes(q)))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name, "es"));
  $("#invTable").innerHTML = !showArticles ? "" : list.length ? `
    <div class="table-wrap"><table class="ctable inv-table">
      <thead><tr><th>Artículo · categoría</th><th>Unidad</th><th class="num">Stock actual</th><th class="num">Stock mínimo</th><th>Estado</th>
        <th class="num">Costo de compra actual</th><th>Último precio de compra</th><th>Proveedor</th><th></th></tr></thead>
      <tbody>${list.map(a => {
        const x = a.x;
        const lastAt = toDate(x.lastPurchaseAt);
        return `
        <tr class="${a.status === "agotado" ? "row-bad" : a.status === "bajo" ? "row-warn" : ""}">
          <td><b>${esc(a.name)}</b><div class="pk-sub">${esc(kindLabel(a.col))}${a.sub ? ` · ${esc(a.sub)}` : ""}</div></td>
          <td>${esc(a.unit)}</td>
          <td class="num nowrap">${a.tracked ? `<b class="${a.stock < 0 ? "neg-val" : ""}">${C.qty(a.stock)}</b> <small>${esc(a.unit)}</small>` : "—"}</td>
          <td class="num nowrap">${a.tracked && a.min ? `${C.qty(a.min)} <small>${esc(a.unit)}</small>` : "—"}</td>
          <td>${statusPill(a.status)}</td>
          <td class="num nowrap">${Number.isFinite(a.cost) ? `${moneyDec(a.cost)} <small>/ ${esc(a.unit)}</small>` : `<small class="err-tag">sin costo</small>`}</td>
          <td class="nowrap">${Number.isFinite(Number(x.lastPurchasePrice)) && x.lastPurchasePrice !== null && x.lastPurchasePrice !== undefined
            ? `${moneyDec(Number(x.lastPurchasePrice))} <small>/ ${esc(x.lastPurchaseUnit || a.unit)}</small>${lastAt ? `<div class="pk-sub">${dateLabel(lastAt)}</div>` : ""}`
            : `<small class="muted-tag">sin compras</small>`}</td>
          <td>${esc(x.supplier || "—")}</td>
          <td class="inv-acts">
            <button class="btn btn-ghost btn-xs" data-inv="buy" data-key="${esc(a.key)}" title="Registrar una compra">Comprar</button>
            <button class="btn btn-ghost btn-xs" data-inv="adjust" data-key="${esc(a.key)}" title="Entrada, salida o conteo">Ajustar</button>
            <button class="btn ${a.tracked ? "btn-ghost" : ""} btn-xs" data-inv="edit" data-key="${esc(a.key)}">${a.tracked ? "Editar" : "Activar"}</button>
          </td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${list.some(a => !a.tracked) ? `<p class="subtle">“Sin control”: el artículo no descuenta stock al venderse. Actívalo con “Activar” o registrando una compra.</p>` : ""}`
    : `<div class="empty-box">${all.length ? "Ningún artículo coincide con los filtros." : "Aún no hay artículos. Crea insumos en Costeo, extras en Extras o acompañantes en Acompañantes."}</div>`;

  // Granizados (no tienen stock propio: dependen de sus ingredientes)
  const showGz = (!inv.kind || inv.kind === "granizados") && !inv.status;
  if (!showGz) { $("#invGz").innerHTML = ""; return; }
  const gz = granizadoRows().filter(r => !q || normalize(`${r.p.name} ${r.s.name}`).includes(q));
  const gzStatus = st => (st === "norecipe" ? `<span class="st-pill st-none">Sin receta</span>` : statusPill(st));
  $("#invGz").innerHTML = `
    <h3 class="sub-title">🍧 Granizados <small>se elaboran al momento: su disponibilidad depende del stock de los ingredientes de la receta</small></h3>
    ${gz.length ? `
    <div class="table-wrap"><table class="ctable inv-table">
      <thead><tr><th>Granizado · tamaño</th><th class="num">Se pueden preparar</th><th>Ingrediente que limita</th><th>Ingredientes con bajo stock</th><th>Estado</th></tr></thead>
      <tbody>${gz.map(r => `
        <tr class="${r.status === "agotado" ? "row-bad" : r.status === "bajo" ? "row-warn" : ""}">
          <td><b>${esc(r.p.name)}</b> <small class="size-tag">${esc(r.s.name)}</small>${r.p.active === false ? ` <small class="muted-tag">inactivo</small>` : ""}</td>
          <td class="num">${Number.isFinite(r.possible) ? `<b>${r.possible.toLocaleString("es-CO")}</b> <small>vaso${r.possible === 1 ? "" : "s"}</small>` : "—"}</td>
          <td>${r.limiting ? esc(r.limiting.name) : "—"}</td>
          <td>${r.low.length ? esc(r.low.join(", ")) : "—"}</td>
          <td>${gzStatus(r.status)}</td>
        </tr>`).join("")}</tbody>
    </table></div>
    <p class="subtle">Cada venta pagada descuenta los ingredientes de su receta (y de los toppings elegidos). Solo cuentan los ingredientes con control de stock.</p>`
    : `<div class="empty-box">Aún no hay granizados.</div>`}`;
}

// =====================================================================
// NUEVA COMPRA
// =====================================================================
function articleOptions(selKey) {
  const list = articles();
  return `<option value="">— Elige un producto o insumo —</option>` + GROUPS.map(([col, label]) => {
    const items = list.filter(a => a.col === col);
    return items.length ? `<optgroup label="${esc(label)}">${items.map(a =>
      `<option value="${esc(a.key)}" ${a.key === selKey ? "selected" : ""}>${esc(a.name)}${a.tracked ? ` (hay ${C.qty(a.stock)} ${esc(a.unit)})` : ""}</option>`).join("")}</optgroup>` : "";
  }).join("");
}
/** Unidades en que se puede comprar un artículo. */
const buyUnits = a => (a.col === "supplies" ? C.compatibleUnits(a.x.purchaseUnit || a.unit) : [a.unit]);
function defaultBuyUnit(a) {
  const list = buyUnits(a);
  const last = a.x.lastPurchaseUnit;
  if (a.col === "supplies" && list.includes(last)) return last;
  if (a.col === "supplies" && list.includes(a.x.purchaseUnit)) return a.x.purchaseUnit;
  return list[0];
}

function openPurchaseModal(preKey) {
  if (!ready()) { toast("El inventario aún está cargando."); return; }
  if (!articles().length) { toast("Primero crea insumos (Costeo), extras o acompañantes.", { type: "error" }); return; }
  const today = dateKey(new Date());
  const newLine = (key = "") => {
    const a = key ? findArt(key) : null;
    return { key: a ? key : "", qty: "", unit: a ? defaultBuyUnit(a) : "", price: NaN, total: NaN, last: "price" };
  };
  const lines = [newLine(preKey)];

  Kit.openModal({
    title: "Nueva compra",
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>Fecha *</span><input type="date" id="pcDate" value="${today}" max="${today}"></label>
        <label class="field"><span>Proveedor</span>
          <input id="pcSupplier" maxlength="50" list="pcSuppliers" autocomplete="off">
          <datalist id="pcSuppliers">${suppliers().map(s => `<option value="${esc(s)}">`).join("")}</datalist></label>
      </div>
      <h4 class="cost-h">Productos / insumos comprados</h4>
      <div class="pc-head"><span>Producto / insumo</span><span>Cantidad comprada</span><span>Unidad</span><span>Precio unitario</span><span>Total</span><span></span></div>
      <div id="pcLines"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="pcAdd">+ Agregar otro producto</button>
      <div class="pm-total pc-total"><span>TOTAL DE LA COMPRA</span><strong id="pcTotal">$0</strong></div>
      <div class="form-grid pc-foot">
        <label class="check span2"><input type="checkbox" id="pcExpense" checked>
          <span><b>Registrar también como gasto en Contabilidad</b> <small>(tipo “Costo de ventas”, para no escribirlo dos veces)</small></span></label>
        <label class="field"><span>Forma de pago</span>
          <select id="pcPay">${Object.entries(PAY).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        <label class="field"><span>Nota</span><input id="pcNote" maxlength="120"></label>
      </div>
      <p class="field-hint">Al guardar: stock nuevo = stock anterior + cantidad comprada, y el costo de compra pasa a ser el de esta compra
        (el Costeo recalcula solo los granizados que usan cada insumo).</p>
      <p class="form-error" id="formError" hidden></p>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-ok" id="saveBtn">Guardar compra</button>`,
    onMount(root) {
      const box = root.querySelector("#pcLines");
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      const qtyOf = l => Kit.toNumber(l.qty);

      function lineHTML(l, i) {
        const a = l.key ? findArt(l.key) : null;
        const units = a ? buyUnits(a) : [];
        return `
          <div class="pc-line" data-i="${i}">
            <select data-f="key" aria-label="Producto o insumo">${articleOptions(l.key)}</select>
            <input data-f="qty" type="number" min="0" step="any" placeholder="0" value="${esc(l.qty)}" aria-label="Cantidad comprada">
            <select data-f="unit" aria-label="Unidad" ${a && units.length > 1 ? "" : "disabled"}>${units.map(u =>
              `<option value="${esc(u)}" ${u === l.unit ? "selected" : ""}>${esc(u)}</option>`).join("")}</select>
            <div class="money-input"><span>$</span><input data-f="price" inputmode="numeric" placeholder="0" value="${Number.isFinite(l.price) ? Kit.thousands(Math.round(l.price)) : ""}" aria-label="Precio unitario"></div>
            <div class="money-input"><span>$</span><input data-f="total" inputmode="numeric" placeholder="0" value="${Number.isFinite(l.total) ? Kit.thousands(l.total) : ""}" aria-label="Total"></div>
            <button type="button" class="icon-x small" data-f="del" aria-label="Quitar" ${lines.length <= 1 ? "disabled" : ""}>×</button>
            <div class="pc-hint" data-f="hint"></div>
          </div>`;
      }
      function renderLines() {
        box.innerHTML = lines.map(lineHTML).join("");
        lines.forEach((_, i) => paintLine(i));
        paintTotal();
      }
      function paintLine(i) {
        const l = lines[i];
        const row = box.querySelector(`.pc-line[data-i="${i}"]`);
        if (!row) return;
        const hint = row.querySelector('[data-f="hint"]');
        const a = l.key ? findArt(l.key) : null;
        if (!a) { hint.innerHTML = ""; return; }
        const q = qtyOf(l);
        const inStock = a.col === "supplies" ? S.convert(q, l.unit, a.unit) : q;
        const before = a.tracked ? a.stock : 0;
        const parts = [];
        if (q > 0 && Number.isFinite(l.total)) {
          const newCost = l.total / inStock;
          const old = a.cost;
          const diff = Number.isFinite(old) && old > 0 ? (newCost - old) / old * 100 : NaN;
          parts.push(`Costo: ${Number.isFinite(old) ? `${moneyDec(old)}/${esc(a.unit)} → ` : ""}<b>${moneyDec(newCost)}/${esc(a.unit)}</b>${Number.isFinite(diff) && Math.abs(diff) >= 0.05
            ? ` <span class="${diff > 0 ? "neg-val" : "pos-val"}">(${diff > 0 ? "+" : ""}${C.pct(diff)})</span>` : ""}`);
          if (a.col === "supplies" && l.unit !== a.unit) parts.push(`${moneyDec(l.total / q)}/${esc(l.unit)}`);
        }
        if (q > 0 && Number.isFinite(inStock)) {
          parts.push(`Stock: ${qtyTxt(before, a.unit)} → <b>${qtyTxt(S.roundQty(before + inStock), a.unit)}</b>${a.tracked ? "" : " <small>(se activa el control de stock)</small>"}`);
        }
        hint.innerHTML = parts.join(" · ");
      }
      function paintTotal() {
        const t = lines.reduce((s, l) => s + (Number.isFinite(l.total) ? l.total : 0), 0);
        root.querySelector("#pcTotal").textContent = money(t);
      }
      const setInput = (row, f, v) => {
        const inp = row.querySelector(`[data-f="${f}"]`);
        if (inp && document.activeElement !== inp) inp.value = v;
      };
      /** Precio unitario ↔ total: se recalcula el que no se está escribiendo. */
      function recompute(i) {
        const l = lines[i];
        const row = box.querySelector(`.pc-line[data-i="${i}"]`);
        const q = qtyOf(l);
        if (l.last === "total") {
          l.price = q > 0 && Number.isFinite(l.total) ? l.total / q : NaN;
          setInput(row, "price", Number.isFinite(l.price) ? Kit.thousands(Math.round(l.price)) : "");
        } else {
          l.total = q > 0 && Number.isFinite(l.price) ? Math.round(q * l.price) : NaN;
          setInput(row, "total", Number.isFinite(l.total) ? Kit.thousands(l.total) : "");
        }
        paintLine(i);
        paintTotal();
      }

      box.addEventListener("input", e => {
        const row = e.target.closest(".pc-line");
        if (!row) return;
        const i = Number(row.dataset.i), l = lines[i], f = e.target.dataset.f;
        if (f === "qty") { l.qty = e.target.value; recompute(i); }
        if (f === "price" || f === "total") {
          const n = parseMoney(e.target.value);
          e.target.value = Number.isNaN(n) ? "" : Kit.thousands(n);
          l[f] = Number.isNaN(n) ? NaN : n;
          l.last = f;
          recompute(i);
        }
      });
      box.addEventListener("change", e => {
        const row = e.target.closest(".pc-line");
        if (!row) return;
        const i = Number(row.dataset.i), l = lines[i], f = e.target.dataset.f;
        if (f === "key") {
          const a = findArt(e.target.value);
          l.key = a ? a.key : "";
          l.unit = a ? defaultBuyUnit(a) : "";
          renderLines();
          box.querySelector(`.pc-line[data-i="${i}"] [data-f="qty"]`)?.focus();
        } else if (f === "unit") {
          l.unit = e.target.value;
          paintLine(i);
        }
      });
      box.addEventListener("click", e => {
        if (e.target.closest('[data-f="del"]') && lines.length > 1) {
          lines.splice(Number(e.target.closest(".pc-line").dataset.i), 1);
          renderLines();
        }
      });
      root.querySelector("#pcAdd").onclick = () => {
        lines.push(newLine());
        renderLines();
        box.querySelector(`.pc-line[data-i="${lines.length - 1}"] [data-f="key"]`)?.focus();
      };
      root.querySelector("#pcExpense").addEventListener("change", e => { root.querySelector("#pcPay").disabled = !e.target.checked; });
      renderLines();
      if (!preKey) setTimeout(() => box.querySelector('[data-f="key"]')?.focus(), 50);
      else setTimeout(() => box.querySelector('[data-f="qty"]')?.focus(), 50);

      saveBtn.onclick = async () => {
        const fail = msg => { errEl.textContent = msg; errEl.hidden = false; };
        const dateStr = root.querySelector("#pcDate").value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return fail("Elige la fecha de la compra.");
        if (dateStr > dateKey(new Date())) return fail("La fecha no puede ser futura.");
        const supplier = root.querySelector("#pcSupplier").value.trim().replace(/\s+/g, " ");
        const note = root.querySelector("#pcNote").value.trim();
        const asExpense = root.querySelector("#pcExpense").checked;
        const payment = PAY[root.querySelector("#pcPay").value] ? root.querySelector("#pcPay").value : "otro";
        const valid = [];
        const seen = new Set();
        for (const [i, l] of lines.entries()) {
          const a = l.key ? findArt(l.key) : null;
          const n = i + 1;
          if (!a) return fail(`Línea ${n}: elige el producto o insumo.`);
          if (seen.has(a.key)) return fail(`"${a.name}" está dos veces. Suma las cantidades en una sola línea.`);
          seen.add(a.key);
          const q = qtyOf(l);
          if (!(q > 0)) return fail(`${a.name}: escribe la cantidad comprada (mayor a 0).`);
          if (a.col === "supplies" && !Number.isFinite(S.convert(q, l.unit, a.unit))) return fail(`${a.name}: la unidad ${l.unit} no es compatible con ${a.unit}.`);
          if (!isValidPrice(l.total)) return fail(`${a.name}: escribe el precio unitario o el total.`);
          valid.push({ ...a, qty: q, buyUnit: a.col === "supplies" ? l.unit : a.unit, total: l.total });
        }
        errEl.hidden = true;
        const [y, m, d] = dateStr.split("-").map(Number);
        const when = dateStr === dateKey(new Date()) ? new Date() : new Date(y, m - 1, d, 12, 0);
        const dateTs = Timestamp.fromDate(when);
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<span class="spinner"></span> Guardando…`;
        try {
          const res = await runTransaction(db, async tx => {
            // Lecturas
            const snaps = await Promise.all(valid.map(l => tx.get(doc(db, l.col, l.id))));
            // Escrituras
            const moveRef = doc(collection(db, COL.inventoryMoves));
            const moveLines = [];
            const expenseIds = [];
            let older = 0;
            valid.forEach((l, i) => {
              const snap = snaps[i];
              if (!snap.exists()) throw new Error(`"${l.name}" ya no existe.`);
              const x = snap.data();
              const unit = S.stockUnit(l.col, x);
              const inQty = S.roundQty(l.col === "supplies" ? S.convert(l.qty, l.buyUnit, unit) : l.qty);
              if (!(inQty > 0)) throw new Error(`Revisa la unidad de "${x.name}".`);
              const before = S.isTracked(x) ? S.stockOf(x) : 0;
              const after = S.roundQty(before + inQty);
              const prevCost = S.unitCost(l.col, x);
              const unitPrice = round2(l.total / l.qty);
              const upd = { stock: after, trackStock: true };
              if (l.col === "supplies") upd.stockUnit = unit;
              // Si ya hay una compra con fecha posterior, esta (atrasada) solo suma stock
              const lastAt = toDate(x.lastPurchaseAt);
              if (lastAt && lastAt > when) {
                older++;
              } else {
                Object.assign(upd, {
                  lastPurchasePrice: unitPrice, lastPurchaseUnit: l.buyUnit, lastPurchaseQty: l.qty, lastPurchaseAt: dateTs,
                  ...(supplier ? { supplier } : {}),
                  updatedAt: serverTimestamp()
                });
                // El costo que usa el Costeo pasa a ser el de esta compra
                if (l.col === "supplies") Object.assign(upd, { purchaseQty: l.qty, purchaseUnit: l.buyUnit, purchasePrice: l.total });
                else upd.unitCost = Math.round(l.total / l.qty);
              }
              tx.update(doc(db, l.col, l.id), upd);
              const newCost = S.unitCost(l.col, { ...x, ...upd });
              moveLines.push({
                col: l.col, id: l.id, name: x.name || "", qty: inQty, unit, before, after,
                purchaseQty: l.qty, purchaseUnit: l.buyUnit, unitPrice, total: l.total,
                prevCost: Number.isFinite(prevCost) ? round2(prevCost) : null,
                newCost: Number.isFinite(newCost) ? round2(newCost) : null
              });
              if (asExpense && l.total > 0) {
                const ref = doc(collection(db, COL.expenses));
                expenseIds.push(ref.id);
                tx.set(ref, {
                  dateKey: dateStr, date: dateTs, type: "costo",
                  category: l.col === "supplies" ? (C.isPackaging(x) ? "Empaques y desechables" : "Insumos y materia prima")
                    : l.col === "extras" ? "Mercancía para extras" : "Mercancía para acompañantes",
                  concept: `Compra ${x.name} · ${C.qty(l.qty)} ${l.buyUnit}`.slice(0, 60),
                  supplier, amount: l.total, paymentMethod: payment,
                  note: note || "Registrado desde Inventario", source: "inventario", moveId: moveRef.id,
                  createdAt: serverTimestamp(), updatedAt: serverTimestamp()
                });
              }
            });
            const total = valid.reduce((s, l) => s + l.total, 0);
            tx.set(moveRef, {
              type: "compra", ref: "Compra", supplier, note, paymentMethod: payment, total,
              date: dateTs, createdAt: serverTimestamp(), lines: moveLines, expenseIds
            });
            return { total, n: moveLines.length, older, expenses: expenseIds.length };
          });
          Kit.closeModal();
          toast(`Compra registrada · ${money(res.total)} · ${res.n} artículo${res.n === 1 ? "" : "s"}${res.expenses ? " · gasto en Contabilidad" : ""}${res.older ? ` · ${res.older} con compra más reciente (su costo no cambió)` : ""}`,
            { type: "ok", duration: 6000 });
        } catch (err) {
          console.error(err);
          fail(err.message && !err.code ? err.message : friendlyError(err));
          saveBtn.disabled = false;
          saveBtn.textContent = "Guardar compra";
        }
      };
    }
  });
}

// =====================================================================
// AJUSTE MANUAL (entrada, salida, conteo físico)
// =====================================================================
const ADJ_TYPES = {
  entrada: { label: "Entrada (+)", hint: "Suma al stock: inventario inicial, devolución, traslado…" },
  salida: { label: "Salida / merma (−)", hint: "Resta del stock: merma, daño, vencido, consumo interno…" },
  ajuste: { label: "Conteo físico (=)", hint: "Escribe lo que hay realmente: el stock queda en ese valor." }
};

function openAdjustModal(preKey) {
  if (!ready()) { toast("El inventario aún está cargando."); return; }
  if (!articles().length) { toast("Primero crea insumos (Costeo), extras o acompañantes.", { type: "error" }); return; }
  let key = findArt(preKey) ? preKey : "";
  let type = "entrada";
  let unit = key ? findArt(key).unit : "";
  Kit.openModal({
    title: "Ajuste manual de inventario",
    body: `
      <div class="form-grid one">
        <label class="field"><span>Producto / insumo *</span><select id="adjKey">${articleOptions(key)}</select></label>
        <div class="field"><span>Tipo de movimiento</span>
          <div class="seg seg3" id="adjType">${Object.entries(ADJ_TYPES).map(([k, t]) => `<button type="button" data-t="${k}" class="${k === type ? "active" : ""}">${t.label}</button>`).join("")}</div>
          <small class="field-hint" id="adjHint"></small></div>
        <div class="two-cols">
          <label class="field"><span id="adjQtyLabel">Cantidad *</span><input id="adjQty" type="number" min="0" step="any" placeholder="0"></label>
          <label class="field"><span>Unidad</span><select id="adjUnit"></select></label>
        </div>
        <label class="field"><span>Motivo</span>
          <input id="adjNote" maxlength="80" list="adjReasons" autocomplete="off">
          <datalist id="adjReasons">${REASONS.map(r => `<option value="${esc(r)}">`).join("")}</datalist></label>
        <div class="sup-preview" id="adjPreview"></div>
        <p class="form-error" id="formError" hidden></p>
      </div>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar ajuste</button>`,
    onMount(root) {
      const q = sel => root.querySelector(sel);
      const errEl = q("#formError");
      const fillUnits = () => {
        const a = findArt(key);
        const list = a ? (a.col === "supplies" ? C.compatibleUnits(a.unit) : [a.unit]) : [];
        if (!list.includes(unit)) unit = a ? a.unit : "";
        q("#adjUnit").innerHTML = list.map(u => `<option value="${esc(u)}" ${u === unit ? "selected" : ""}>${esc(u)}</option>`).join("");
        q("#adjUnit").disabled = list.length <= 1;
      };
      const compute = () => {
        const a = findArt(key);
        const n = Kit.toNumber(q("#adjQty").value);
        if (!a || !(n >= 0) || q("#adjQty").value === "") return { a, ok: false };
        const inStock = S.convert(n, unit, a.unit);
        const qty = a.col === "supplies" ? inStock : n;
        if (!Number.isFinite(qty)) return { a, ok: false };
        const before = a.tracked ? a.stock : 0;
        const after = S.roundQty(type === "entrada" ? before + qty : type === "salida" ? before - qty : qty);
        return { a, ok: true, n, before, after };
      };
      const paint = () => {
        q("#adjHint").textContent = ADJ_TYPES[type].hint;
        q("#adjQtyLabel").textContent = type === "ajuste" ? "Cantidad real contada *" : "Cantidad *";
        q("#adjType").querySelectorAll("[data-t]").forEach(b => b.classList.toggle("active", b.dataset.t === type));
        const r = compute();
        if (!r.a) { q("#adjPreview").innerHTML = `<small>Elige el producto o insumo.</small>`; return; }
        q("#adjPreview").innerHTML = r.ok
          ? `Stock: ${qtyTxt(r.before, r.a.unit)} → <b class="${r.after < 0 ? "neg-val" : ""}">${qtyTxt(r.after, r.a.unit)}</b>${r.a.tracked ? "" : " <small>(se activa el control de stock)</small>"}`
          : `Stock actual: <b>${r.a.tracked ? qtyTxt(r.a.stock, r.a.unit) : "sin control"}</b>`;
      };
      q("#adjKey").addEventListener("change", e => { key = e.target.value; fillUnits(); paint(); q("#adjQty").focus(); });
      q("#adjType").addEventListener("click", e => {
        const b = e.target.closest("[data-t]");
        if (!b) return;
        type = b.dataset.t;
        if (type === "ajuste" && !q("#adjNote").value) q("#adjNote").value = "Conteo físico";
        paint();
      });
      q("#adjUnit").addEventListener("change", e => { unit = e.target.value; paint(); });
      q("#adjQty").addEventListener("input", paint);
      fillUnits();
      paint();
      setTimeout(() => (key ? q("#adjQty") : q("#adjKey")).focus(), 50);

      q("#saveBtn").onclick = async () => {
        const fail = msg => { errEl.textContent = msg; errEl.hidden = false; };
        const r = compute();
        if (!r.a) return fail("Elige el producto o insumo.");
        if (!r.ok) return fail("Escribe una cantidad válida.");
        if (type !== "ajuste" && !(r.n > 0)) return fail("La cantidad debe ser mayor a 0.");
        if (type === "salida" && r.after < 0) return fail(`La salida es mayor que el stock actual (${C.qty(r.before)} ${r.a.unit}).`);
        const note = q("#adjNote").value.trim();
        const btn = q("#saveBtn");
        btn.disabled = true;
        try {
          const res = await runTransaction(db, async tx => {
            const snap = await tx.get(doc(db, r.a.col, r.a.id));
            if (!snap.exists()) throw new Error("El artículo ya no existe.");
            const x = snap.data();
            const sUnit = S.stockUnit(r.a.col, x);
            const qty = r.a.col === "supplies" ? S.convert(r.n, unit, sUnit) : r.n;
            if (!Number.isFinite(qty)) throw new Error("Revisa la unidad.");
            const before = S.isTracked(x) ? S.stockOf(x) : 0;
            const after = S.roundQty(type === "entrada" ? before + qty : type === "salida" ? before - qty : qty);
            if (type === "salida" && after < 0) throw new Error(`La salida es mayor que el stock actual (${C.qty(before)} ${sUnit}).`);
            if (after === before && S.isTracked(x)) return { same: true };
            tx.update(doc(db, r.a.col, r.a.id), { stock: after, trackStock: true });
            tx.set(doc(collection(db, COL.inventoryMoves)), {
              type, ref: type === "ajuste" ? "Conteo físico" : type === "entrada" ? "Entrada manual" : "Salida manual",
              note, date: serverTimestamp(), createdAt: serverTimestamp(),
              lines: [{ col: r.a.col, id: r.a.id, name: x.name || "", qty: S.roundQty(after - before), unit: sUnit, before, after }]
            });
            return { same: false, after, unit: sUnit, name: x.name };
          });
          if (res.same) { btn.disabled = false; return fail("El stock ya tiene ese valor: no hay nada que ajustar."); }
          Kit.closeModal();
          toast(`${res.name}: stock ${C.qty(res.after)} ${res.unit}`, { type: "ok" });
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          fail(err.message && !err.code ? err.message : friendlyError(err));
        }
      };
    }
  });
}

// =====================================================================
// EDITAR ARTÍCULO (unidad, stock mínimo, proveedor, control y costo)
// =====================================================================
function openArticleModal(key) {
  const a = findArt(key);
  if (!a) return;
  const x = a.x;
  const isSup = a.col === "supplies";
  const wasTracked = a.tracked;
  const costVal = !isSup && x.unitCost !== null && x.unitCost !== undefined && Number(x.unitCost) >= 0 ? Kit.thousands(Math.round(Number(x.unitCost))) : "";
  Kit.openModal({
    title: `${wasTracked ? "Editar" : "Activar control de"} · ${a.name}`,
    wide: isSup,
    body: `
      ${isSup ? `<div class="art-sup">${Kit.supplyFieldsHTML(x)}</div>` : `
      <div class="form-grid">
        <div class="field span2"><span>${esc(kindLabel(a.col))}</span><b class="art-name">${esc(a.name)}</b></div>
        <label class="field"><span>Precio de compra${a.col === "sides" ? " o costo de preparación" : ""} (por unidad)</span>
          <div class="money-input"><span>$</span><input id="artCost" inputmode="numeric" placeholder="0" value="${costVal}"></div></label>
        <label class="field"><span>Cantidad / unidad</span>
          <input id="artUnit" maxlength="20" list="artUnits" value="${esc(x.unit || "und")}">
          <datalist id="artUnits">${S.COUNT_UNITS.map(u => `<option value="${esc(u)}">`).join("")}</datalist></label>
      </div>`}
      <fieldset class="fs art-fs">
        <legend>📦 Inventario</legend>
        <label class="switch big"><input type="checkbox" id="artTrack" checked><span></span><em>Controlar stock (descontar con cada venta)</em></label>
        <div class="form-grid art-grid">
          ${isSup ? `<label class="field"><span>Unidad del stock</span><select id="artStockUnit"></select></label>` : ""}
          <label class="field"><span>Stock mínimo <small class="art-u"></small></span>
            <input id="artMin" type="number" min="0" step="any" value="${a.min ? a.min : ""}" placeholder="0"></label>
          <label class="field"><span>Proveedor</span>
            <input id="artSupplier" maxlength="50" list="artSuppliers" value="${esc(x.supplier || "")}">
            <datalist id="artSuppliers">${suppliers().map(s => `<option value="${esc(s)}">`).join("")}</datalist></label>
          ${wasTracked
            ? `<div class="field"><span>Stock actual</span><b class="art-name">${qtyTxt(a.stock, a.unit)}</b><small class="field-hint">Cámbialo con NUEVA COMPRA o Ajuste manual.</small></div>`
            : `<label class="field"><span>Stock inicial (lo que hay hoy) <small class="art-u"></small></span>
                <input id="artInitial" type="number" min="0" step="any" placeholder="0"></label>`}
        </div>
        <small class="field-hint">Cuando el stock llega al mínimo, el artículo queda en “Bajo stock” y sale una alerta.</small>
      </fieldset>
      <p class="form-error" id="formError" hidden></p>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const q = sel => root.querySelector(sel);
      const errEl = q("#formError");
      const fields = isSup ? Kit.bindSupplyFields(q(".art-sup")) : null;
      if (!isSup) Kit.bindMoneyInput(q("#artCost"));
      let shownUnit = a.unit; // unidad en que se muestran el mínimo y el stock inicial
      const curPurchaseUnit = () => (fields ? fields.read().purchaseUnit || a.unit : a.unit);
      const fillStockUnits = () => {
        if (!isSup) { root.querySelectorAll(".art-u").forEach(el => { el.textContent = `(${q("#artUnit").value.trim() || "und"})`; }); return; }
        const list = C.compatibleUnits(curPurchaseUnit());
        const sel = q("#artStockUnit");
        const want = list.includes(sel.value) ? sel.value : list.includes(shownUnit) ? shownUnit : list[0];
        sel.innerHTML = list.map(u => `<option value="${esc(u)}" ${u === want ? "selected" : ""}>${esc(Kit.unitLabel(u))}</option>`).join("");
        onUnitChange();
      };
      // Al cambiar la unidad del stock, el mínimo escrito se convierte para no cambiar su cantidad real
      const onUnitChange = () => {
        if (!isSup) return;
        const nu = q("#artStockUnit").value;
        ["#artMin", "#artInitial"].forEach(sel => {
          const inp = q(sel);
          const v = inp ? Kit.toNumber(inp.value) : NaN;
          const conv = S.convert(v, shownUnit, nu);
          if (inp && Number.isFinite(conv)) inp.value = String(S.roundQty(conv));
        });
        shownUnit = nu;
        root.querySelectorAll(".art-u").forEach(el => { el.textContent = `(${nu})`; });
      };
      if (isSup) {
        q("#artStockUnit").innerHTML = `<option value="${esc(a.unit)}">${esc(a.unit)}</option>`;
        q("#artStockUnit").addEventListener("change", onUnitChange);
        q('[data-k="purchaseUnitSel"]').addEventListener("change", fillStockUnits);
        q('[data-k="purchaseUnitOther"]').addEventListener("input", fillStockUnits);
      } else {
        q("#artUnit").addEventListener("input", fillStockUnits);
      }
      fillStockUnits();

      q("#saveBtn").onclick = async () => {
        const fail = msg => { errEl.textContent = msg; errEl.hidden = false; };
        const track = q("#artTrack").checked;
        const minRaw = q("#artMin").value;
        const min = minRaw === "" ? 0 : Kit.toNumber(minRaw);
        if (!(min >= 0)) return fail("El stock mínimo debe ser 0 o mayor.");
        const initRaw = q("#artInitial") ? q("#artInitial").value : "";
        const initial = initRaw === "" ? 0 : Kit.toNumber(initRaw);
        if (!(initial >= 0)) return fail("El stock inicial debe ser 0 o mayor.");
        const supplier = q("#artSupplier").value.trim().replace(/\s+/g, " ");
        const upd = { minStock: S.roundQty(min), supplier, trackStock: track };
        if (isSup) {
          const s = fields.read();
          const err = fields.validate(s);
          if (err) return fail(err);
          Object.assign(upd, s);
        } else {
          const cost = parseMoney(q("#artCost").value);
          if (!Number.isNaN(cost) && !isValidPrice(cost)) return fail("El precio de compra no es válido.");
          upd.unitCost = Number.isNaN(cost) ? null : cost;
          upd.unit = q("#artUnit").value.trim().replace(/\s+/g, " ").slice(0, 20) || "und";
        }
        const btn = q("#saveBtn");
        btn.disabled = true;
        try {
          const res = await runTransaction(db, async tx => {
            const ref = doc(db, a.col, a.id);
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error("El artículo ya no existe.");
            const cur = snap.data();
            const out = { ...upd, updatedAt: serverTimestamp() };
            let warn = "";
            if (isSup) {
              const oldUnit = S.stockUnit("supplies", cur);
              const newUnit = C.compatibleUnits(upd.purchaseUnit).includes(shownUnit) ? shownUnit : upd.purchaseUnit;
              out.stockUnit = newUnit;
              if (S.isTracked(cur) && oldUnit !== newUnit) {
                const conv = S.convert(S.stockOf(cur), oldUnit, newUnit);
                if (Number.isFinite(conv)) out.stock = S.roundQty(conv);
                else warn = `La unidad cambió de tipo: revisa el stock (ahora en ${newUnit}).`;
              }
            }
            const activating = track && !S.isTracked(cur);
            if (activating) {
              out.stock = S.roundQty(initial);
              if (initial > 0) {
                const unit = isSup ? out.stockUnit : upd.unit;
                tx.set(doc(collection(db, COL.inventoryMoves)), {
                  type: "entrada", ref: "Inventario inicial", note: "Al activar el control de stock",
                  date: serverTimestamp(), createdAt: serverTimestamp(),
                  lines: [{ col: a.col, id: a.id, name: (isSup ? upd.name : cur.name) || "", qty: S.roundQty(initial), unit, before: 0, after: S.roundQty(initial) }]
                });
              }
            }
            tx.update(ref, out);
            return { warn, activating };
          });
          Kit.closeModal();
          toast(res.warn || (res.activating ? "Control de stock activado" : "Artículo actualizado"), { type: res.warn ? "error" : "ok", duration: res.warn ? 6000 : 3000 });
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          fail(err.message && !err.code ? err.message : friendlyError(err));
        }
      };
    }
  });
}

// =====================================================================
// COMPRAS e HISTORIAL (movimientos por periodo)
// =====================================================================
function periodForm(extra) {
  const today = dateKey(new Date());
  return `
    <div data-inv-ready></div>
    <form class="panel acc-filter" id="invPeriod">
      <label class="field"><span>Desde</span><input type="date" id="invFrom" value="${esc(inv.from)}" max="${today}"></label>
      <label class="field"><span>Hasta</span><input type="date" id="invTo" value="${esc(inv.to)}" max="${today}"></label>
      <button class="btn" type="submit">Consultar</button>
      <span class="spacer"></span>
      ${extra}
    </form>
    <div id="invOut">${spinner}</div>`;
}

function bindPeriod(body) {
  body.querySelector("#invPeriod").addEventListener("submit", e => {
    e.preventDefault();
    const from = body.querySelector("#invFrom").value, to = body.querySelector("#invTo").value;
    if (!from || !to || from > to) { toast("Revisa el rango de fechas.", { type: "error" }); return; }
    inv.from = from; inv.to = to;
    inv.moves = null;
    reloadMoves();
  });
}

let movesTimer = null;
function reloadMoves() {
  clearTimeout(movesTimer);
  movesTimer = setTimeout(loadMoves, 80);
}

async function loadMoves() {
  if (!$("#invOut")) return;
  const token = ++inv.token;
  const key = `${inv.from}|${inv.to}`;
  try {
    const from = Timestamp.fromDate(ymd(inv.from));
    const to = Timestamp.fromDate(new Date(ymd(inv.to).getTime() + 86400000));
    const snap = await getDocs(query(collection(db, COL.inventoryMoves),
      where("date", ">=", from), where("date", "<", to), orderBy("date", "desc"), limit(3000)));
    if (token !== inv.token) return;
    inv.moves = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    inv.movesKey = key;
  } catch (err) {
    console.error(err);
    if ($("#invOut")) $("#invOut").innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
    return;
  }
  if (inv.sub === "compras") paintPurchases();
  else if (inv.sub === "historial") paintHistory();
}

function renderPurchases(body) {
  body.innerHTML = periodForm("");
  bindPeriod(body);
  loadMoves();
}

function paintPurchases() {
  const out = $("#invOut");
  if (!out || !inv.moves) return;
  const list = inv.moves.filter(m => m.type === "compra");
  const total = list.reduce((s, m) => s + (m.total || 0), 0);
  const bySupplier = new Map();
  list.forEach(m => { const k = m.supplier || "Sin proveedor"; bySupplier.set(k, (bySupplier.get(k) || 0) + (m.total || 0)); });
  const top = [...bySupplier.entries()].sort((a, b) => b[1] - a[1])[0];
  out.innerHTML = `
    <div class="kpis">
      <div class="kpi warn"><span>Total comprado</span><b>${money(total)}</b><small>${list.length} compra${list.length === 1 ? "" : "s"}</small></div>
      <div class="kpi"><span>Artículos comprados</span><b>${list.reduce((s, m) => s + (m.lines || []).length, 0)}</b></div>
      <div class="kpi"><span>Proveedor principal</span><b>${top ? esc(top[0]) : "—"}</b><small>${top ? money(top[1]) : ""}</small></div>
    </div>
    ${list.length ? `
    <div class="table-wrap"><table class="ctable inv-table">
      <thead><tr><th>Fecha</th><th>Proveedor</th><th>Producto / insumo</th><th class="num">Cantidad</th><th class="num">Precio unitario</th><th>Costo anterior → nuevo</th><th class="num">Total</th></tr></thead>
      <tbody>${list.map(m => (m.lines || []).map((l, i) => `
        <tr class="${i ? "inv-cont" : "inv-first"}">
          ${i ? `<td></td><td></td>` : `<td class="nowrap">${dateLabel(toDate(m.date))}<div class="pk-sub">${timeLabel(toDate(m.date))}${m.paymentMethod ? ` · ${esc(PAY[m.paymentMethod] || "")}` : ""}</div></td>
            <td>${esc(m.supplier || "—")}${m.note ? `<div class="pk-sub">${esc(m.note)}</div>` : ""}${(m.expenseIds || []).length ? `<div class="pk-sub">✓ gasto en Contabilidad</div>` : ""}</td>`}
          <td><b>${esc(l.name)}</b></td>
          <td class="num">${qtyTxt(l.purchaseQty ?? l.qty, l.purchaseUnit || l.unit)}</td>
          <td class="num">${moneyDec(l.unitPrice)} <small>/ ${esc(l.purchaseUnit || l.unit)}</small></td>
          <td>${costChange(l)}</td>
          <td class="num"><b>${money(l.total)}</b></td>
        </tr>`).join("")).join("")}</tbody>
      <tfoot><tr><td colspan="6">TOTAL DEL PERIODO</td><td class="num">${money(total)}</td></tr></tfoot>
    </table></div>` : `<div class="empty-box">No hay compras en este periodo. Regístralas con <b>+ NUEVA COMPRA</b>.</div>`}`;
}

function costChange(l) {
  if (!Number.isFinite(l.newCost)) return "—";
  const unit = esc(l.unit);
  if (!Number.isFinite(l.prevCost) || Math.abs(l.prevCost - l.newCost) < 0.005) return `${moneyDec(l.newCost)}/${unit}`;
  const diff = l.prevCost > 0 ? (l.newCost - l.prevCost) / l.prevCost * 100 : NaN;
  return `${moneyDec(l.prevCost)} → <b>${moneyDec(l.newCost)}</b>/${unit}${Number.isFinite(diff)
    ? ` <small class="${diff > 0 ? "neg-val" : "pos-val"}">(${diff > 0 ? "+" : ""}${C.pct(diff)})</small>` : ""}`;
}

function renderHistory(body) {
  body.innerHTML = periodForm(`
    <input id="invHq" class="acc-search" type="search" placeholder="Buscar artículo, referencia…" value="${esc(inv.hq)}">
    <select id="invHtype" class="acc-select" aria-label="Tipo">
      <option value="">Todos los movimientos</option>
      ${Object.entries(S.MOVE_TYPES).map(([k, l]) => `<option value="${k}" ${inv.htype === k ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>`);
  bindPeriod(body);
  body.querySelector("#invHq").addEventListener("input", e => { inv.hq = e.target.value; paintHistory(); });
  body.querySelector("#invHtype").addEventListener("change", e => { inv.htype = e.target.value; paintHistory(); });
  loadMoves();
}

function paintHistory() {
  const out = $("#invOut");
  if (!out || !inv.moves) return;
  const q = normalize(inv.hq);
  const rows = inv.moves
    .filter(m => !inv.htype || m.type === inv.htype)
    .flatMap(m => (m.lines || []).map(l => ({ m, l })))
    .filter(({ m, l }) => !q || normalize(`${l.name} ${m.ref || ""} ${m.supplier || ""} ${m.note || ""}`).includes(q));
  const shown = rows.slice(0, MAX_ROWS);
  const count = t => inv.moves.filter(m => m.type === t).length;
  out.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Compras</span><b>${count("compra")}</b></div>
      <div class="kpi"><span>Salidas por ventas</span><b>${count("venta")}</b><small>${count("devolucion")} devuelta${count("devolucion") === 1 ? "" : "s"}</small></div>
      <div class="kpi"><span>Entradas y salidas manuales</span><b>${count("entrada") + count("salida")}</b></div>
      <div class="kpi"><span>Ajustes por conteo</span><b>${count("ajuste")}</b></div>
    </div>
    ${rows.length ? `
    <div class="table-wrap"><table class="ctable inv-table inv-hist">
      <thead><tr><th>Fecha</th><th>Movimiento</th><th>Referencia</th><th>Producto / insumo</th><th class="num">Cantidad</th><th>Stock anterior → nuevo</th><th class="num">Precio de compra</th><th>Proveedor</th></tr></thead>
      <tbody>${shown.map(({ m, l }) => {
        const d = toDate(m.date);
        return `
        <tr>
          <td class="nowrap">${dateLabel(d)} <small>${timeLabel(d)}</small></td>
          <td><span class="mv-tag mv-${esc(m.type)}">${esc(S.MOVE_TYPES[m.type] || m.type)}</span></td>
          <td>${esc(m.ref || "—")}${m.note ? `<div class="pk-sub">${esc(m.note)}</div>` : ""}</td>
          <td><b>${esc(l.name)}</b></td>
          <td class="num"><b class="${l.qty < 0 ? "neg-val" : "pos-val"}">${l.qty > 0 ? "+" : ""}${C.qty(l.qty)}</b> <small>${esc(l.unit)}</small></td>
          <td class="nowrap">${C.qty(l.before)} → <b class="${l.after < 0 ? "neg-val" : ""}">${C.qty(l.after)}</b> <small>${esc(l.unit)}</small></td>
          <td class="num">${Number.isFinite(l.unitPrice) ? `${moneyDec(l.unitPrice)} <small>/ ${esc(l.purchaseUnit || l.unit)}</small>` : "—"}</td>
          <td>${esc(m.supplier || "—")}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${rows.length > shown.length ? `<p class="subtle">Se muestran los ${MAX_ROWS} movimientos más recientes de ${rows.length}. Acota las fechas para ver el resto.</p>` : ""}`
    : `<div class="empty-box">No hay movimientos ${inv.hq || inv.htype ? "con esos filtros" : "en este periodo"}.</div>`}`;
}

Kit.registerTab("inventario", render);
})();
