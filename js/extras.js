// =====================================================================
// EXTRAS — bebidas, cocteles, dulces, snacks… Se venden directo en caja y,
// si se marca "Mostrar en la página de pedidos", el cliente también los pide
// desde la web: cada categoría sale como su propia sección (ej: "Cocteles").
// Vender (punto de venta) · Ventas (consulta y anulación) · Catálogo
// =====================================================================
(function () {
"use strict";

const {
  db, COL, PAYMENT_METHODS, PAYMENT_LABELS, money, parseMoney, isValidPrice, esc, normalize,
  dateKey, timeLabel, dateLabel, toDate, byDisplayOrder, friendlyError, toast, catalogSig
} = window.Core;
const {
  collection, doc, query, where, orderBy, limit, onSnapshot, getDocs, addDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp, call
} = window.Store;
const Kit = window.AdminKit;
const Stock = window.Stock;
const Costing = window.Costing;
const $ = sel => document.querySelector(sel);

const MAX_QTY = 99;
const round2 = n => Math.round(n * 100) / 100;
const knownCost = v => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

const ex = {
  list: [],
  ready: false,
  sub: "vender",          // vender | ventas | catalogo
  cart: [],               // [{ extraId, qty }]
  search: "",
  method: "efectivo",
  cash: "",
  customer: "",
  busy: false,
  today: [],              // ventas de hoy en tiempo real (indicadores del punto de venta)
  salesDate: dateKey(new Date()),
  sales: null
};

// ---------- Datos en tiempo real (después de iniciar sesión, si el rol tiene Extras) ----------
let listSig = null;
Kit.onAuth(() => { if (Kit.can("extras")) startListeners(); });
const isAdmin = () => Kit.user()?.role === "admin";
// Preparación solo activa / desactiva extras; vender y ver ventas es de admin y caja
const canSell = () => ["admin", "cajero"].includes(Kit.user()?.role);

function startListeners() {
  onSnapshot(collection(db, COL.extras), snap => {
    ex.list = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byCategoryThenOrder);
    ex.ready = true;
    Kit.emit("extras-stock"); // inventario: cambia con cada venta o compra
    // Si solo cambió el stock (una venta), no hace falta redibujar el punto de venta
    const sig = catalogSig(ex.list);
    if (sig === listSig) return;
    listSig = sig;
    // Quita del carrito lo que se desactivó o eliminó
    ex.cart = ex.cart.filter(r => isSellable(byId(r.extraId)));
    Kit.emit("extras");
    if (Kit.isTab("extras")) render();
  }, onError);

  if (!canSell()) return;
  const startOfToday = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  onSnapshot(query(collection(db, COL.extraSales), where("createdAt", ">=", Timestamp.fromDate(startOfToday()))), snap => {
    const today = dateKey(new Date());
    ex.today = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.dateKey === today);
    if (Kit.isTab("extras") && ex.sub === "vender") renderTodayKpis();
    if (Kit.isTab("extras") && ex.sub === "ventas" && ex.salesDate === today) loadSales();
  }, onError);
}

function onError(err) {
  console.error(err);
  toast(friendlyError(err), { type: "error", duration: 5000 });
}

function byCategoryThenOrder(a, b) {
  return String(a.category || "").localeCompare(String(b.category || ""), "es") || byDisplayOrder(a, b);
}
const byId = id => ex.list.find(x => x.id === id) || null;
const isSellable = x => !!x && x.active !== false && isValidPrice(x.price) && x.price > 0;
const cartLines = () => ex.cart.map(r => {
  const x = byId(r.extraId);
  return x ? { ...r, extra: x, subtotal: x.price * r.qty } : null;
}).filter(Boolean);
const cartTotal = () => cartLines().reduce((s, l) => s + l.subtotal, 0);
const qtyOf = id => ex.cart.find(r => r.extraId === id)?.qty || 0;

function setQty(id, qty) {
  const q = Math.max(0, Math.min(MAX_QTY, qty));
  const row = ex.cart.find(r => r.extraId === id);
  if (row && q === 0) ex.cart = ex.cart.filter(r => r !== row);
  else if (row) row.qty = q;
  else if (q > 0) ex.cart.push({ extraId: id, qty: q });
}

