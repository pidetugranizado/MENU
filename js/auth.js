// =====================================================================
// INICIO DE SESIÓN (correo + contraseña de PocketBase) Y ROLES
// Usado por admin.html y parqueadero.html. El servidor valida los
// permisos en cada consulta; aquí solo se decide qué mostrar.
// =====================================================================
(function () {
"use strict";

const { pb } = window.Store;
const { esc, friendlyError, ROLE_LABELS } = window.Core;

let current = null;
const REFRESH_MS = 6 * 60 * 60 * 1000; // renueva la sesión cada 6 h mientras la app está abierta

/** Usuario válido: de la colección users, activo y con rol permitido. */
function asUser(rec, roles) {
  if (!rec || rec.collectionName !== "users") return { error: "Inicia sesión con tu usuario del negocio." };
  if (rec.active !== true) return { error: "Tu usuario está desactivado. Habla con el administrador." };
  if (!roles.includes(rec.role)) return { error: "Tu usuario no tiene acceso a esta página." };
  return { user: { id: rec.id, email: rec.email, name: rec.name || "", role: rec.role } };
}

function loginScreen({ title, subtitle, message = "" }) {
  let el = document.getElementById("authScreen");
  if (!el) {
    el = document.createElement("div");
    el.id = "authScreen";
    el.className = "auth-screen";
    document.body.appendChild(el);
  }
  el.hidden = false;
  el.innerHTML = `
    <form class="auth-card" id="authForm" novalidate>
      <div class="auth-logo">🍧</div>
      <h1>${esc(title)}</h1>
      <p class="auth-sub">${esc(subtitle)}</p>
      <label class="auth-field"><span>Correo electrónico</span>
        <input id="authEmail" type="email" autocomplete="username" required></label>
      <label class="auth-field"><span>Contraseña</span>
        <input id="authPass" type="password" autocomplete="current-password" required></label>
      <p class="auth-error" id="authError" ${message ? "" : "hidden"}>${esc(message)}</p>
      <button class="btn btn-lg btn-block" id="authBtn" type="submit">Ingresar</button>
    </form>`;
  setTimeout(() => el.querySelector("#authEmail")?.focus(), 30);
  return el;
}

/**
 * Exige una sesión con alguno de los roles indicados.
 * Devuelve una promesa con el usuario { id, email, name, role }.
 */
function require({ roles, title, subtitle }) {
  return new Promise(resolve => {
    const done = user => {
      current = user;
      document.getElementById("authScreen")?.remove();
      setInterval(() => { pb.collection("users").authRefresh().catch(() => {}); }, REFRESH_MS);
      resolve(user);
    };
    const ask = (message = "") => {
      const el = loginScreen({ title, subtitle, message });
      const form = el.querySelector("#authForm");
      form.addEventListener("submit", async e => {
        e.preventDefault();
        const btn = form.querySelector("#authBtn");
        const errEl = form.querySelector("#authError");
        const email = form.querySelector("#authEmail").value.trim();
        const pass = form.querySelector("#authPass").value;
        if (!email || !pass) { errEl.textContent = "Escribe tu correo y tu contraseña."; errEl.hidden = false; return; }
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> Ingresando…`;
        try {
          const res = await pb.collection("users").authWithPassword(email, pass);
          const v = asUser(res.record, roles);
          if (v.error) { pb.authStore.clear(); throw new Error(v.error); }
          done(v.user);
        } catch (err) {
          const status = err && err.status;
          errEl.textContent = status === 400 ? "Correo o contraseña incorrectos (o usuario desactivado)."
            : status === 429 ? "Demasiados intentos. Espera un minuto e inténtalo de nuevo."
            : status === 0 ? "Sin conexión con el servidor. Revisa tu internet."
            : (err && err.message) || friendlyError(err);
          errEl.hidden = false;
          btn.disabled = false;
          btn.textContent = "Ingresar";
        }
      });
    };

    // ¿Ya hay una sesión guardada? Se valida con el servidor (rol y estado actuales)
    if (pb.authStore.isValid && pb.authStore.record?.collectionName === "users") {
      pb.collection("users").authRefresh().then(res => {
        const v = asUser(res.record, roles);
        if (v.error) { pb.authStore.clear(); ask(v.error); } else done(v.user);
      }).catch(err => {
        if (err && err.status === 0) { ask("Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo."); return; }
        pb.authStore.clear();
        ask("Tu sesión terminó. Inicia sesión de nuevo.");
      });
    } else {
      pb.authStore.clear();
      ask();
    }
  });
}

function logout() {
  pb.authStore.clear();
  location.replace(location.pathname);
}

// Sesión vencida o usuario desactivado mientras la app está abierta
let expiredShown = false;
window.addEventListener("gz-auth-expired", () => {
  if (expiredShown || !current) return;
  expiredShown = true;
  window.Core.toast("Tu sesión terminó. Vuelve a iniciar sesión.", { type: "error", duration: 4000 });
  setTimeout(logout, 1800);
});

window.Auth = {
  require, logout,
  user: () => current,
  roleLabel: r => ROLE_LABELS[r] || r
};
})();
