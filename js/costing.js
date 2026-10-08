// =====================================================================
// MOTOR DE COSTEO — cálculos puros (sin interfaz)
// Insumos, conversiones de unidades, recetas, merma, costo directo,
// margen bruto, precio sugerido por margen y gastos generales.
// =====================================================================
(function () {
  "use strict";

  // ---------- Unidades y conversiones ----------
  // f = factor hacia la unidad base de su dimensión (g, ml o und)
  const UNITS = {
    g:       { dim: "masa", f: 1,              label: "g — gramos" },
    kg:      { dim: "masa", f: 1000,           label: "kg — kilogramos" },
    lb:      { dim: "masa", f: 453.59237,      label: "lb — libras" },
    oz:      { dim: "masa", f: 28.349523125,   label: "oz — onzas" },
    ml:      { dim: "vol",  f: 1,              label: "ml — mililitros" },
    L:       { dim: "vol",  f: 1000,           label: "L — litros" },
    "oz fl": { dim: "vol",  f: 29.5735295625,  label: "oz fl — onzas líquidas" },
    gal:     { dim: "vol",  f: 3785.411784,    label: "gal — galones" },
    und:     { dim: "und",  f: 1,              label: "und — unidades" },
    docena:  { dim: "und",  f: 12,             label: "docena — 12 und" }
  };
  const STANDARD_UNITS = Object.keys(UNITS);
  const BASE_BY_DIM = { masa: "g", vol: "ml", und: "und" };

  const clean = u => String(u ?? "").trim();
  /** Unidades no estándar: dimensión propia, solo convertibles consigo mismas. */
  function unitInfo(u) {
    const key = clean(u);
    return UNITS[key] || { dim: "otra:" + key.toLowerCase(), f: 1, label: key };
  }
  function compatibleUnits(u) {
    const d = unitInfo(u).dim;
    const list = STANDARD_UNITS.filter(k => UNITS[k].dim === d);
    return list.length ? list : [clean(u)];
  }
  function baseUnit(u) {
    return BASE_BY_DIM[unitInfo(u).dim] || clean(u);
  }

  const num = v => (v === "" || v === null || v === undefined ? NaN : Number(v));
  const normalize = t => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  // ---------- Insumos ----------
  /** Costo por unidad base (por g, por ml, por und…). */
  function supplyUnitCost(s) {
    if (!s) return NaN;
    const qty = num(s.purchaseQty), price = num(s.purchasePrice);
    if (!(qty > 0) || !(price >= 0)) return NaN;
    return price / (qty * unitInfo(s.purchaseUnit).f);
  }
  const isPackaging = s => normalize(s && s.category).startsWith("empaque");

  /** Costo de una línea de receta, con todos los datos para explicar el cálculo. */
  function lineCost(line, suppliesById) {
    const s = suppliesById.get(line.supplyId);
    if (!line.supplyId) return { ok: false, error: "Elige un insumo", cost: 0 };
    if (!s) return { ok: false, error: "Insumo eliminado", cost: 0 };
    const per = supplyUnitCost(s);
    if (!Number.isFinite(per)) return { ok: false, error: "El insumo no tiene presentación o precio válido", cost: 0, supply: s };
    const qty = num(line.qty);
    if (!(qty > 0)) return { ok: false, error: "Escribe la cantidad usada", cost: 0, supply: s };
    const ui = unitInfo(line.unit), si = unitInfo(s.purchaseUnit);
    if (ui.dim !== si.dim) return { ok: false, error: `No se puede convertir ${clean(line.unit)} a ${clean(s.purchaseUnit)}`, cost: 0, supply: s };
    const baseQty = qty * ui.f;
    return {
      ok: true, supply: s, per, baseQty, qty, unit: clean(line.unit),
      base: baseUnit(s.purchaseUnit),
      purchaseBaseQty: num(s.purchaseQty) * si.f,
      cost: per * baseQty,
      packaging: isPackaging(s)
    };
  }

  function recipeCost(recipe, suppliesById) {
    const lines = (Array.isArray(recipe) ? recipe : []).map(line => ({ line, ...lineCost(line, suppliesById) }));
    let ingredients = 0, packaging = 0;
    for (const r of lines) if (r.ok) { if (r.packaging) packaging += r.cost; else ingredients += r.cost; }
    return { lines, ingredients, packaging, direct: ingredients + packaging, errors: lines.filter(r => !r.ok) };
  }

  // ---------- Gastos generales del negocio ----------
  // Arriendo, servicios, nómina… NO se suman al costo de cada producto: el
  // margen bruto de granizados, extras y acompañantes, en conjunto, los cubre.
  const GENERAL_CATEGORIES = {
    arriendo: "Arriendo",
    servicios: "Servicios",
    nomina: "Nómina",
    otros: "Otros gastos operativos"
  };
  /** Categoría de un gasto general (los registros antiguos de "mano de obra" pasan a Nómina). */
  function generalCategory(o) {
    if (o && GENERAL_CATEGORIES[o.category]) return o.category;
    return o && o.kind === "labor" ? "nomina" : "otros";
  }
  /** Valor mensual de un gasto general (NaN si falta). */
  function generalMonthly(o) {
    if (!o) return NaN;
    const v = num(o.monthlyAmount);
    if (v >= 0) return v;
    const legacy = num(o.monthlyCost); // registros antiguos "costo fijo distribuido"
    return o.method === "distributed" && legacy >= 0 ? legacy : NaN;
  }

  // ---------- Granizado (un tamaño) ----------
  /**
   * Costeo de un granizado.
   * Costo directo = insumos + empaque (vaso, tapa, pitillo…) + merma opcional
   * Margen bruto = precio de venta − costo directo
   * Margen bruto % = margen bruto ÷ precio de venta × 100
   * Precio sugerido = costo directo ÷ (1 − margen deseado)
   */
  function productCost(product, suppliesById) {
    const c = product.costing || {};
    const recipe = recipeCost(c.recipe, suppliesById);
    const w = c.waste || {};
    let waste = 0;
    if (w.mode === "percent") waste = recipe.direct * (num(w.value) || 0) / 100;
    else if (w.mode === "amount") waste = num(w.value) || 0;
    const total = recipe.direct + waste;

    const margin = num(c.targetMargin);
    const marginValid = margin >= 0 && margin < 100;
    const suggested = total > 0 && marginValid ? Math.round(total / (1 - margin / 100)) : NaN;
    const auto = c.priceMode === "auto";
    const salePrice = auto && Number.isFinite(suggested) ? suggested : num(product.price);
    const profit = salePrice - total;
    return {
      recipe, waste, wasteMode: w.mode || "none", wasteValue: num(w.value),
      total,
      margin: marginValid ? margin : NaN, suggested, auto,
      salePrice, profit,
      realMargin: salePrice > 0 ? profit / salePrice * 100 : NaN,
      costPct: salePrice > 0 ? total / salePrice * 100 : NaN,
      hasRecipe: recipe.lines.length > 0
    };
  }

  // ---------- Extra o acompañante (costo directo = precio de compra unitario) ----------
  function itemCost(item) {
    const raw = item ? item.unitCost : null;
    const cost = raw === null || raw === undefined || raw === "" ? NaN : num(raw);
    const price = num(item && item.price);
    const hasCost = cost >= 0;
    const profit = hasCost && price >= 0 ? price - cost : NaN;
    return {
      cost: hasCost ? cost : NaN, price, profit, hasCost,
      margin: hasCost && price > 0 ? profit / price * 100 : NaN
    };
  }

  // ---------- Topping ----------
  function toppingCost(topping, suppliesById) {
    const recipe = recipeCost(topping.costing && topping.costing.recipe, suppliesById);
    const price = num(topping.price);
    const cost = recipe.direct;
    return {
      recipe, cost, price, profit: price - cost,
      margin: price > 0 ? (price - cost) / price * 100 : NaN,
      hasRecipe: recipe.lines.length > 0
    };
  }

  // ---------- Formatos (pesos con hasta 2 decimales, porcentajes) ----------
  const thousands = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  /** 2656.5 → "$2.656,50" · 2530 → "$2.530" · 0.4 → "$0,40" */
  function moneyDec(n) {
    if (!Number.isFinite(n)) return "—";
    const cents = Math.round(Math.abs(n) * 100);
    const int = Math.floor(cents / 100), dec = cents % 100;
    return (n < 0 && cents ? "-" : "") + "$" + thousands(String(int)) + (dec ? "," + String(dec).padStart(2, "0") : "");
  }
  /** 40.7333 → "40,73%" */
  function pct(n) {
    if (!Number.isFinite(n)) return "—";
    return (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",") + "%";
  }
  /** Cantidades: 1000 → "1.000" · 0.5 → "0,5" */
  function qty(n) {
    if (!Number.isFinite(n)) return "—";
    const r = Math.round(n * 1000) / 1000;
    const [i, d] = String(Math.abs(r)).split(".");
    return (r < 0 ? "-" : "") + thousands(i) + (d ? "," + d : "");
  }
  const round2 = n => Math.round(n * 100) / 100;

  window.Costing = {
    UNITS, STANDARD_UNITS, GENERAL_CATEGORIES,
    unitInfo, compatibleUnits, baseUnit, supplyUnitCost, isPackaging,
    lineCost, recipeCost, generalCategory, generalMonthly, productCost, itemCost, toppingCost,
    moneyDec, pct, qty, round2
  };
})();