// =====================================================================
// RENDER
// =====================================================================
function render() {
  const view = $("#view-extras");
  if (!view) return;
  // El catálogo (precios de compra y venta) lo administra solo el admin
  // Preparación solo ve la lista para activar / desactivar
  const tabs = !canSell()
    ? [["catalogo", `📦 Disponibilidad (${ex.list.length})`]]
    : [["vender", "🛒 Vender"], ["ventas", "🧾 Ventas"], ...(isAdmin() ? [["catalogo", `📦 Catálogo (${ex.list.length})`]] : [])];
  if (!canSell()) ex.sub = "catalogo";
  else if (ex.sub === "catalogo" && !isAdmin()) ex.sub = "vender";
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Extras</h2>
      <div class="chips" id="exTabs">${tabs.map(([k, l]) => `<button data-sub="${k}" class="${ex.sub === k ? "active" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div id="exBody"></div>`;
  view.querySelector("#exTabs").onclick = e => {
    const b = e.target.closest("[data-sub]");
    if (b && b.dataset.sub !== ex.sub) { ex.sub = b.dataset.sub; render(); }
  };
  const body = view.querySelector("#exBody");
  if (!ex.ready) { body.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`; return; }
  ({ vender: renderPos, ventas: renderSales, catalogo: renderCatalog })[ex.sub](body);
}

// ---------- Punto de venta ----------
function renderPos(body) {
  const sellable = ex.list.filter(isSellable);
  body.innerHTML = `
    <div class="kpis ex-kpis" id="exKpis"></div>
    ${sellable.length ? `
    <div class="pos-layout">
      <div class="pos-main">
        <div class="search-wrap pos-search">
          <span class="search-icon">🔎</span>
          <input id="exSearch" class="search" type="search" autocomplete="off" placeholder="Buscar extra…" value="${esc(ex.search)}">
        </div>
        <div id="exGrid"></div>
      </div>
      <aside class="pos-ticket" id="exTicket"></aside>
    </div>` : `<div class="empty-box">No hay extras activos para vender.<br><br>
        <button class="btn" id="exGoCatalog">+ Crear extras en el catálogo</button></div>`}`;
  renderTodayKpis();
  const go = body.querySelector("#exGoCatalog");
  if (go) {
    if (isAdmin()) go.onclick = () => { ex.sub = "catalogo"; render(); };
    else go.replaceWith(Object.assign(document.createElement("small"), { textContent: "El administrador debe crear los extras." }));
    return;
  }

  const search = body.querySelector("#exSearch");
  search.addEventListener("input", () => { ex.search = search.value; renderGrid(); });
  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { search.value = ""; ex.search = ""; renderGrid(); }
    if (e.key === "Enter") {
      const first = body.querySelector("#exGrid [data-add]");
      if (first) { first.click(); search.select(); }
    }
  });
  body.querySelector("#exGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    const id = b.dataset.add;
    if (qtyOf(id) >= MAX_QTY) return;
    setQty(id, qtyOf(id) + 1);
    renderGrid();
    renderTicket();
  });
  renderGrid();
  renderTicket();
  if (window.matchMedia("(min-width: 700px)").matches) search.focus();
}

function renderTodayKpis() {
  const box = $("#exKpis");
  if (!box) return;
  const ok = ex.today.filter(s => !s.voided);
  const sum = list => list.reduce((s, x) => s + (x.total || 0), 0);
  const units = ok.reduce((s, x) => s + (x.itemCount || 0), 0);
  box.innerHTML = `
    <div class="kpi good"><span>Vendido hoy</span><b>${money(sum(ok))}</b><small>${ok.length} venta${ok.length === 1 ? "" : "s"} · ${units} und</small></div>
    <div class="kpi"><span>💵 Efectivo</span><b>${money(sum(ok.filter(s => s.paymentMethod === "efectivo")))}</b></div>
    <div class="kpi"><span>📲 Transferencia</span><b>${money(sum(ok.filter(s => s.paymentMethod === "transferencia")))}</b></div>`;
}

function renderGrid() {
  const grid = $("#exGrid");
  if (!grid) return;
  const q = normalize(ex.search);
  const list = ex.list.filter(isSellable).filter(x => !q || normalize(`${x.name} ${x.category || ""}`).includes(q));
  if (!list.length) { grid.innerHTML = `<div class="empty-box">Ningún extra coincide con “${esc(ex.search)}”.</div>`; return; }
  const groups = new Map();
  list.forEach(x => {
    const c = (x.category || "").trim() || "Otros";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(x);
  });
  grid.innerHTML = [...groups].map(([cat, items]) => `
    <h4 class="pos-cat">${esc(cat)}</h4>
    <div class="pos-grid">
      ${items.map(x => {
        const q2 = qtyOf(x.id);
        return `
        <button type="button" class="pos-btn ${q2 ? "in" : ""}" data-add="${esc(x.id)}">
          <span class="pos-emoji">${esc(x.icon || "🛍️")}</span>
          <b>${esc(x.name)}</b>
          <span class="pos-price">${money(x.price)}</span>
          ${q2 ? `<em class="pos-qty">${q2}</em>` : ""}
        </button>`;
      }).join("")}
    </div>`).join("");
}

function renderTicket() {
  const box = $("#exTicket");
  if (!box) return;
  const lines = cartLines();
  const total = cartTotal();
  const cash = parseMoney(ex.cash);
  box.innerHTML = `
    <div class="tk-title">Venta actual ${lines.length ? `<button class="link" id="exClear">Vaciar</button>` : ""}</div>
    ${lines.length ? `
      <div class="tk-lines">
        ${lines.map(l => `
          <div class="tk-line">
            <div class="tk-name"><b>${esc(l.extra.name)}</b><small>${money(l.extra.price)} c/u</small></div>
            <div class="tk-qty">
              <button type="button" data-dec="${esc(l.extraId)}" aria-label="Quitar uno">−</button>
              <span>${l.qty}</span>
              <button type="button" data-inc="${esc(l.extraId)}" aria-label="Agregar uno" ${l.qty >= MAX_QTY ? "disabled" : ""}>+</button>
            </div>
            <b class="tk-sub">${money(l.subtotal)}</b>
          </div>`).join("")}
      </div>` : `<div class="tk-empty">Sin productos.</div>`}
    <div class="pm-total"><span>TOTAL</span><strong>${money(total)}</strong></div>
    <label class="field"><span>Cliente (opcional)</span>
      <input id="exCustomer" maxlength="30" autocomplete="off" value="${esc(ex.customer)}" placeholder="Nombre"></label>
    <div class="seg" role="group" aria-label="Forma de pago">
      ${PAYMENT_METHODS.map(m => `<button type="button" data-m="${m}" class="${m === ex.method ? "active" : ""}">${m === "efectivo" ? "💵" : "📲"} ${PAYMENT_LABELS[m].toUpperCase()}</button>`).join("")}
    </div>
    ${ex.method === "efectivo" ? `
      <label class="field"><span>EFECTIVO RECIBIDO</span>
        <div class="money-input"><span>$</span><input id="exCash" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(ex.cash)}"></div></label>
      ${total ? `<div class="quick">${Kit.quickAmounts(total).map(v => `<button type="button" data-q="${v}">${v === total ? "Exacto" : money(v)}</button>`).join("")}</div>` : ""}
      <div class="pm-change"><span>CAMBIO</span><strong id="exChange">${Number.isInteger(cash) && total && cash >= total ? money(cash - total) : "—"}</strong></div>
      <p class="pm-error" id="exCashErr" ${Number.isInteger(cash) && cash < total ? "" : "hidden"}>El valor recibido es menor al total.</p>
    ` : `<div class="pm-transfer"><p><b>Verifica que la transferencia por ${money(total)} fue recibida</b>.</p></div>`}
    <button type="button" class="btn btn-ok btn-lg btn-block" id="exCharge" ${canCharge() ? "" : "disabled"}>
      ${ex.busy ? `<span class="spinner"></span> Guardando…` : `COBRAR ${money(total)}`}</button>`;

  box.querySelector("#exClear")?.addEventListener("click", () => { clearSale(); });
  box.querySelectorAll("[data-inc],[data-dec]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.inc || b.dataset.dec;
    setQty(id, qtyOf(id) + (b.dataset.inc ? 1 : -1));
    renderGrid();
    renderTicket();
  }));
  box.querySelector("#exCustomer").addEventListener("input", e => { ex.customer = e.target.value; });
  box.querySelector(".seg").addEventListener("click", e => {
    const b = e.target.closest("[data-m]");
    if (!b || b.dataset.m === ex.method) return;
    ex.method = b.dataset.m;
    renderTicket();
  });
  const cashInput = box.querySelector("#exCash");
  if (cashInput) {
    Kit.bindMoneyInput(cashInput, () => { ex.cash = cashInput.value; updateChange(); });
    cashInput.addEventListener("keydown", e => { if (e.key === "Enter") charge(); });
    box.querySelector(".quick")?.addEventListener("click", e => {
      const b = e.target.closest("[data-q]");
      if (!b) return;
      ex.cash = Kit.thousands(Number(b.dataset.q));
      cashInput.value = ex.cash;
      updateChange();
    });
  }
  box.querySelector("#exCharge").addEventListener("click", charge);
}

function canCharge() {
  const total = cartTotal();
  if (ex.busy || !total) return false;
  if (ex.method !== "efectivo") return true;
  const c = parseMoney(ex.cash);
  return Number.isInteger(c) && c >= total;
}

function updateChange() {
  const total = cartTotal();
  const c = parseMoney(ex.cash);
  const ok = Number.isInteger(c) && total > 0 && c >= total;
  $("#exChange").textContent = ok ? money(c - total) : "—";
  $("#exCashErr").hidden = !(Number.isInteger(c) && c < total);
  $("#exCharge").disabled = !canCharge();
}

function clearSale() {
  ex.cart = [];
  ex.cash = "";
  ex.customer = "";
  renderGrid();
  renderTicket();
}

async function charge() {
  if (!canCharge()) return;
  const rows = ex.cart.map(r => ({ ...r }));
  const expected = cartTotal();
  const method = ex.method;
  const cash = method === "efectivo" ? parseMoney(ex.cash) : null;
  const customer = ex.customer.trim().replace(/\s+/g, " ").slice(0, 30);
  ex.busy = true;
  renderTicket();
  try {
    // El servidor lee precios y costos vigentes, numera la venta y descuenta el inventario
    const sale = await call("/api/gz/extra-sale", {
      rows, method, cashReceived: method === "efectivo" ? cash : null, customerName: customer, expectedTotal: expected
    });
    ex.busy = false;
    clearSale();
    toast(`Venta E-${sale.number} registrada · ${money(sale.total)}${sale.change ? ` · cambio ${money(sale.change)}` : ""}`, {
      type: "ok", duration: 7000,
      action: { label: "Anular", onClick: () => voidSale(sale.id, true) }
    });
  } catch (err) {
    console.error(err);
    ex.busy = false;
    renderTicket();
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error", duration: 5000 });
  }
}

async function voidSale(id, skipConfirm = false) {
  if (!skipConfirm && !confirm("¿Anular esta venta de extras?\n\nDejará de contar en caja y en contabilidad. Esta acción no se puede deshacer.")) return;
  try {
    await call("/api/gz/extra-void", { id });
    toast("Venta anulada");
    if (ex.sub === "ventas") loadSales();
  } catch (err) {
    toast(err.message && !err.code ? err.message : friendlyError(err), { type: "error" });
  }
}

// ---------- Ventas (consulta por día) ----------
function renderSales(body) {
  const today = dateKey(new Date());
  body.innerHTML = `
    <form class="panel ex-sales-form" id="exSalesForm">
      <label class="field"><span>Día</span><input id="exSalesDate" type="date" value="${esc(ex.salesDate)}" max="${today}"></label>
      <button class="btn" type="submit">Ver ventas</button>
    </form>
    <div id="exSalesOut"></div>`;
  body.querySelector("#exSalesForm").addEventListener("submit", e => {
    e.preventDefault();
    ex.salesDate = body.querySelector("#exSalesDate").value || today;
    loadSales();
  });
  body.querySelector("#exSalesOut").addEventListener("click", e => {
    const b = e.target.closest("[data-void]");
    if (b) voidSale(b.dataset.void);
  });
  loadSales();
}

async function loadSales() {
  const out = $("#exSalesOut");
  if (!out) return;
  const [y, m, d] = ex.salesDate.split("-").map(Number);
  if (!y) return;
  out.innerHTML = ex.sales ? out.innerHTML : `<div class="loading-screen"><div class="spinner dark"></div></div>`;
  try {
    const snap = await getDocs(query(collection(db, COL.extraSales),
      where("createdAt", ">=", Timestamp.fromDate(new Date(y, m - 1, d))),
      where("createdAt", "<", Timestamp.fromDate(new Date(y, m - 1, d + 1))),
      orderBy("createdAt", "desc"), limit(3000)));
    ex.sales = snap.docs.map(s => ({ id: s.id, ...s.data() }));
    renderSalesList();
  } catch (err) {
    console.error(err);
    out.innerHTML = `<div class="empty-box">${esc(friendlyError(err))}</div>`;
  }
}

function renderSalesList() {
  const out = $("#exSalesOut");
  if (!out) return;
  const sales = ex.sales || [];
  const ok = sales.filter(s => !s.voided);
  const sum = list => list.reduce((s, x) => s + (x.total || 0), 0);
  const byProduct = new Map();
  ok.forEach(s => (s.items || []).forEach(i => {
    const k = normalize(i.name);
    const r = byProduct.get(k) || { name: i.name, qty: 0, total: 0 };
    r.qty += i.quantity; r.total += i.subtotal;
    byProduct.set(k, r);
  }));
  const products = [...byProduct.values()].sort((a, b) => b.total - a.total);
  out.innerHTML = `
    <div class="kpis">
      <div class="kpi good"><span>Total vendido</span><b>${money(sum(ok))}</b><small>${ok.length} venta${ok.length === 1 ? "" : "s"}</small></div>
      <div class="kpi"><span>💵 Efectivo</span><b>${money(sum(ok.filter(s => s.paymentMethod === "efectivo")))}</b></div>
      <div class="kpi"><span>📲 Transferencia</span><b>${money(sum(ok.filter(s => s.paymentMethod === "transferencia")))}</b></div>
      <div class="kpi warn"><span>Anuladas</span><b>${sales.length - ok.length}</b><small>${money(sum(sales.filter(s => s.voided)))}</small></div>
    </div>
    ${products.length ? `
      <h3 class="sub-title">Resumen por producto</h3>
      <div class="table-wrap"><table class="ctable ex-table">
        <thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Total</th></tr></thead>
        <tbody>${products.map(p => `<tr><td><b>${esc(p.name)}</b></td><td class="num">${p.qty}</td><td class="num">${money(p.total)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td><b>TOTAL</b></td><td class="num"><b>${products.reduce((s, p) => s + p.qty, 0)}</b></td><td class="num"><b>${money(sum(ok))}</b></td></tr></tfoot>
      </table></div>` : ""}
    <h3 class="sub-title">Ventas del ${esc(dateLabel(new Date(ex.salesDate + "T12:00:00")))}</h3>
    ${sales.length ? `
      <div class="table-wrap"><table class="ctable ex-table">
        <thead><tr><th>#</th><th>Hora</th><th>Detalle</th><th>Cliente</th><th>Pago</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${sales.map(s => `
          <tr class="${s.voided ? "row-void" : ""}">
            <td><b>E-${s.number}</b></td>
            <td>${timeLabel(toDate(s.createdAt))}</td>
            <td>${(s.items || []).map(i => `${i.quantity} × ${esc(i.name)}`).join("<br>")}</td>
            <td class="pk-name">${esc(s.customerName || "—")}</td>
            <td>${esc(PAYMENT_LABELS[s.paymentMethod] || "")}${Number.isInteger(s.cashReceived) ? `<div class="pk-sub">Recibido ${money(s.cashReceived)} · cambio ${money(s.change)}</div>` : ""}</td>
            <td class="num"><b>${money(s.total)}</b></td>
            <td class="pk-act">${s.voided
              ? `<span class="pk-status out">ANULADA</span>`
              : `<button class="link danger-link" data-void="${esc(s.id)}">Anular</button>`}</td>
          </tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty-box">No hay ventas de extras ese día.</div>`}`;
}

// ---------- Catálogo ----------
function renderCatalog(body) {
  const admin = isAdmin();
  body.innerHTML = `
    ${admin ? `
    <div class="toolbar">
      <span class="grow"></span>
      <button class="btn" id="exNewBtn">+ Nuevo extra</button>
    </div>` : `<p class="muted">Solo puedes activar o desactivar extras. Crear y editar es del administrador.</p>`}
    ${ex.list.length ? `
    <div class="cat-list">
      ${ex.list.map(x => `
        <article class="cat-item small ${x.active === false ? "inactive" : ""}">
          <div class="ci-img">${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy">` : esc(x.icon || "🛍️")}</div>
          <div class="ci-main">
            <div class="ci-name">${esc(x.name)}</div>
            <div class="ci-meta">${esc(x.category || "Sin categoría")} · ${esc(x.unit || "und")} · Orden ${Number(x.order) || 0} · ${x.online !== false ? "🌐 En la página de pedidos" : "Solo en caja"}</div>
            <div class="ci-price">${money(x.price)}${!admin ? "" : Number.isFinite(x.unitCost)
              ? ` <small class="cost-tag ${x.unitCost > x.price ? "bad" : ""}">compra ${money(x.unitCost)} · margen bruto ${Costing.pct(Costing.itemCost(x).margin)}</small>`
              : ` <small class="cost-tag none">sin precio de compra</small>`}</div>
          </div>
          <div class="ci-actions">
            <label class="switch" title="Disponible para vender">
              <input type="checkbox" data-toggle-extra="${esc(x.id)}" ${x.active !== false ? "checked" : ""}>
              <span></span><em>${x.active !== false ? "Activo" : "Inactivo"}</em>
            </label>
            ${admin ? `<button class="btn btn-ghost btn-sm" data-edit-extra="${esc(x.id)}">Editar</button>` : ""}
          </div>
        </article>`).join("")}
    </div>` : `<div class="empty-box">Aún no hay extras.</div>`}`;
  if (admin) body.querySelector("#exNewBtn").onclick = () => openExtraModal(null);
  body.querySelectorAll("[data-edit-extra]").forEach(b => { b.onclick = () => openExtraModal(byId(b.dataset.editExtra)); });
  body.querySelectorAll("[data-toggle-extra]").forEach(inp => {
    inp.onchange = async () => {
      inp.disabled = true;
      try {
        await call("/api/gz/availability", { col: COL.extras, id: inp.dataset.toggleExtra, active: inp.checked });
        toast(inp.checked ? "Extra activado" : "Extra desactivado", { type: "ok", duration: 1800 });
      } catch (err) {
        inp.checked = !inp.checked; inp.disabled = false;
        toast(friendlyError(err), { type: "error" });
      }
    };
  });
}

function openExtraModal(extra) {
  const x = extra || {};
  const isNew = !extra;
  const cats = [...new Set(["Bebidas", "Dulces", "Snacks", ...ex.list.map(e => (e.category || "").trim()).filter(Boolean)])];
  const nextOrder = ex.list.reduce((m, e) => Math.max(m, Number(e.order) || 0), 0) + 1;
  Kit.openModal({
    title: isNew ? "Nuevo extra" : "Editar extra",
    wide: true,
    body: `
      <form id="extraForm" class="form-grid" novalidate>
        <label class="field span2"><span>Nombre *</span>
          <input name="name" maxlength="40" value="${esc(x.name || "")}"></label>
        <label class="field span2"><span>Descripción (sale en la página de pedidos)</span>
          <textarea name="description" maxlength="120" rows="2">${esc(x.description || "")}</textarea></label>
        <label class="field"><span>Categoría</span>
          <input name="category" maxlength="30" list="exCats" value="${esc(x.category || "")}">
          <datalist id="exCats">${cats.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
          <small class="field-hint">En la página de pedidos cada categoría es una sección con ese nombre (ej: Cocteles).</small></label>
        <label class="field"><span>Ícono (emoji)</span>
          <input name="icon" maxlength="4" value="${esc(x.icon || "")}"></label>
        <label class="field"><span>Precio de compra (por unidad)</span>
          <div class="money-input"><span>$</span><input name="unitCost" inputmode="numeric" value="${Number(x.unitCost) >= 0 && x.unitCost !== null && x.unitCost !== undefined ? Kit.thousands(Math.round(Number(x.unitCost))) : ""}" placeholder="0"></div>
          <small class="field-hint">Se actualiza solo con cada compra registrada en Inventario.</small></label>
        <label class="field"><span>Precio de venta *</span>
          <div class="money-input"><span>$</span><input name="price" inputmode="numeric" value="${isValidPrice(x.price) ? Kit.thousands(x.price) : ""}" placeholder="0"></div></label>
        <label class="field"><span>Cantidad / unidad</span>
          <input name="unit" maxlength="20" list="exUnits" value="${esc(x.unit || "und")}">
          <datalist id="exUnits">${Stock.COUNT_UNITS.map(u => `<option value="${esc(u)}">`).join("")}</datalist></label>
        <div class="field"><span>Margen bruto</span><div class="sup-preview" id="exMargin"></div></div>
        <label class="field"><span>Orden</span>
          <input name="order" type="number" min="0" max="9999" step="1" value="${x.order !== undefined && Number.isFinite(Number(x.order)) ? Number(x.order) : nextOrder}"></label>
        <div class="field"><span>Disponibilidad</span>
          <label class="switch big"><input type="checkbox" name="active" ${x.active !== false ? "checked" : ""}><span></span><em>Disponible (apagado sale como AGOTADO)</em></label></div>
        <div class="field"><span>Página de pedidos</span>
          <label class="switch big"><input type="checkbox" name="online" ${x.online !== false ? "checked" : ""}><span></span><em>Mostrar en la página de pedidos</em></label></div>
        <div class="span2">${Kit.imagePicker(x.image || "", "Imagen (opcional, se ve en la página de pedidos)")}</div>
        <p class="form-error span2" id="formError" hidden></p>
      </form>`,
    footer: `
      ${isNew ? "" : `<button class="btn btn-danger" id="deleteBtn">Eliminar</button>`}
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#extraForm");
      form.addEventListener("submit", e => e.preventDefault());
      const showMargin = () => {
        const cost = parseMoney(form.unitCost.value);
        root.querySelector("#exMargin").innerHTML = Kit.marginPreview(Costing.itemCost({ unitCost: Number.isNaN(cost) ? null : cost, price: parseMoney(form.price.value) }));
      };
      Kit.bindMoneyInput(form.price, showMargin);
      Kit.bindMoneyInput(form.unitCost, showMargin);
      showMargin();
      const getImage = Kit.bindImagePicker(root, x.image || "", Kit.SIDE_IMG);
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const fd = new FormData(form);
        const cost = parseMoney(fd.get("unitCost"));
        const data = {
          name: String(fd.get("name") || "").trim(),
          category: String(fd.get("category") || "").trim(),
          icon: String(fd.get("icon") || "").trim(),
          price: parseMoney(fd.get("price")),
          unitCost: Number.isNaN(cost) ? null : cost,
          unit: String(fd.get("unit") || "").trim().replace(/\s+/g, " ").slice(0, 20) || "und",
          order: parseInt(fd.get("order"), 10),
          active: form.active.checked,
          online: form.online.checked,
          description: String(fd.get("description") || "").trim(),
          image: getImage()
        };
        const error =
          !data.name ? "El nombre es obligatorio." :
          !isValidPrice(data.price) || data.price === 0 ? "Ingresa un precio de venta válido (mayor a $0)." :
          data.unitCost !== null && !isValidPrice(data.unitCost) ? "El costo no es válido." :
          !Number.isInteger(data.order) || data.order < 0 ? "El orden debe ser un número entero (0 o mayor)." : "";
        if (error) { errEl.textContent = error; errEl.hidden = false; return; }
        saveBtn.disabled = true;
        try {
          if (isNew) await addDoc(collection(db, COL.extras), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else await updateDoc(doc(db, COL.extras, extra.id), { ...data, updatedAt: serverTimestamp() });
          Kit.closeModal();
          toast(isNew ? "Extra creado" : "Extra actualizado", { type: "ok" });
        } catch (err) {
          errEl.textContent = friendlyError(err); errEl.hidden = false; saveBtn.disabled = false;
        }
      };
      const delBtn = root.querySelector("#deleteBtn");
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`¿Eliminar "${extra.name}"?\n\nLas ventas anteriores no se modifican. Si solo quieres ocultarlo, desactívalo.`)) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, COL.extras, extra.id));
          Kit.closeModal();
          toast("Extra eliminado", { type: "ok" });
        } catch (err) { delBtn.disabled = false; toast(friendlyError(err), { type: "error" }); }
      };
    }
  });
}

Kit.registerTab("extras", render);
Kit.extrasList = () => ex.list;
Kit.extrasReady = () => ex.ready;
Kit.openExtraModal = openExtraModal;
})();
