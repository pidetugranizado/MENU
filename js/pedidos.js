// =====================================================================
// PORTAL DE PEDIDOS (clientes)
// Granizados (+ acompañantes y extras) → toppings por unidad → carrito →
// nombre y pago → confirmación. Lo apagado en el panel sale como AGOTADO.
// =====================================================================
(function () {
"use strict";

const {
  NAME_MAX, MAX_UNITS_PER_LINE, MAX_SIDE_QTY,
  PAYMENT_METHODS, PAYMENT_LABELS, TOPPING_MODE, sellableSizes,
  money, esc, isValidPrice, normalize, dateKey, byDisplayOrder, unitTotal,
  watchCatalog, renderItemsDetail, renderUnitsDetail, renderSidesDetail, renderExtrasDetail,
  showFatal, friendlyError, toast
} = window.Core;
const { call } = window.Store;

const CART_KEY = "granizados.cart.v2"; // v2: cada línea lleva su tamaño
const SIDES_KEY = "granizados.sides.v1";
const EXTRAS_KEY = "granizados.extras.v1";
const CHECKOUT_KEY = "granizados.checkout.v1";
const LAST_ORDER_KEY = "granizados.lastOrder.v1";
// La confirmación del pedido se cierra sola para reducir el tráfico web
const DONE_SCREEN_MS = 3 * 60 * 1000;

const $ = sel => document.querySelector(sel);
const app = $("#app");

// ---------- Almacenamiento local seguro (solo carrito del dispositivo) ----------
function load(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

function validCartShape(cart) {
  return Array.isArray(cart) ? cart.filter(l =>
    l && typeof l.productId === "string" && typeof l.sizeId === "string" && Array.isArray(l.units) &&
    l.units.every(u => u && Array.isArray(u.toppingIds)))
    .map(l => ({ ...l, units: l.units.map(u => ({ toppingIds: u.toppingIds, mix: u.mix === true })) })) : [];
}
function validRowsShape(list, key) {
  return Array.isArray(list) ? list.filter(s => s && typeof s[key] === "string" && Number.isInteger(s.qty) && s.qty > 0) : [];
}

const state = {
  catalogReady: false,
  products: new Map(),
  toppings: new Map(),
  sides: new Map(),
  extras: new Map(),
  promos: [],
  cart: validCartShape(load(localStorage, CART_KEY, [])),
  sideCart: validRowsShape(load(localStorage, SIDES_KEY, []), "sideId"),
  extraCart: validRowsShape(load(localStorage, EXTRAS_KEY, []), "extraId"),
  checkout: Object.assign({ name: "", payment: "" }, load(localStorage, CHECKOUT_KEY, {})),
  lastOrder: load(sessionStorage, LAST_ORDER_KEY, null),
  draft: null,
  submitting: false
};

const saveCart = () => {
  save(localStorage, CART_KEY, state.cart);
  save(localStorage, SIDES_KEY, state.sideCart);
  save(localStorage, EXTRAS_KEY, state.extraCart);
};
const saveCheckout = () => save(localStorage, CHECKOUT_KEY, state.checkout);

// ---------- Reglas del catálogo ----------
const isAvailable = p => Boolean(p && p.active !== false && p.name && sellableSizes(p).length);
const sizeOf = (p, sizeId) => sellableSizes(p).find(s => s.id === sizeId) || null;
const isShared = p => p.toppingMode === TOPPING_MODE.shared;
const maxToppings = p => (Number(p.maxToppings) > 0 ? Number(p.maxToppings) : Infinity);

function allowedToppings(p) {
  const ids = Array.isArray(p.toppingIds) ? p.toppingIds : [];
  return ids.map(id => state.toppings.get(id))
    .filter(t => t && t.active !== false && t.name && isValidPrice(t.price))
    .sort(byDisplayOrder);
}

/** Disponibles primero; los apagados en el panel siguen saliendo como AGOTADO. */
const soldOutLast = (isOk) => (a, b) => (isOk(a) ? 0 : 1) - (isOk(b) ? 0 : 1);
const isListedProduct = p => Boolean(p && p.name && sellableSizes(p).length);
function listedProducts() {
  return [...state.products.values()].filter(isListedProduct).sort(soldOutLast(isAvailable));
}

// ---------- Modo MIX ----------
// El cliente solo marca "MIX"; los sabores los escoge al reclamar el granizado.
const canMix = p => Boolean(p && p.allowMix);

// ---------- Acompañantes y extras (se piden por cantidad, sin toppings) ----------
const hasPrice = x => Boolean(x && x.name && isValidPrice(x.price) && x.price > 0);
const isSideAvailable = s => hasPrice(s) && s.active !== false;
// Extras: solo los marcados "Mostrar en la página de pedidos"; apagados = AGOTADO
const isExtraListed = x => hasPrice(x) && x.online !== false;
const isExtraAvailable = x => isExtraListed(x) && x.active !== false;

const KINDS = {
  side: { cart: "sideCart", key: "sideId", items: () => state.sides, listed: hasPrice, ok: isSideAvailable },
  extra: { cart: "extraCart", key: "extraId", items: () => state.extras, listed: isExtraListed, ok: isExtraAvailable }
};
const kindOf = k => KINDS[k] || KINDS.side;
const listedOf = kind => {
  const K = kindOf(kind);
  return [...K.items().values()].filter(K.listed).sort(byDisplayOrder).sort(soldOutLast(K.ok));
};
const availableSides = () => listedOf("side").filter(isSideAvailable);
const qtyOf = (kind, id) => { const K = kindOf(kind); return state[K.cart].find(r => r[K.key] === id)?.qty || 0; };
const sideQty = sideId => qtyOf("side", sideId);

function setQty(kind, id, qty) {
  const K = kindOf(kind);
  const q = Math.max(0, Math.min(MAX_SIDE_QTY, qty));
  const row = state[K.cart].find(r => r[K.key] === id);
  if (row && q === 0) state[K.cart] = state[K.cart].filter(r => r !== row);
  else if (row) row.qty = q;
  else if (q > 0) state[K.cart].push({ [K.key]: id, qty: q });
  saveCart();
}

/** Acompañantes del carrito con precios vigentes (mismo formato que un pedido guardado). */
function sideItems() {
  return state.sideCart.map(r => {
    const s = state.sides.get(r.sideId);
    if (!isSideAvailable(s)) return null;
    return { sideId: s.id, name: s.name, image: s.image || "", price: s.price, quantity: r.qty, subtotal: s.price * r.qty };
  }).filter(Boolean);
}

/** Extras del carrito con precios vigentes (mismo formato que un pedido guardado). */
function extraItems() {
  return state.extraCart.map(r => {
    const x = state.extras.get(r.extraId);
    if (!isExtraAvailable(x)) return null;
    return { extraId: x.id, name: x.name, category: String(x.category || "").trim(), image: x.image || "", icon: x.icon || "",
      price: x.price, quantity: r.qty, subtotal: x.price * r.qty };
  }).filter(Boolean);
}

/** Extras visibles agrupados por categoría: cada una es su propia sección (ej: "Cocteles"). */
function extraGroups() {
  const groups = new Map();
  for (const x of listedOf("extra")) {
    const cat = String(x.category || "").trim() || "Extras";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(x);
  }
  return [...groups];
}

const activePromos = () => state.promos.filter(pr => pr.active !== false && (pr.badge || pr.title));

const findLine = (productId, sizeId) => state.cart.find(l => l.productId === productId && l.sizeId === sizeId);
const qtyInCart = productId => state.cart.filter(l => l.productId === productId).reduce((s, l) => s + l.units.length, 0);

/** Línea del carrito → detalle con precios vigentes (mismo formato que un pedido guardado). */
function describeLine(line) {
  const p = state.products.get(line.productId);
  const size = sizeOf(p, line.sizeId);
  const price = size ? size.price : 0;
  const allowed = allowedToppings(p);
  const units = line.units.map(u => {
    const tops = allowed.filter(t => u.toppingIds.includes(t.id))
      .map(t => ({ id: t.id, name: t.name, price: t.price }));
    return { toppings: tops, mix: canMix(p) && u.mix === true, total: unitTotal(price, tops) };
  });
  return {
    productId: p.id, name: p.name, image: p.image || "", basePrice: price,
    sizeId: line.sizeId, sizeName: size ? size.name : "",
    quantity: units.length, units,
    subtotal: units.reduce((s, u) => s + u.total, 0)
  };
}

const cartItems = () => state.cart.map(describeLine);
const sumOf = list => list.reduce((s, i) => s + i.subtotal, 0);
const cartTotal = () => sumOf(cartItems()) + sumOf(sideItems()) + sumOf(extraItems());
const cartUnits = () => state.cart.reduce((s, l) => s + l.units.length, 0) +
  state.sideCart.reduce((s, r) => s + r.qty, 0) + state.extraCart.reduce((s, r) => s + r.qty, 0);
const cartEmpty = () => !state.cart.length && !state.sideCart.length && !state.extraCart.length;

/** Ajusta el carrito si el administrador cambió productos/toppings/acompañantes. */
function sanitizeCart() {
  let changed = false;
  const next = [];
  for (const line of state.cart) {
    const p = state.products.get(line.productId);
    if (!isAvailable(p) || !sizeOf(p, line.sizeId)) { changed = true; continue; }
    const allowedIds = new Set(allowedToppings(p).map(t => t.id));
    const max = maxToppings(p);
    let units = line.units.slice(0, MAX_UNITS_PER_LINE).map(u => {
      let ids = [...new Set(u.toppingIds)].filter(id => allowedIds.has(id));
      if (ids.length > max) ids = ids.slice(0, max);
      if (ids.length !== u.toppingIds.length) changed = true;
      const mix = canMix(p) && u.mix === true;
      if (mix !== (u.mix === true)) changed = true;
      return { toppingIds: ids, mix };
    });
    if (units.length !== line.units.length) changed = true;
    if (isShared(p) && units.length > 1) {
      const first = units[0];
      units = units.map(() => ({ toppingIds: [...first.toppingIds], mix: first.mix }));
    }
    if (units.length) next.push({ productId: line.productId, sizeId: line.sizeId, units });
    else changed = true;
  }
  state.cart = next;
  for (const K of Object.values(KINDS)) {
    const rows = state[K.cart].filter(r => K.ok(K.items().get(r[K.key])))
      .map(r => ({ [K.key]: r[K.key], qty: Math.min(r.qty, MAX_SIDE_QTY) }));
    if (rows.length !== state[K.cart].length || rows.some((r, i) => r.qty !== state[K.cart][i].qty)) changed = true;
    state[K.cart] = rows;
  }
  if (changed) saveCart();
  return changed;
}

// ---------- Navegación (hash) ----------
const VIEWS = { "": "menu", "#carrito": "cart", "#datos": "details", "#confirmar": "confirm", "#listo": "done" };
const currentView = () => VIEWS[location.hash] || "menu";
const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };

window.addEventListener("hashchange", () => { closeSheet(); render(); window.scrollTo(0, 0); });

// ---------- Render principal ----------
function render() {
  stopDoneTimer();
  if (!state.catalogReady) {
    app.innerHTML = `<div class="loading-screen"><div class="spinner dark"></div></div>`;
    updateChrome("menu");
    return;
  }
  let view = currentView();
  if ((view === "details" || view === "confirm") && cartEmpty()) view = "menu";
  if (view === "confirm" && (!cleanName(state.checkout.name) || !PAYMENT_METHODS.includes(state.checkout.payment))) view = "details";
  if (view === "done" && !state.lastOrder) view = "menu";

  ({ menu: renderMenu, cart: renderCart, details: renderDetails, confirm: renderConfirm, done: renderDone })[view]();
  updateChrome(view);
}

function updateChrome(view) {
  const units = cartUnits();
  $("#backBtn").hidden = view === "menu" || view === "done";
  $("#cartBtn").hidden = view !== "menu";
  $("#hero").hidden = view !== "menu";
  $("#cartCount").textContent = units;
  $("#cartCount").hidden = units === 0;
  const bar = $("#cartbar");
  bar.hidden = !(view === "menu" && units > 0 && state.catalogReady);
  if (!bar.hidden) {
    $("#cartbarCount").textContent = `${units} ${units === 1 ? "producto" : "productos"}`;
    $("#cartbarTotal").textContent = money(cartTotal());
  }
  document.body.classList.toggle("has-cartbar", !bar.hidden);
}

// ---------- MENÚ ----------
function productImage(p, cls = "") {
  return p.image
    ? `<img class="${cls}" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" decoding="async">`
    : `<div class="${cls} img-ph">🍧</div>`;
}

function qtyControl(p) {
  const qty = qtyInCart(p.id);
  return `
    ${qty ? `<span class="in-cart">${qty} en carrito</span>` : ""}
    <button class="btn btn-sm add-btn" data-act="add" data-id="${esc(p.id)}">${qty ? "+ Agregar" : "Elegir tamaño"}</button>`;
}

// ---------- PROMOCIONES (primero en el menú, estilo callejero) ----------
const PROMO_COLORS = ["rosa", "lima", "amarillo", "cian"];

function promoCard(pr, i) {
  const p = pr.productId ? state.products.get(pr.productId) : null;
  const linked = isAvailable(p);
  const color = PROMO_COLORS.includes(pr.color) ? pr.color : PROMO_COLORS[i % PROMO_COLORS.length];
  return `
    <article class="promo promo-${color}">
      <div class="promo-tape" aria-hidden="true"><span>${"PROMO ★ PROMO ★ ".repeat(8)}</span></div>
      <div class="promo-inner">
        ${pr.image ? `<div class="promo-img"><img src="${esc(pr.image)}" alt="" loading="lazy" decoding="async"></div>` : ""}
        <div class="promo-text">
          <span class="promo-sticker">🔥 ${esc(pr.tag || "Promo activa")}</span>
          ${pr.badge ? `<div class="promo-badge">${esc(pr.badge)}</div>` : ""}
          ${pr.title ? `<h3 class="promo-title">${esc(pr.title)}</h3>` : ""}
          ${pr.description ? `<p class="promo-desc">${esc(pr.description)}</p>` : ""}
          ${linked ? `<button class="promo-cta" data-act="open" data-id="${esc(p.id)}">¡La quiero! →</button>` : ""}
        </div>
      </div>
      <div class="promo-tape bottom" aria-hidden="true"><span>${"NO TE LA PIERDAS ✦ ".repeat(8)}</span></div>
    </article>`;
}

function renderPromos() {
  const promos = activePromos();
  if (!promos.length) return "";
  return `
    <section class="menu-section promo-zone" id="cat-promos">
      <h2 class="promo-head"><span>🚨 Promo</span><span class="promo-head-2">del barrio</span></h2>
      <div class="promo-list">${promos.map(promoCard).join("")}</div>
    </section>`;
}

/** Franja superior: agrega las promos activas al texto que se desplaza. */
function updateMarquee() {
  const track = document.querySelector(".marquee-track");
  if (!track) return;
  const base = ["★ Granizados bien fríos", "<b>●</b> Pide desde tu celular", "★ Toppings a tu gusto", "<b>●</b> Paga en caja con tu nombre"];
  const promos = activePromos().map(pr => `🔥 PROMO: ${esc([pr.badge, pr.title].filter(Boolean).join(" · "))}`);
  const items = [...promos, ...base].map(t => `<span>${t}</span>`).join("");
  track.innerHTML = items + items;
}

// ---------- AGOTADO (lo que se apaga en el panel) ----------
const soldOutTape = () => `<div class="soldout-tape" aria-hidden="true"><span>Agotado</span></div>`;

// ---------- ACOMPAÑANTES y EXTRAS en la página ----------
function sideImage(s, cls = "", kind = "side") {
  if (s.image) return `<img class="${cls}" src="${esc(s.image)}" alt="${esc(s.name)}" loading="lazy" decoding="async">`;
  return kind === "extra"
    ? `<div class="${cls} img-ph extra-ph">${esc(s.icon || "🛍️")}</div>`
    : `<div class="${cls} img-ph side-ph">🍟</div>`;
}

function sideControl(s, kind = "side") {
  if (!kindOf(kind).ok(s)) return `<span class="soldout-note">Agotado</span>`;
  const qty = qtyOf(kind, s.id);
  const k = `data-kind="${kind}" data-id="${esc(s.id)}"`;
  return qty
    ? `<div class="stepper">
         <button data-act="side-dec" ${k} aria-label="Quitar uno">−</button>
         <span>${qty}</span>
         <button data-act="side-inc" ${k} aria-label="Agregar uno" ${qty >= MAX_SIDE_QTY ? "disabled" : ""}>+</button>
       </div>`
    : `<button class="btn btn-sm add-btn btn-side ${kind === "extra" ? "btn-extra" : ""}" data-act="side-inc" ${k}>+ Agregar</button>`;
}

function sideCard(s, kind = "side") {
  const soldOut = !kindOf(kind).ok(s);
  return `
    <article class="side-card ${kind === "extra" ? "extra-card" : ""} ${soldOut ? "soldout" : ""}">
      <div class="side-media">${sideImage(s, "", kind)}${soldOut ? soldOutTape() : ""}</div>
      <div class="side-body">
        <h3>${esc(s.name)}</h3>
        ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ""}
        <div class="side-foot">
          <span class="side-price">${money(s.price)}</span>
          <div class="side-ctrl" data-ctrl="${kind}:${esc(s.id)}">${sideControl(s, kind)}</div>
        </div>
      </div>
    </article>`;
}

function renderSidesSection(id = "cat-sides") {
  const sides = listedOf("side");
  if (!sides.length) return "";
  return `
    <section class="menu-section sides-zone" id="${id}">
      <h2 class="section-title sides-title">Acompañantes</h2>
      <p class="sides-sub">Para picar con tu granizado 🍟</p>
      <div class="side-grid">${sides.map(s => sideCard(s, "side")).join("")}</div>
    </section>`;
}

/** Una sección por categoría de extras, con el nombre que se le puso en el panel. */
function renderExtrasSections(groups) {
  return groups.map(([cat, list], i) => `
    <section class="menu-section sides-zone extras-zone" id="cat-x${i}">
      <h2 class="section-title extras-title">${esc(cat)}</h2>
      <div class="side-grid">${list.map(x => sideCard(x, "extra")).join("")}</div>
    </section>`).join("");
}

function productCard(p) {
  if (!isAvailable(p)) {
    return `
    <article class="card soldout">
      <div class="card-media">${productImage(p)}${soldOutTape()}</div>
      <div class="card-body">
        <h3>${esc(p.name)}</h3>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
        <div class="card-foot">
          <div class="size-hints">${sellableSizes(p).map(s => `<span>${esc(s.name)}</span>`).join("")}</div>
          <div class="card-actions"><span class="soldout-note">Agotado · vuelve pronto</span></div>
        </div>
      </div>
    </article>`;
  }
  const hasTops = allowedToppings(p).length > 0;
  return `
    <article class="card">
      <button class="card-media" data-act="open" data-id="${esc(p.id)}" aria-label="Ver ${esc(p.name)}">
        ${productImage(p)}
      </button>
      <div class="card-body">
        <h3>${esc(p.name)}</h3>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
        ${hasTops || canMix(p) ? `<div class="card-tags">
          ${canMix(p) ? `<button class="tops-link mix-link" data-act="open" data-id="${esc(p.id)}">🌀 Puedes pedirlo MIX</button>` : ""}
          ${hasTops ? `<button class="tops-link" data-act="open" data-id="${esc(p.id)}">+ Toppings disponibles</button>` : ""}
        </div>` : ""}
        <div class="card-foot">
          <div class="size-hints">${sellableSizes(p).map(s => `<span>${esc(s.name)}</span>`).join("")}</div>
          <div class="card-actions">${qtyControl(p)}</div>
        </div>
      </div>
    </article>`;
}

function renderMenu() {
  const products = listedProducts();
  const sides = listedOf("side");
  const xGroups = extraGroups();
  const promosHtml = renderPromos();
  if (!products.length && !sides.length && !xGroups.length) {
    app.innerHTML = `${promosHtml}<div class="empty"><div class="empty-icon">🍧</div><h2>Granizados no disponibles</h2><p>En este momento no hay productos disponibles.</p></div>`;
    return;
  }
  const groups = new Map();
  for (const p of products) {
    const cat = (p.category || "").trim() || "Granizados";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(p);
  }
  const cats = [...groups.keys()];
  const navItems = [
    ...(promosHtml ? [`<button data-act="cat" data-i="promos">🔥 Promos</button>`] : []),
    ...cats.map((c, i) => `<button data-act="cat" data-i="${i}">${esc(c)}</button>`),
    ...(sides.length ? [`<button data-act="cat" data-i="sides">🍟 Acompañantes</button>`] : []),
    ...xGroups.map(([c], i) => `<button data-act="cat" data-i="x${i}">${esc(c)}</button>`)
  ];
  const showTitles = cats.length > 1 || promosHtml || sides.length || xGroups.length;
  app.innerHTML = `
    ${navItems.length > 1 ? `<nav class="cats">${navItems.join("")}</nav>` : ""}
    ${promosHtml}
    ${cats.map((c, i) => `
      <section class="menu-section" id="cat-${i}">
        ${showTitles ? `<h2 class="section-title">${esc(c)}</h2>` : ""}
        <div class="menu-grid">${groups.get(c).map(productCard).join("")}</div>
      </section>`).join("")}
    ${renderSidesSection()}
    ${renderExtrasSections(xGroups)}`;
}

/** Re-dibuja solo los controles de un acompañante o extra (sin mover la página). */
function refreshSideControls(kind, id) {
  const s = kindOf(kind).items().get(id);
  if (!s) return;
  document.querySelectorAll(`[data-ctrl="${kind}:${CSS.escape(id)}"]`).forEach(ctrl => {
    ctrl.innerHTML = sideControl(s, kind);
  });
  updateChrome(currentView());
}

function changeSide(kind, id, delta) {
  const K = kindOf(kind);
  const s = K.items().get(id);
  if (!K.ok(s)) return;
  const before = qtyOf(kind, id);
  if (delta > 0 && before >= MAX_SIDE_QTY) { toast(`Máximo ${MAX_SIDE_QTY} unidades.`, { type: "error" }); return; }
  setQty(kind, id, before + delta);
  if (currentView() === "cart") { render(); return; }
  refreshSideControls(kind, id);
  if (delta > 0 && before === 0) toast(`${s.name} agregado`, { type: "ok", duration: 1400 });
}

app.addEventListener("click", e => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const { act, id } = btn.dataset;
  switch (act) {
    case "add":
    case "open": return openEditor(id);
    case "side-inc": return changeSide(btn.dataset.kind, id, 1);
    case "side-dec": return changeSide(btn.dataset.kind, id, -1);
    case "cat": {
      const sec = document.getElementById(`cat-${btn.dataset.i}`);
      if (sec) window.scrollTo({ top: sec.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" });
      return;
    }
    case "edit-line": return openEditor(id, { sizeId: btn.dataset.size });
    case "remove-line": return removeLine(id, btn.dataset.size);
    case "go": return go(btn.dataset.to);
    case "pay": return selectPayment(btn.dataset.method);
    case "to-confirm": return toConfirm();
    case "submit": return submitOrder();
    case "new-order": return newOrder();
  }
});

function removeLine(productId, sizeId) {
  const line = findLine(productId, sizeId);
  if (!line) return;
  const backup = state.cart.slice();
  state.cart = state.cart.filter(l => l !== line);
  saveCart();
  render();
  toast("Producto eliminado", { action: { label: "Deshacer", onClick: () => { state.cart = backup; saveCart(); render(); } } });
}

// ---------- EDITOR DE PRODUCTO (toppings por unidad) ----------
const sheet = $("#sheet");
const sheetPanel = $("#sheetPanel");

/**
 * Hoja del producto. Sin sizeId: agregar unidades nuevas (el cliente elige el tamaño).
 * Con sizeId: editar esa línea del carrito (puede cambiarle el tamaño).
 */
function openEditor(productId, { sizeId = null } = {}) {
  const p = state.products.get(productId);
  if (!isAvailable(p)) return;
  const line = sizeId ? findLine(productId, sizeId) : null;
  const units = line
    ? line.units.map(u => ({ toppingIds: [...u.toppingIds], mix: u.mix === true }))
    : [{ toppingIds: [], mix: false }];
  const sizes = sellableSizes(p);
  const chosen = line ? line.sizeId : sizes.length === 1 ? sizes[0].id : null;
  state.draft = { productId, sizeId: chosen, origSizeId: line ? line.sizeId : null, units, isEdit: Boolean(line) };
  renderSheet();
  sheet.hidden = false;
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => sheet.classList.add("open"));
}

function closeSheet() {
  if (sheet.hidden) return;
  state.draft = null;
  sheet.classList.remove("open");
  document.body.classList.remove("no-scroll");
  setTimeout(() => { if (!state.draft) sheet.hidden = true; }, 200);
}

function toppingChips(p, unitIndex, selectedIds) {
  const max = maxToppings(p);
  const full = selectedIds.length >= max;
  return allowedToppings(p).map(t => {
    const checked = selectedIds.includes(t.id);
    return `
      <label class="tp ${checked ? "on" : ""} ${!checked && full ? "off" : ""}">
        <input type="checkbox" data-u="${unitIndex}" data-t="${esc(t.id)}" ${checked ? "checked" : ""} ${!checked && full ? "disabled" : ""}>
        <span class="tp-box" aria-hidden="true"></span>
        ${t.image ? `<img class="tp-img" src="${esc(t.image)}" alt="" loading="lazy">` : ""}
        <span class="tp-name">${esc(t.name)}</span>
        <span class="tp-price">+${money(t.price)}</span>
      </label>`;
  }).join("");
}

/** Interruptor "¿Lo quieres MIX?" (los sabores se eligen al reclamar). */
function mixPicker(p, unitIndex, u) {
  return `
    <div class="mix-box ${u.mix ? "on" : ""}">
      <label class="mix-toggle">
        <input type="checkbox" data-mix-toggle data-u="${unitIndex}" ${u.mix ? "checked" : ""}>
        <span class="mix-switch" aria-hidden="true"></span>
        <span class="mix-label"><b>🌀 ¿Lo quieres MIX?</b>
          <small>Revolvemos sabores cuando reclames tu granizado · mismo precio</small></span>
      </label>
      ${u.mix ? `<p class="mix-note">✅ Modo MIX activado: al reclamar tu granizado dile al personal qué sabores quieres revolver.</p>` : ""}
    </div>`;
}

function unitSummary(p, size, ids) {
  if (!size) return "";
  const tops = allowedToppings(p).filter(t => ids.includes(t.id));
  const extra = tops.reduce((s, t) => s + t.price, 0);
  return `<div class="unit-sum">${esc(size.name)} ${money(size.price)}${extra ? ` + ${money(extra)} toppings` : ""} = <b>${money(size.price + extra)}</b></div>`;
}

function sizePicker(p, selectedId) {
  return `
    <section class="size-block">
      <h4>Elige el tamaño</h4>
      <div class="size-opts" role="radiogroup" aria-label="Tamaño">
        ${sellableSizes(p).map(s => `
          <button type="button" class="size-opt ${s.id === selectedId ? "on" : ""}" data-sheet="size" data-size="${esc(s.id)}"
            role="radio" aria-checked="${s.id === selectedId}">
            <span class="size-cup" aria-hidden="true">🥤</span>
            <span class="size-name">${esc(s.name)}</span>
            <span class="size-price">${money(s.price)}</span>
          </button>`).join("")}
      </div>
    </section>`;
}

function renderSheet() {
  const d = state.draft;
  const p = state.products.get(d.productId);
  const size = sizeOf(p, d.sizeId);
  const tops = allowedToppings(p);
  const max = maxToppings(p);
  const maxLabel = Number.isFinite(max) ? `<span class="max">Máx. ${max}</span>` : "";
  const prevScroll = sheetPanel.querySelector(".sheet-body")?.scrollTop || 0;
  const item = size ? describeLine({ productId: p.id, sizeId: size.id, units: d.units }) : null;

  const mixable = canMix(p);
  let toppingsHtml = "";
  if (tops.length || mixable) {
    const block = (u, i, heading, note) => `
         <section class="tp-block">
           ${heading ? `<div class="unit-h">${heading}</div>` : ""}
           ${note ? `<p class="tp-note">${note}</p>` : ""}
           ${mixable ? mixPicker(p, i, u) : ""}
           ${tops.length ? `
             <h4>Toppings ${maxLabel}</h4>
             <div class="tp-list">${toppingChips(p, i, u.toppingIds)}</div>` : ""}
           ${unitSummary(p, size, u.toppingIds)}
         </section>`;
    toppingsHtml = isShared(p)
      ? block(d.units[0], 0, "", d.units.length > 1 ? `Se aplica a las ${d.units.length} unidades.` : "")
      : d.units.map((u, i) => block(u, i, d.units.length > 1 ? `Unidad ${i + 1}` : "", "")).join("");
  }
  const saveLabel = !size ? "Elige un tamaño" : `${d.isEdit ? "Guardar" : "Agregar"} · ${money(item.subtotal)}`;

  sheetPanel.innerHTML = `
    <button class="sheet-close" data-sheet="close" aria-label="Cerrar">×</button>
    <div class="sheet-body">
      <div class="sheet-media">${productImage(p)}</div>
      <div class="sheet-info">
        <h2>${esc(p.name)}</h2>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
        ${sizePicker(p, d.sizeId)}
        <div class="qty-row">
          <span>Cantidad</span>
          <div class="stepper big">
            <button data-sheet="dec" aria-label="Quitar uno" ${d.units.length <= 1 ? "disabled" : ""}>−</button>
            <span>${d.units.length}</span>
            <button data-sheet="inc" aria-label="Agregar uno" ${d.units.length >= MAX_UNITS_PER_LINE ? "disabled" : ""}>+</button>
          </div>
        </div>
        ${toppingsHtml}
      </div>
    </div>
    <footer class="sheet-foot">
      ${d.isEdit ? `<button class="btn btn-danger" data-sheet="remove">Eliminar</button>` : ""}
      <button class="btn btn-lg btn-block" data-sheet="save" ${size ? "" : "disabled"}>${saveLabel}</button>
    </footer>`;
  const body = sheetPanel.querySelector(".sheet-body");
  if (body) body.scrollTop = prevScroll;
}

sheet.addEventListener("click", e => {
  if (e.target === sheet) return closeSheet();
  const btn = e.target.closest("[data-sheet]");
  if (!btn || !state.draft) return;
  const d = state.draft;
  const p = state.products.get(d.productId);
  switch (btn.dataset.sheet) {
    case "close": return closeSheet();
    case "size":
      d.sizeId = btn.dataset.size;
      return renderSheet();
    case "dec":
      if (d.units.length > 1) d.units.pop();
      return renderSheet();
    case "inc":
      if (d.units.length < MAX_UNITS_PER_LINE) {
        const first = d.units[0];
        d.units.push(isShared(p)
          ? { toppingIds: [...first.toppingIds], mix: first.mix }
          : { toppingIds: [], mix: false });
      }
      renderSheet();
      // Lleva a la vista la nueva unidad para elegir sus toppings
      if (!isShared(p)) {
        const blocks = sheetPanel.querySelectorAll(".tp-block");
        blocks[blocks.length - 1]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      return;
    case "remove": {
      const { productId, origSizeId } = d;
      closeSheet();
      return removeLine(productId, origSizeId);
    }
    case "save": {
      if (!sizeOf(p, d.sizeId)) { toast("Elige un tamaño.", { type: "error" }); return; }
      const units = d.units.map(u => ({ toppingIds: [...u.toppingIds], mix: canMix(p) && u.mix === true }));
      const original = d.isEdit ? findLine(d.productId, d.origSizeId) : null;
      const target = findLine(d.productId, d.sizeId);
      let capped = false;
      if (original && original === target) {
        original.units = units;
      } else {
        // Nuevo tamaño o unidades nuevas: se suman a la línea de ese tamaño si ya existe
        if (original) state.cart = state.cart.filter(l => l !== original);
        if (target) {
          const room = MAX_UNITS_PER_LINE - target.units.length;
          capped = units.length > room;
          target.units.push(...units.slice(0, Math.max(0, room)));
        } else {
          state.cart.push({ productId: d.productId, sizeId: d.sizeId, units });
        }
      }
      saveCart();
      const wasEdit = d.isEdit;
      closeSheet();
      render();
      if (capped) toast(`Máximo ${MAX_UNITS_PER_LINE} unidades por tamaño.`, { type: "error" });
      else toast(wasEdit ? "Cambios guardados" : "Agregado al carrito", { type: "ok", duration: 1600 });
      return;
    }
  }
});

sheet.addEventListener("change", e => {
  if (!state.draft) return;
  const d = state.draft;
  const p = state.products.get(d.productId);
  const input = e.target.closest("input[data-t], input[data-mix-toggle]");
  if (!input) return;
  const targets = isShared(p) ? d.units : [d.units[Number(input.dataset.u)]];

  if (input.hasAttribute("data-mix-toggle")) {
    targets.forEach(u => { u.mix = input.checked; });
    return renderSheet();
  }

  const tId = input.dataset.t;
  for (const u of targets) {
    const has = u.toppingIds.includes(tId);
    if (input.checked && !has && u.toppingIds.length < maxToppings(p)) u.toppingIds.push(tId);
    if (!input.checked && has) u.toppingIds = u.toppingIds.filter(x => x !== tId);
  }
  renderSheet();
});

document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

// ---------- CARRITO ----------
function renderCart() {
  if (cartEmpty()) {
    app.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🛒</div>
        <h2>Tu carrito está vacío</h2>
        <p>Agrega granizados a tu pedido.</p>
        <button class="btn btn-lg" data-act="go" data-to="">Ver granizados</button>
      </div>`;
    return;
  }
  const items = cartItems();
  const sides = sideItems();
  const extras = extraItems();
  const total = cartTotal();
  const suggestions = availableSides().filter(s => !sideQty(s.id));
  app.innerHTML = `
    <div class="page">
      <h1 class="page-title">Tu carrito</h1>
      ${items.map(item => `
        <article class="panel cart-line">
          <div class="cl-head">
            ${item.image ? `<img class="cl-thumb" src="${esc(item.image)}" alt="">` : `<div class="cl-thumb img-ph">🍧</div>`}
            <div class="cl-title">
              <h3>${item.quantity} × ${esc(item.name)}</h3>
              <span class="muted">Tamaño ${esc(item.sizeName)} · ${money(item.basePrice)} c/u</span>
            </div>
          </div>
          ${renderUnitsDetail(item)}
          <div class="cl-actions">
            <button class="btn btn-ghost btn-sm" data-act="edit-line" data-id="${esc(item.productId)}" data-size="${esc(item.sizeId)}">✏️ Editar</button>
            <button class="btn btn-danger btn-sm" data-act="remove-line" data-id="${esc(item.productId)}" data-size="${esc(item.sizeId)}">🗑 Eliminar</button>
          </div>
        </article>`).join("")}
      ${sides.length ? `
        <article class="panel cart-sides">
          <div class="kv-label">🍟 ACOMPAÑANTES</div>
          ${sides.map(s => `
            <div class="cs-line">
              ${s.image ? `<img class="cs-thumb" src="${esc(s.image)}" alt="">` : `<div class="cs-thumb img-ph side-ph">🍟</div>`}
              <div class="cs-info"><b>${esc(s.name)}</b><span class="muted">${money(s.price)} c/u · ${money(s.subtotal)}</span></div>
              <div class="stepper">
                <button data-act="side-dec" data-id="${esc(s.sideId)}" aria-label="Quitar uno">−</button>
                <span>${s.quantity}</span>
                <button data-act="side-inc" data-id="${esc(s.sideId)}" aria-label="Agregar uno" ${s.quantity >= MAX_SIDE_QTY ? "disabled" : ""}>+</button>
              </div>
            </div>`).join("")}
        </article>` : ""}
      ${extras.length ? `
        <article class="panel cart-sides">
          <div class="kv-label">🛍️ EXTRAS</div>
          ${extras.map(x => `
            <div class="cs-line">
              ${x.image ? `<img class="cs-thumb" src="${esc(x.image)}" alt="">` : `<div class="cs-thumb img-ph extra-ph">${esc(x.icon || "🛍️")}</div>`}
              <div class="cs-info"><b>${esc(x.name)}</b><span class="muted">${x.category ? `${esc(x.category)} · ` : ""}${money(x.price)} c/u · ${money(x.subtotal)}</span></div>
              <div class="stepper">
                <button data-act="side-dec" data-kind="extra" data-id="${esc(x.extraId)}" aria-label="Quitar uno">−</button>
                <span>${x.quantity}</span>
                <button data-act="side-inc" data-kind="extra" data-id="${esc(x.extraId)}" aria-label="Agregar uno" ${x.quantity >= MAX_SIDE_QTY ? "disabled" : ""}>+</button>
              </div>
            </div>`).join("")}
        </article>` : ""}
      ${suggestions.length ? `
        <section class="upsell">
          <div class="upsell-h">¿Le sumas algo pa' picar? 🍟</div>
          <div class="upsell-list">
            ${suggestions.map(s => `
              <button class="upsell-item" data-act="side-inc" data-id="${esc(s.id)}">
                ${sideImage(s, "upsell-img")}
                <span class="upsell-name">${esc(s.name)}</span>
                <span class="upsell-price">+${money(s.price)}</span>
              </button>`).join("")}
          </div>
        </section>` : ""}
      <button class="btn btn-ghost btn-block" data-act="go" data-to="">+ Agregar más productos</button>
    </div>
    <div class="sticky-foot">
      <div class="total-row"><span>TOTAL DEL PEDIDO</span><strong>${money(total)}</strong></div>
      <button class="btn btn-lg btn-block" data-act="go" data-to="#datos">CONTINUAR</button>
    </div>`;
}

// ---------- NOMBRE + FORMA DE PAGO ----------
function cleanName(raw) {
  return String(raw ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

function renderDetails() {
  const c = state.checkout;
  app.innerHTML = `
    <div class="page">
      <section class="panel">
        <label for="nameInput" class="q-title">¿Cuál es tu nombre?</label>
        <input id="nameInput" class="name-input" type="text" maxlength="${NAME_MAX}"
          autocomplete="given-name" autocapitalize="words" enterkeyhint="done"
          placeholder="Escribe tu nombre" value="${esc(c.name)}">
        <p class="hint">Con este nombre encontraremos tu pedido en caja.</p>
      </section>
      <section class="panel">
        <div class="q-title">¿Cómo vas a pagar?</div>
        <div class="pay-options">
          ${PAYMENT_METHODS.map(m => `
            <button class="pay-opt ${c.payment === m ? "on" : ""}" data-act="pay" data-method="${m}" aria-pressed="${c.payment === m}">
              <span class="pay-icon">${m === "efectivo" ? "💵" : "📲"}</span>
              <span>${PAYMENT_LABELS[m].toUpperCase()}</span>
            </button>`).join("")}
        </div>
        <p class="hint">El pago se realiza en caja. Esta opción solo le informa al personal cómo vas a pagar.</p>
      </section>
    </div>
    <div class="sticky-foot">
      <div class="total-row"><span>TOTAL</span><strong id="detailsTotal">${money(cartTotal())}</strong></div>
      <button class="btn btn-lg btn-block" id="toConfirmBtn" data-act="to-confirm">REVISAR PEDIDO</button>
    </div>`;
  const input = $("#nameInput");
  input.addEventListener("input", () => {
    state.checkout.name = input.value;
    saveCheckout();
  });
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
}

function selectPayment(method) {
  if (!PAYMENT_METHODS.includes(method)) return;
  state.checkout.payment = method;
  saveCheckout();
  document.querySelectorAll(".pay-opt").forEach(b => {
    const on = b.dataset.method === method;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
  });
}

function toConfirm() {
  const name = cleanName(state.checkout.name);
  if (!name) {
    toast("Escribe tu nombre para continuar.", { type: "error" });
    $("#nameInput")?.focus();
    return;
  }
  if (!PAYMENT_METHODS.includes(state.checkout.payment)) {
    toast("Selecciona la forma de pago.", { type: "error" });
    return;
  }
  state.checkout.name = name;
  saveCheckout();
  go("#confirmar");
}

// ---------- CONFIRMACIÓN ----------
function renderConfirm() {
  const items = cartItems();
  const total = cartTotal();
  const name = cleanName(state.checkout.name);
  app.innerHTML = `
    <div class="page">
      <h1 class="page-title">Confirma tu pedido</h1>
      <section class="panel">
        <div class="kv"><span>CLIENTE</span><strong class="upper">${esc(name)}</strong></div>
      </section>
      <section class="panel">
        <div class="kv-label">PRODUCTOS</div>
        ${renderItemsDetail(items)}
        ${renderSidesDetail(sideItems())}
        ${renderExtrasDetail(extraItems())}
      </section>
      <section class="panel">
        <div class="kv big"><span>TOTAL A PAGAR</span><strong>${money(total)}</strong></div>
        <div class="kv"><span>FORMA DE PAGO</span><strong>${PAYMENT_LABELS[state.checkout.payment].toUpperCase()}</strong></div>
      </section>
      <div class="edit-links">
        <button class="btn btn-ghost btn-sm" data-act="go" data-to="#carrito">Editar productos</button>
        <button class="btn btn-ghost btn-sm" data-act="go" data-to="#datos">Editar nombre o pago</button>
      </div>
    </div>
    <div class="sticky-foot">
      <button class="btn btn-lg btn-block btn-ok" id="submitBtn" data-act="submit" ${state.submitting ? "disabled" : ""}>
        ${state.submitting ? `<span class="spinner"></span> ENVIANDO PEDIDO…` : "CONFIRMAR PEDIDO"}
      </button>
    </div>`;
}

async function submitOrder() {
  if (state.submitting) return; // evita pedidos duplicados por doble toque
  const name = cleanName(state.checkout.name);
  const payment = state.checkout.payment;
  if (!name || !PAYMENT_METHODS.includes(payment)) return go("#datos");
  if (cartEmpty()) return go("");

  const expectedTotal = cartTotal();
  const cart = state.cart.map(l => ({ productId: l.productId, sizeId: l.sizeId,
    units: l.units.map(u => ({ toppingIds: [...u.toppingIds], mix: u.mix === true })) }));
  const sideRows = state.sideCart.map(r => ({ sideId: r.sideId, qty: r.qty }));
  const extraRows = state.extraCart.map(r => ({ extraId: r.extraId, qty: r.qty }));
  state.submitting = true;
  renderConfirm();

  try {
    // El servidor vuelve a leer precios y disponibilidad, calcula el total y asigna el número
    const created = await call("/api/gz/order", {
      customerName: name, paymentMethod: payment, cart, sides: sideRows, extras: extraRows, expectedTotal
    });
    const result = { number: created.number, total: created.total, customerName: created.customerName,
      paymentMethod: created.paymentMethod, closesAt: Date.now() + DONE_SCREEN_MS };

    // Pedido creado: limpiar carrito y mostrar resultado
    state.cart = [];
    state.sideCart = [];
    state.extraCart = [];
    saveCart();
    state.checkout.payment = "";
    saveCheckout();
    state.lastOrder = result;
    save(sessionStorage, LAST_ORDER_KEY, result);
    state.submitting = false;
    history.replaceState(null, "", "#listo");
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    state.submitting = false;
    if (err.serverCode === "PRICE_CHANGED" || err.serverCode === "unavailable") {
      if (err.serverCode === "PRICE_CHANGED") {
        toast("Los precios se actualizaron. Revisa el nuevo total antes de confirmar.", { type: "error", duration: 5000 });
        render();
      } else {
        sanitizeCart();
        toast(err.message + " Revisa tu carrito.", { type: "error", duration: 5000 });
        go("#carrito");
      }
    } else {
      console.error(err);
      toast(friendlyError(err), { type: "error", duration: 5000 });
      render();
    }
  }
}

// ---------- PEDIDO REALIZADO ----------
let doneTimer = null;
function stopDoneTimer() { clearInterval(doneTimer); doneTimer = null; }
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

function renderDone() {
  const o = state.lastOrder;
  // Pedidos guardados antes de existir la cuenta regresiva
  if (!o.closesAt) { o.closesAt = Date.now() + DONE_SCREEN_MS; save(sessionStorage, LAST_ORDER_KEY, o); }
  if (o.closesAt <= Date.now()) { closeDoneScreen(); return; }
  app.innerHTML = `
    <div class="page done">
      <div class="done-check">✓</div>
      <h1 class="done-title">¡PEDIDO REALIZADO!</h1>
      <section class="countdown" role="timer" aria-live="off">
        <div class="cd-top">
          <span class="cd-icon" aria-hidden="true">⏱</span>
          <div class="cd-text">Esta ventana se cerrará en <b id="cdTime">${mmss(o.closesAt - Date.now())}</b></div>
        </div>
        <div class="cd-bar"><span id="cdBar" style="width:${Math.min(100, (o.closesAt - Date.now()) / DONE_SCREEN_MS * 100)}%"></span></div>
        <p class="cd-why">Para reducir el tráfico web, esta confirmación se cierra sola en 3 minutos.</p>
      </section>
      <div class="shot-zone">
        <span class="shot-label">📸 Captura esta parte</span>
        <section class="panel done-card">
          <div class="kv"><span>Cliente</span><strong class="upper">${esc(o.customerName)}</strong></div>
          <div class="kv"><span>Pedido</span><strong class="order-no">#${o.number}</strong></div>
          <div class="kv big"><span>TOTAL A PAGAR</span><strong>${money(o.total)}</strong></div>
          <div class="kv"><span>Forma de pago</span><strong>${PAYMENT_LABELS[o.paymentMethod].toUpperCase()}</strong></div>
        </section>
        <section class="panel notice">
          <p class="notice-main">Acércate a caja para cancelar tu pedido.</p>
          <p>Indica tu nombre en caja para que podamos encontrar tu pedido.</p>
          <div class="cashier-name">
            <span>Tu nombre para caja es:</span>
            <strong>${esc(o.customerName)}</strong>
          </div>
        </section>
      </div>
      <button class="btn btn-ghost btn-block" data-act="new-order">Hacer otro pedido</button>
    </div>`;

  doneTimer = setInterval(() => {
    const left = o.closesAt - Date.now();
    const t = document.getElementById("cdTime");
    const bar = document.getElementById("cdBar");
    if (left <= 0 || !t) { stopDoneTimer(); if (left <= 0) closeDoneScreen(); return; }
    t.textContent = mmss(left);
    bar.style.width = `${(left / DONE_SCREEN_MS) * 100}%`;
    t.closest(".countdown").classList.toggle("urgent", left <= 30000);
  }, 500);
}

/**
 * Se acabó el tiempo: borra el pedido de este navegador y cierra la página.
 * Los navegadores solo dejan cerrar por código las pestañas abiertas por
 * código; si no lo permite, la página se reemplaza por una en blanco (sin
 * dejarla en el historial), así queda descargada igual que si se cerrara.
 */
function closeDoneScreen() {
  stopDoneTimer();
  state.lastOrder = null;
  try { sessionStorage.removeItem(LAST_ORDER_KEY); } catch { /* nada */ }
  document.body.innerHTML = "";
  window.close();
  setTimeout(() => { if (!window.closed) location.replace("about:blank"); }, 150);
}

function newOrder() {
  state.lastOrder = null;
  try { sessionStorage.removeItem(LAST_ORDER_KEY); } catch { /* nada */ }
  go("");
}

// ---------- Barra superior / carrito flotante ----------
$("#backBtn").addEventListener("click", () => {
  const back = { cart: "", details: "#carrito", confirm: "#datos" }[currentView()];
  go(back ?? "");
});
$("#cartBtn").addEventListener("click", () => go("#carrito"));
$("#heroCta").addEventListener("click", () => app.scrollIntoView({ behavior: "smooth", block: "start" }));

/**
 * Textura de hielo raspado para el tubo del inicio. Se dibuja UNA vez en un
 * lienzo pequeño (granos claros y sombras) y se repite como patrón: así se ve
 * como granizado sin que el navegador recalcule filtros en cada cuadro.
 */
function paintIceTexture() {
  const img = document.getElementById("iceTexImg");
  if (!img) return;
  const size = 220;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const dot = (x, y, r, color) => {
    // Se dibuja también en los bordes opuestos para que el patrón no tenga cortes
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      const cx = x + dx, cy = y + dy;
      if (cx + r < 0 || cy + r < 0 || cx - r > size || cy - r > size) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const rnd = Math.random;
  for (let i = 0; i < 420; i++) dot(rnd() * size, rnd() * size, 1.2 + rnd() * 2.6, `rgba(120,0,40,${0.06 + rnd() * 0.12})`); // sombras de los granos
  for (let i = 0; i < 1500; i++) dot(rnd() * size, rnd() * size, 0.5 + rnd() * 1.1, `rgba(255,255,255,${0.25 + rnd() * 0.55})`); // escarcha fina
  for (let i = 0; i < 140; i++) dot(rnd() * size, rnd() * size, 1.6 + rnd() * 2.2, `rgba(255,252,240,${0.35 + rnd() * 0.45})`); // cristales grandes
  const url = canvas.toDataURL("image/png");
  img.setAttribute("href", url);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", url);
}
paintIceTexture();
$("#cartbar").addEventListener("click", () => go("#carrito"));

// ---------- Arranque suave ----------
// Al abrir, el navegador hace su trabajo más pesado (fuentes, primer dibujo, menú).
// Mientras tanto las animaciones esperan quietas (clase "booting" puesta en el
// <head>); arrancan todas juntas cuando la página ya está asentada, así ningún
// movimiento se ve entrecortado. Máximo 1,5 s de espera aunque internet esté lento.
let markMenuReady;
const menuReady = new Promise(r => { markMenuReady = r; });
Promise.race([
  Promise.all([document.fonts ? document.fonts.ready : null, menuReady]),
  new Promise(r => setTimeout(r, 1500))
]).then(() => requestAnimationFrame(() => requestAnimationFrame(() =>
  document.documentElement.classList.remove("booting"))));

// ---------- Inicio ----------
{
  render();
  watchCatalog(({ products, toppings, sides, promos, extras, ready }) => {
    state.products = new Map(products.map(p => [p.id, p]));
    state.toppings = new Map(toppings.map(t => [t.id, t]));
    state.sides = new Map(sides.map(s => [s.id, s]));
    state.extras = new Map(extras.map(x => [x.id, x]));
    state.promos = promos;
    if (!ready) return;
    updateMarquee();
    const firstLoad = !state.catalogReady;
    state.catalogReady = true;
    const changed = sanitizeCart();
    if (changed && !firstLoad) toast("Tu carrito se actualizó porque un producto se agotó o cambió.", { duration: 4500 });
    if (state.draft) {
      if (isAvailable(state.products.get(state.draft.productId))) {
        // Mantener selección válida del editor abierto
        const p = state.products.get(state.draft.productId);
        if (!sizeOf(p, state.draft.sizeId)) state.draft.sizeId = null;
        const allowed = new Set(allowedToppings(p).map(t => t.id));
        state.draft.units.forEach(u => {
          u.toppingIds = u.toppingIds.filter(id => allowed.has(id)).slice(0, maxToppings(p));
          if (!canMix(p)) u.mix = false;
        });
        renderSheet();
      } else {
        closeSheet();
        toast("Ese producto ya no está disponible.");
      }
    }
    // No re-dibujar mientras el cliente escribe su nombre o se envía el pedido
    const view = currentView();
    if (view === "details" && !changed && !firstLoad && $("#detailsTotal")) {
      $("#detailsTotal").textContent = money(cartTotal());
      updateChrome(view);
      return;
    }
    if (state.submitting) return;
    render();
    if (firstLoad) requestAnimationFrame(() => markMenuReady());
  }, err => {
    console.error(err);
    // Con el menú ya en pantalla no se interrumpe al cliente: la lectura se
    // reintenta sola en segundo plano y el menú se actualiza al reconectar.
    if (state.catalogReady) return;
    showFatal(app, "No se pudieron cargar los granizados", esc(friendlyError(err)) +
      "<br><small>Reintentando automáticamente…</small>");
  }, { extras: true });
}
})();
