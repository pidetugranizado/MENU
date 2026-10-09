// =====================================================================
// USUARIOS — solo administrador
// Crear, editar, activar/desactivar, asignar rol y cambiar contraseña.
// Roles: admin · cajero · preparacion. Las reglas de PocketBase solo
// permiten estas operaciones a un admin activo, y el servidor impide que
// el sistema quede sin administradores.
// =====================================================================
(function () {
"use strict";

const { esc, dateLabel, friendlyError, toast, ROLE_LABELS, ROLE_TABS } = window.Core;
const { pb } = window.Store;
const Kit = window.AdminKit;
const $ = sel => document.querySelector(sel);

const TAB_LABELS = { parqueadero: "Parqueadero", caja: "Caja", extras: "Extras", prep: "Preparación" };
const MIN_PASS = 8;
const us = { list: null, loading: false, q: "" };

/** Mensaje legible de un error de PocketBase (incluye errores por campo). */
function errorText(err) {
  const fields = (err && (err.response?.data || err.data?.data)) || {};
  const map = { email: "Correo", password: "Contraseña", passwordConfirm: "Confirmación", role: "Rol", name: "Nombre" };
  const parts = Object.entries(fields).map(([k, v]) => {
    const m = v && v.message ? v.message : "";
    if (k === "email" && /unique|already|exist/i.test(m + (v.code || ""))) return "Ese correo ya está registrado.";
    if (k === "passwordConfirm") return "Las contraseñas no coinciden.";
    if (k === "password") return `La contraseña debe tener mínimo ${MIN_PASS} caracteres.`;
    return `${map[k] || k}: ${m}`;
  });
  if (parts.length) return parts.join(" ");
  if (err && err.status === 403) return "Solo un administrador puede gestionar usuarios.";
  return (err && (err.response?.message || err.message)) || friendlyError(err);
}

async function load() {
  us.loading = true;
  try {
    us.list = await pb.collection("users").getFullList({ sort: "email", fields: "id,email,name,role,active,created" });
  } catch (err) {
    us.list = null;
    toast(errorText(err), { type: "error" });
  } finally {
    us.loading = false;
  }
  paint();
}

function render() {
  const view = $("#view-usuarios");
  if (!view) return;
  view.innerHTML = `
    <div class="toolbar">
      <h2 class="view-title">Usuarios</h2>
      <input id="usQ" class="acc-search" type="search" placeholder="Buscar correo o nombre…" value="${esc(us.q)}">
      <button class="btn" id="usNew">+ Nuevo usuario</button>
    </div>
    <div class="acc-note">
      <p><b>Administrador:</b> todo el sistema. <b>Cajero:</b> ${ROLE_TABS.cajero.map(t => TAB_LABELS[t]).join(", ")}.
        <b>Área de preparación:</b> solo Preparación. Un usuario desactivado no puede iniciar sesión.</p>
    </div>
    <div id="usList"><div class="loading-screen small"><div class="spinner dark"></div></div></div>`;
  view.querySelector("#usNew").onclick = () => openUserModal(null);
  view.querySelector("#usQ").addEventListener("input", e => { us.q = e.target.value; paint(); });
  view.querySelector("#usList").addEventListener("click", e => {
    const b = e.target.closest("[data-edit-user]");
    if (b) openUserModal((us.list || []).find(u => u.id === b.dataset.editUser));
  });
  load();
}

function paint() {
  const box = $("#usList");
  if (!box) return;
  if (!us.list) { box.innerHTML = `<div class="empty-box">No se pudo cargar la lista de usuarios.</div>`; return; }
  const me = Kit.user();
  const q = (us.q || "").toLowerCase().trim();
  const list = us.list.filter(u => !q || `${u.email} ${u.name}`.toLowerCase().includes(q));
  const count = r => us.list.filter(u => u.role === r && u.active).length;
  box.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Usuarios activos</span><b>${us.list.filter(u => u.active).length} / ${us.list.length}</b></div>
      ${Object.keys(ROLE_LABELS).map(r => `<div class="kpi"><span>${esc(ROLE_LABELS[r])}</span><b>${count(r)}</b><small>activos</small></div>`).join("")}
    </div>
    ${list.length ? `
    <div class="table-wrap"><table class="ctable">
      <thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Creado</th><th></th></tr></thead>
      <tbody>${list.map(u => `
        <tr class="${u.active ? "" : "row-pending"}">
          <td><b>${esc(u.email)}</b>${me && me.id === u.id ? ` <small class="mode-tag">tú</small>` : ""}</td>
          <td>${esc(u.name || "—")}</td>
          <td><span class="src-tag ${u.role === "admin" ? "src-pedido" : u.role === "cajero" ? "src-extra" : "src-manual"}">${esc(ROLE_LABELS[u.role] || u.role || "—")}</span></td>
          <td>${u.active ? `<span class="st-pill st-ok">Activo</span>` : `<span class="st-pill st-none">Inactivo</span>`}</td>
          <td class="nowrap">${u.created ? dateLabel(new Date(u.created.replace(" ", "T"))) : "—"}</td>
          <td class="pk-act"><button class="btn btn-ghost btn-xs" data-edit-user="${esc(u.id)}">Editar</button></td>
        </tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty-box">${us.list.length ? "Ningún usuario coincide con la búsqueda." : "Aún no hay usuarios."}</div>`}`;
}

function openUserModal(user) {
  const isNew = !user;
  const u = user || { role: "cajero", active: true };
  const me = Kit.user();
  const isSelf = !!(me && user && me.id === user.id);
  Kit.openModal({
    title: isNew ? "Nuevo usuario" : "Editar usuario",
    body: `
      <form id="userForm" class="form-grid one" novalidate autocomplete="off">
        <label class="field"><span>Correo electrónico *</span>
          <input name="email" type="email" maxlength="120" value="${esc(u.email || "")}" autocomplete="off"></label>
        <label class="field"><span>Nombre</span>
          <input name="name" maxlength="60" value="${esc(u.name || "")}"></label>
        <label class="field"><span>Rol *</span>
          <select name="role" ${isSelf ? "disabled" : ""}>
            ${Object.entries(ROLE_LABELS).map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select>
          ${isSelf ? `<small class="field-hint">No puedes cambiar tu propio rol.</small>` : ""}</label>
        <div class="field"><span>Estado</span>
          <label class="switch big"><input type="checkbox" name="active" ${u.active ? "checked" : ""} ${isSelf ? "disabled" : ""}><span></span><em>Usuario activo (puede iniciar sesión)</em></label></div>
        <fieldset class="fs">
          <legend>${isNew ? "Contraseña *" : "Cambiar contraseña (opcional)"}</legend>
          <div class="two-cols">
            <label class="field"><span>Nueva contraseña</span>
              <input name="password" type="password" minlength="${MIN_PASS}" autocomplete="new-password"></label>
            <label class="field"><span>Repetir contraseña</span>
              <input name="passwordConfirm" type="password" minlength="${MIN_PASS}" autocomplete="new-password"></label>
          </div>
          <small class="field-hint">Mínimo ${MIN_PASS} caracteres.${isNew ? "" : " Déjalo vacío para no cambiarla. Al cambiarla, ese usuario debe volver a iniciar sesión."}</small>
        </fieldset>
        <p class="form-error" id="formError" hidden></p>
      </form>`,
    footer: `
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn" id="saveBtn">Guardar</button>`,
    onMount(root) {
      const form = root.querySelector("#userForm");
      form.addEventListener("submit", e => e.preventDefault());
      const errEl = root.querySelector("#formError");
      const saveBtn = root.querySelector("#saveBtn");
      saveBtn.onclick = async () => {
        const email = form.email.value.trim().toLowerCase();
        const pass = form.password.value;
        const pass2 = form.passwordConfirm.value;
        const fail = msg => { errEl.textContent = msg; errEl.hidden = false; };
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Escribe un correo válido.");
        if (isNew || pass || pass2) {
          if (pass.length < MIN_PASS) return fail(`La contraseña debe tener mínimo ${MIN_PASS} caracteres.`);
          if (pass !== pass2) return fail("Las contraseñas no coinciden.");
        }
        const data = { email, name: form.name.value.trim(), emailVisibility: true };
        if (!isSelf) {
          data.role = Object.keys(ROLE_LABELS).includes(form.role.value) ? form.role.value : "cajero";
          data.active = form.active.checked;
        }
        if (pass) { data.password = pass; data.passwordConfirm = pass2; }
        errEl.hidden = true;
        saveBtn.disabled = true;
        try {
          if (isNew) await pb.collection("users").create(data);
          else await pb.collection("users").update(user.id, data);
          Kit.closeModal();
          toast(isNew ? "Usuario creado" : "Usuario actualizado", { type: "ok" });
          load();
        } catch (err) {
          fail(errorText(err));
          saveBtn.disabled = false;
        }
      };
    }
  });
}

Kit.registerTab("usuarios", render);
})();
