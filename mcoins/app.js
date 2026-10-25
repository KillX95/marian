const API = `https://api.airtable.com/v0/${CONFIG.BASE_ID}`;
const $ = id => document.getElementById(id);
let user = null;          // { rid, username, userId, balance }
let mode = "login";       // "login" | "register"
let timer = null;

/* ---------- Airtable ---------- */
async function at(table, { method = "GET", query = "", body } = {}) {
  const res = await fetch(`${API}/${encodeURIComponent(table)}${query}`, {
    method,
    headers: { Authorization: `Bearer ${CONFIG.TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Erreur Airtable (${res.status})`);
  return data;
}
const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const filter = f => `?filterByFormula=${encodeURIComponent(f)}`;
const toUser = r => ({ rid: r.id, username: r.fields.Username, userId: r.fields.UserID, balance: r.fields.Balance || 0 });

const findByName = async n => (await at(CONFIG.USERS_TABLE, { query: filter(`LOWER({Username})='${esc(n.toLowerCase())}'`) })).records[0];
const findById = async id => (await at(CONFIG.USERS_TABLE, { query: filter(`{UserID}='${esc(id)}'`) })).records[0];

/* ---------- Utilitaires ---------- */
async function hash(name, pass) {
  const data = new TextEncoder().encode(`${CONFIG.SALT}:${name.toLowerCase()}:${pass}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I pour éviter les confusions
  const r = crypto.getRandomValues(new Uint8Array(8));
  return "MC-" + [...r].map(n => chars[n % chars.length]).join("");
}
const fmt = n => Number(n).toLocaleString("fr-FR");
function toast(msg, error = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (error ? " error" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), 3500);
}
async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}

/* ---------- Auth ---------- */
function setMode(m) {
  mode = m;
  $("tabLogin").classList.toggle("active", m === "login");
  $("tabRegister").classList.toggle("active", m === "register");
  $("authBtn").textContent = m === "login" ? "Se connecter" : "Créer mon compte";
  $("password").autocomplete = m === "login" ? "current-password" : "new-password";
}

async function register(name, pass) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new Error("Nom : 3 à 20 caractères (lettres, chiffres, _).");
  if (pass.length < 6) throw new Error("Le mot de passe doit faire au moins 6 caractères.");
  if (await findByName(name)) throw new Error("Ce nom d'utilisateur est déjà pris.");
  let userId;
  do { userId = randomId(); } while (await findById(userId)); // ID unique
  const res = await at(CONFIG.USERS_TABLE, {
    method: "POST",
    body: { records: [{ fields: { Username: name, PasswordHash: await hash(name, pass), UserID: userId, Balance: CONFIG.START_BALANCE } }] }
  });
  return toUser(res.records[0]);
}

async function login(name, pass) {
  const rec = await findByName(name);
  if (!rec || rec.fields.PasswordHash !== (await hash(name, pass))) throw new Error("Nom ou mot de passe incorrect.");
  return toUser(rec);
}

function startSession(u) {
  user = u;
  localStorage.setItem("mcoins_rid", u.rid);
  $("auth").hidden = true;
  $("dash").hidden = false;
  $("logout").hidden = false;
  render();
  loadHistory();
  clearInterval(timer);
  timer = setInterval(refresh, 15000); // vérifie les MCoins reçus
}

function logout() {
  localStorage.removeItem("mcoins_rid");
  clearInterval(timer);
  user = null;
  $("dash").hidden = true;
  $("logout").hidden = true;
  $("auth").hidden = false;
  $("password").value = "";
}

/* ---------- Tableau de bord ---------- */
function render() {
  $("hello").textContent = user.username;
  $("balance").textContent = fmt(user.balance);
  $("myId").textContent = user.userId;
}

async function refresh() {
  if (!user) return;
  try {
    const old = user.balance;
    user = toUser(await at(CONFIG.USERS_TABLE, { query: `/${user.rid}` }));
    render();
    if (user.balance !== old) loadHistory();
  } catch (e) { /* silencieux */ }
}

async function loadHistory() {
  const p = new URLSearchParams();
  p.set("filterByFormula", `OR({FromID}='${esc(user.userId)}',{ToID}='${esc(user.userId)}')`);
  p.set("maxRecords", "30");
  p.append("sort[0][field]", "Date");
  p.append("sort[0][direction]", "desc");
  const { records } = await at(CONFIG.TX_TABLE, { query: "?" + p });
  const ul = $("txList");
  ul.replaceChildren();
  $("txEmpty").hidden = records.length > 0;
  for (const r of records) {
    const f = r.fields, sent = f.FromID === user.userId;
    const li = document.createElement("li");
    const left = document.createElement("div");
    const who = document.createElement("div");
    who.textContent = sent ? `Envoyé à ${f.ToName} (${f.ToID})` : `Reçu de ${f.FromName} (${f.FromID})`;
    const date = document.createElement("div");
    date.className = "tx-date";
    date.textContent = new Date(r.createdTime).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    left.append(who, date);
    const amt = document.createElement("div");
    amt.className = sent ? "minus" : "plus";
    amt.textContent = `${sent ? "−" : "+"}${fmt(f.Amount)} MCoins`;
    li.append(left, amt);
    ul.append(li);
  }
}

async function send() {
  const toId = $("toId").value.trim().toUpperCase();
  const amount = Number($("amount").value);
  if (!toId) throw new Error("Entre l'ID du destinataire.");
  if (!Number.isInteger(amount) || amount < 1) throw new Error("Le montant doit être un nombre entier d'au moins 1.");
  if (toId === user.userId) throw new Error("Tu ne peux pas t'envoyer des MCoins à toi-même.");

  const sender = toUser(await at(CONFIG.USERS_TABLE, { query: `/${user.rid}` })); // solde à jour
  if (sender.balance < amount) throw new Error(`Solde insuffisant (${fmt(sender.balance)} MCoins).`);
  const rec = await findById(toId);
  if (!rec) throw new Error("Aucun utilisateur avec cet ID.");
  const receiver = toUser(rec);

  // Une seule requête PATCH : les deux soldes sont modifiés ensemble (tout ou rien)
  await at(CONFIG.USERS_TABLE, {
    method: "PATCH",
    body: { records: [
      { id: sender.rid, fields: { Balance: sender.balance - amount } },
      { id: receiver.rid, fields: { Balance: receiver.balance + amount } }
    ] }
  });
  await at(CONFIG.TX_TABLE, {
    method: "POST",
    body: { records: [{ fields: { FromID: sender.userId, FromName: sender.username, ToID: receiver.userId, ToName: receiver.username, Amount: amount } }] }
  });
  $("toId").value = ""; $("amount").value = "";
  toast(`${fmt(amount)} MCoins envoyés à ${receiver.username} ✔`);
  await refresh();
  await loadHistory();
}

/* ---------- Événements ---------- */
$("startAmount").textContent = fmt(CONFIG.START_BALANCE);
$("tabLogin").onclick = () => setMode("login");
$("tabRegister").onclick = () => setMode("register");
$("authBtn").onclick = () => busy($("authBtn"), async () => {
  const name = $("username").value.trim(), pass = $("password").value;
  if (!name || !pass) throw new Error("Remplis le nom et le mot de passe.");
  startSession(mode === "login" ? await login(name, pass) : await register(name, pass));
});
$("password").addEventListener("keydown", e => e.key === "Enter" && $("authBtn").click());
$("sendBtn").onclick = () => busy($("sendBtn"), send);
$("amount").addEventListener("keydown", e => e.key === "Enter" && $("sendBtn").click());
$("logout").onclick = logout;
$("copyId").onclick = async () => {
  try { await navigator.clipboard.writeText(user.userId); toast("ID copié !"); }
  catch { toast("Copie impossible : sélectionne l'ID à la main.", true); }
};

// Reconnexion automatique
(async () => {
  const rid = localStorage.getItem("mcoins_rid");
  if (!rid) return;
  try { startSession(toUser(await at(CONFIG.USERS_TABLE, { query: `/${rid}` }))); }
  catch { localStorage.removeItem("mcoins_rid"); }
})();
