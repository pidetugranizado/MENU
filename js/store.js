// =====================================================================
// ALMACENAMIENTO — PocketBase (producción)
// Misma interfaz que usan los portales (estilo Firestore), ahora sobre la
// instancia de PocketBase configurada en js/config.js.
//   • Lecturas: API de PocketBase (las reglas por rol las aplica el servidor).
//   • Tiempo real: suscripciones de PocketBase; cada pantalla aplica solo los
//     cambios que llegan (sin volver a descargar todo).
//   • Escrituras: rutas /api/gz/* del servidor (pb_hooks), en transacción.
// =====================================================================
(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const PB_URL = String(CFG.PB_URL || "").trim().replace(/\/+$/, "");
  const pb = new window.PocketBase(PB_URL);
  pb.autoCancellation(false); // varias consultas iguales en paralelo son válidas

  // Columnas indexadas en el servidor (copiadas de `data`): filtros y orden allí
  const QUERY_FIELDS = {
    orders: ["createdAt", "paidAt"],
    extraSales: ["createdAt"],
    parking: ["entryAt", "paidAt", "exited"],
    incomes: ["date"],
    expenses: ["date"],
    inventoryMoves: ["date"]
  };
  const PAGE = 1000;

  // ---------- Errores ----------
  /**
   * Convierte un error de PocketBase en uno de la app. Los mensajes del
   * servidor (400/404/409) se muestran tal cual; los de conexión, sesión
   * o permisos llevan un código para friendlyError().
   */
  function toStoreError(err) {
    if (err && err.__gz) return err;
    const status = err && typeof err.status === "number" ? err.status : 0;
    const body = (err && (err.response || err.data)) || {};
    const e = new Error(body.message || (err && err.message) || "Error de conexión");
    e.__gz = true;
    e.status = status;
    e.serverCode = body.code || "";
    e.fields = body.data || null;
    e.code = status === 0 ? "unavailable"
      : status === 401 ? "unauthenticated"
      : status === 403 ? "permission-denied"
      : status === 429 ? "resource-exhausted"
      : status >= 500 ? "unavailable" : "";
    if (status === 401 && pb.authStore.token) {
      window.dispatchEvent(new CustomEvent("gz-auth-expired"));
    }
    return e;
  }

  // ---------- Valores especiales ----------
  class Timestamp {
    constructor(ms) { this.ms = ms; }
    static fromDate(d) { return new Timestamp(d.getTime()); }
    static now() { return new Timestamp(Date.now()); }
    toDate() { return new Date(this.ms); }
    toMillis() { return this.ms; }
  }
  const sentinel = (kind, items) => ({ __sentinel: kind, items });
  const serverTimestamp = () => sentinel("serverTimestamp");
  const deleteField = () => sentinel("deleteField");
  const arrayUnion = (...items) => sentinel("arrayUnion", items);
  const arrayRemove = (...items) => sentinel("arrayRemove", items);

  function encode(v) {
    if (v instanceof Timestamp) return { __ts: v.ms };
    if (v instanceof Date) return { __ts: v.getTime() };
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === "object") {
      if (v.__sentinel) throw new Error("Valor especial no permitido aquí: " + v.__sentinel);
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x);
      return out;
    }
    return v;
  }
  /** Datos de una escritura: los valores especiales solo van en el primer nivel. */
  function encodeWrite(data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (v === undefined) continue;
      out[k] = v && v.__sentinel ? { __sentinel: v.__sentinel, items: (v.items || []).map(encode) } : encode(v);
    }
    return out;
  }
  function decode(v) {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === "object") {
      if ("__ts" in v) return new Timestamp(v.__ts);
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = decode(x);
      return out;
    }
    return v;
  }
  const comparable = v => (v instanceof Timestamp ? v.ms : v && typeof v === "object" && "__ts" in v ? v.__ts : v);

  // ---------- Referencias y consultas ----------
  const db = { pocketbase: true };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const collection = (_db, col) => ({ kind: "col", col });
  function doc(a, col, id) {
    if (a && a.kind === "col") return { kind: "doc", col: a.col, id: newId() };
    return { kind: "doc", col, id: String(id) };
  }
  const where = (field, op, value) => ({ t: "where", field, op, value });
  const orderBy = (field, dir = "asc") => ({ t: "orderBy", field, dir });
  const limit = n => ({ t: "limit", n });
  const query = (colRef, ...constraints) => ({ kind: "query", col: colRef.col, constraints });
  const asQuery = ref => (ref.kind === "col" ? { col: ref.col, constraints: [] } : ref);

  /** Registro de PocketBase → { id, rev, raw } */
  function fromRecord(rec) {
    let raw = {};
    try { raw = rec.data ? JSON.parse(rec.data) : {}; } catch { raw = {}; }
    return { id: rec.id, rev: Number(rec.rev) || 0, raw: raw || {} };
  }
  function makeDocSnap(col, id, row) {
    return {
      id,
      ref: { kind: "doc", col, id },
      rev: row ? row.rev : 0,
      exists: () => !!row,
      data: () => (row ? decode(row.raw) : undefined)
    };
  }

  function matches(raw, constraints) {
    for (const c of constraints) {
      if (c.t !== "where") continue;
      const a = comparable(raw[c.field]), b = comparable(c.value);
      let ok;
      switch (c.op) {
        case ">=": ok = a >= b; break;
        case ">": ok = a > b; break;
        case "<=": ok = a <= b; break;
        case "<": ok = a < b; break;
        case "==": ok = a === b; break;
        default: ok = true;
      }
      if (!ok) return false;
    }
    return true;
  }
  /** Filtra, ordena y limita en el navegador (mismo resultado que en el servidor). */
  function applyLocal(rows, constraints) {
    let out = rows.filter(r => matches(r.raw, constraints));
    for (const c of constraints) {
      if (c.t === "orderBy") {
        const dir = c.dir === "desc" ? -1 : 1;
        out.sort((x, y) => {
          const a = comparable(x.raw[c.field]), b = comparable(y.raw[c.field]);
          return (a < b ? -1 : a > b ? 1 : 0) * dir;
        });
      }
    }
    const lim = constraints.find(c => c.t === "limit");
    return lim ? out.slice(0, lim.n) : out;
  }

  /** Arma el filtro/orden de PocketBase con las columnas indexadas. */
  function serverParts(q) {
    const allowed = QUERY_FIELDS[q.col] || [];
    const parts = [];
    let localOnly = false;
    let sort = "";
    for (const c of q.constraints || []) {
      if (c.t === "where") {
        if (!allowed.includes(c.field)) { localOnly = true; continue; }
        const op = c.op === "==" ? "=" : c.op;
        if (![">=", ">", "<=", "<", "="].includes(op)) { localOnly = true; continue; }
        parts.push(pb.filter(`${c.field} ${op} {:v}`, { v: comparable(c.value) }));
      } else if (c.t === "orderBy") {
        if (allowed.includes(c.field)) sort = (c.dir === "desc" ? "-" : "") + c.field;
        else localOnly = true;
      }
    }
    return { filter: parts.join(" && "), sort, localOnly };
  }

  async function fetchRows(q) {
    const { filter, sort, localOnly } = serverParts(q);
    const lim = (q.constraints || []).find(c => c.t === "limit");
    const opts = { filter, sort, fields: "id,rev,data" };
    try {
      let records;
      if (lim && !localOnly && lim.n <= PAGE) {
        records = (await pb.collection(q.col).getList(1, lim.n, { ...opts, skipTotal: true })).items;
      } else {
        records = await pb.collection(q.col).getFullList({ ...opts, batch: PAGE });
      }
      return applyLocal(records.map(fromRecord), q.constraints || []);
    } catch (err) { throw toStoreError(err); }
  }

  // ---------- Lecturas ----------
  async function getDoc(ref) {
    try {
      const rec = await pb.collection(ref.col).getOne(ref.id, { fields: "id,rev,data" });
      return makeDocSnap(ref.col, ref.id, fromRecord(rec));
    } catch (err) {
      if (err && err.status === 404) return makeDocSnap(ref.col, ref.id, null);
      throw toStoreError(err);
    }
  }
  async function getDocs(q) {
    const rows = await fetchRows(asQuery(q));
    return { docs: rows.map(r => makeDocSnap(q.col, r.id, r)) };
  }

  // ---------- Escrituras (servidor) ----------
  /** Llama una ruta del servidor (/api/gz/...). */
  async function call(path, body) {
    try {
      return await pb.send(path, { method: "POST", body: body || {} });
    } catch (err) { throw toStoreError(err); }
  }
  const commit = (writes, reads = []) => call("/api/gz/commit", { reads, writes });
  const writeOf = (op, ref, data) => ({ op, col: ref.col, id: ref.id, data: op === "delete" ? undefined : encodeWrite(data) });

  async function addDoc(colRef, data) {
    const ref = doc(colRef);
    await commit([writeOf("set", ref, data)]);
    return ref;
  }
  async function setDoc(ref, data) { await commit([writeOf("set", ref, data)]); }
  async function updateDoc(ref, data) { await commit([writeOf("update", ref, data)]); }
  async function deleteDoc(ref) { await commit([writeOf("delete", ref)]); }

  function writeBatch() {
    const ops = [];
    const batch = {
      set(ref, d) { ops.push(writeOf("set", ref, d)); return batch; },
      update(ref, d) { ops.push(writeOf("update", ref, d)); return batch; },
      delete(ref) { ops.push(writeOf("delete", ref)); return batch; },
      async commit() { if (ops.length) await commit(ops); }
    };
    return batch;
  }

  /**
   * Transacción optimista: se anota la versión de cada documento leído; si
   * otro usuario lo cambió antes de guardar, el servidor responde 409 y se
   * repite (igual que Firestore).
   */
  async function runTransaction(_db, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads = new Map();
      const writes = [];
      const tx = {
        async get(ref) {
          const snap = await getDoc(ref);
          reads.set(ref.col + "/" + ref.id, { col: ref.col, id: ref.id, rev: snap.rev || 0 });
          return snap;
        },
        set(ref, d) { writes.push(writeOf("set", ref, d)); return tx; },
        update(ref, d) { writes.push(writeOf("update", ref, d)); return tx; },
        delete(ref) { writes.push(writeOf("delete", ref)); return tx; }
      };
      const result = await fn(tx);
      if (!writes.length) return result;
      try {
        await commit(writes, [...reads.values()]);
        return result;
      } catch (err) {
        if (err.status === 409 && err.serverCode === "conflict") {
          await new Promise(r => setTimeout(r, 80 + Math.random() * 200));
          continue;
        }
        throw err;
      }
    }
    const e = new Error("Hubo mucha actividad al mismo tiempo. Inténtalo de nuevo.");
    e.code = "aborted";
    throw e;
  }

  // ---------- Tiempo real ----------
  // Cada pantalla abierta (onSnapshot) guarda su propia copia y aplica los
  // cambios que llegan del servidor. Al reconectar se vuelve a sincronizar.
  const live = new Set();
  let connects = 0;
  pb.realtime.subscribe("PB_CONNECT", () => {
    connects++;
    if (connects > 1) live.forEach(l => l.resync());
  }).catch(() => { /* se reintenta al suscribir colecciones */ });

  function onSnapshot(ref, cb, onError) {
    const q = asQuery(ref);
    const constraints = q.constraints || [];
    const cache = new Map();   // id → { id, rev, raw }
    let alive = true;
    let loading = true;
    let queue = [];
    let unsub = null;
    let timer = null;

    const emit = () => {
      timer = null;
      if (!alive) return;
      try {
        const rows = applyLocal([...cache.values()], constraints);
        cb({ docs: rows.map(r => makeDocSnap(q.col, r.id, r)) });
      } catch (err) {
        if (onError) onError(err); else console.error(err);
      }
    };
    const schedule = () => { if (!timer) timer = setTimeout(emit, 16); };
    const apply = ev => {
      const rec = ev.record || {};
      if (ev.action === "delete") { cache.delete(rec.id); return; }
      const row = fromRecord(rec);
      const cur = cache.get(row.id);
      if (cur && cur.rev > row.rev) return; // llegó tarde un cambio viejo
      if (matches(row.raw, constraints)) cache.set(row.id, row); else cache.delete(row.id);
    };
    const load = async () => {
      loading = true;
      try {
        const rows = await fetchRows({ col: q.col, constraints: constraints.filter(c => c.t === "where") });
        if (!alive) return;
        cache.clear();
        rows.forEach(r => cache.set(r.id, r));
        const pending = queue;
        queue = [];
        loading = false;
        pending.forEach(apply);
        emit();
      } catch (err) {
        loading = false;
        if (alive) { if (onError) onError(err); else console.error(err); }
      }
    };
    const listener = { resync: load };

    pb.collection(q.col).subscribe("*", ev => {
      if (!alive) return;
      if (loading) queue.push(ev); else { apply(ev); schedule(); }
    }, { fields: "id,rev,data" }).then(fn => {
      if (alive) unsub = fn; else fn().catch(() => {});
    }).catch(err => { if (alive && onError) onError(toStoreError(err)); });

    live.add(listener);
    load();
    return () => {
      alive = false;
      live.delete(listener);
      clearTimeout(timer);
      if (unsub) unsub().catch(() => {});
    };
  }

  window.Store = {
    pb, PB_URL, db, collection, doc, query, where, orderBy, limit,
    onSnapshot, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
    writeBatch, runTransaction, serverTimestamp, Timestamp,
    arrayUnion, arrayRemove, deleteField, call
  };
})();
