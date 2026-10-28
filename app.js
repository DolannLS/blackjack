// Shared by every page: bottom tab bar, account chip, and the account/history client.
// Accounts, history and rankings live in Supabase; play keeps working offline and
// results are uploaded once the phone is back online.
(() => {
  // Supabase project (the anon key is public by design; access is limited by row level security)
  const CFG = {
    url: "https://mwzcdwiceofeaqjtfcpt.supabase.co",
    key: "sb_publishable_jvE8n4KNwK60G6ZWcq9I5g_qkgB2Oii"
  };
  const EMAIL_DOMAIN = "joueurs.casino-app.fr";
  const SESSION = "casino.session", QUEUE = "casino.queue", HISTORY = "casino.history";
  const GAMES = { blackjack: "Blackjack", roulette: "Roulette", holdem: "Hold'em", videopoker: "Vidéo poker", online: "Poker en ligne" };

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const configured = () => !!(CFG.url && CFG.key);

  // ---------- auth ----------
  let session = read(SESSION, null);
  const listeners = new Set();
  const emit = () => listeners.forEach(f => { try { f(session); } catch (e) {} });

  async function api(path, { method = "GET", body, auth = true, headers = {} } = {}) {
    if (!configured()) throw Object.assign(new Error("Les comptes ne sont pas encore configurés."), { code: "config" });
    const h = { apikey: CFG.key, "Content-Type": "application/json", ...headers };
    if (auth) {
      const t = await token();
      if (!t) throw Object.assign(new Error("Connecte-toi d'abord."), { code: "auth" });
      h.Authorization = "Bearer " + t;
    }
    let r;
    try { r = await fetch(CFG.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw Object.assign(new Error("Pas de connexion internet."), { code: "network" }); }
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
    if (!r.ok) {
      const raw = (data && (data.msg || data.message || data.error_description || data.error)) || String(r.status);
      throw Object.assign(new Error(raw), { status: r.status, raw });
    }
    return data;
  }

  function keep(res) {
    const meta = (res.user && res.user.user_metadata) || {};
    session = {
      access_token: res.access_token, refresh_token: res.refresh_token,
      expires_at: res.expires_at || Math.floor(Date.now() / 1000) + (res.expires_in || 3600),
      user_id: res.user ? res.user.id : session && session.user_id,
      username: meta.username || (session && session.username) || ""
    };
    write(SESSION, session);
    emit();
  }

  async function token() {
    if (!session) return null;
    if (Date.now() / 1000 < session.expires_at - 60) return session.access_token;
    try {
      const res = await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", auth: false, body: { refresh_token: session.refresh_token } });
      keep(res);
      return session.access_token;
    } catch (e) {
      if (e.status === 400 || e.status === 401) { logout(); return null; }
      throw e;
    }
  }

  const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
  const emailFor = name => `${name.toLowerCase()}@${EMAIL_DOMAIN}`;
  function friendly(e) {
    const m = String(e.raw || e.message || "");
    if (e.code) return e.message;
    if (/already registered|already exists|duplicate/i.test(m)) return "Ce pseudo est déjà pris.";
    if (/invalid login credentials/i.test(m)) return "Pseudo ou mot de passe incorrect.";
    if (/password should be at least|weak password/i.test(m)) return "Le mot de passe doit faire au moins 6 caractères.";
    if (/email not confirmed/i.test(m)) return "Le compte attend une confirmation par email : désactive « Confirm email » dans Supabase.";
    if (/rate limit|too many/i.test(m)) return "Trop d'essais d'affilée. Réessaie dans une minute.";
    return "Erreur du serveur : " + m;
  }

  async function signUp(name, password) {
    name = name.trim();
    if (!NAME_RE.test(name)) throw new Error("Le pseudo fait 3 à 16 caractères : lettres sans accent, chiffres, - ou _.");
    if (password.length < 6) throw new Error("Le mot de passe doit faire au moins 6 caractères.");
    try {
      const res = await api("/auth/v1/signup", { method: "POST", auth: false, body: { email: emailFor(name), password, data: { username: name } } });
      if (!res || !res.access_token) throw new Error("Compte créé, mais Supabase demande une confirmation par email : désactive « Confirm email » dans Authentication → Sign In / Providers.");
      keep(res);
    } catch (e) { throw new Error(friendly(e)); }
  }
  async function signIn(name, password) {
    name = name.trim();
    if (!name || !password) throw new Error("Entre ton pseudo et ton mot de passe.");
    try {
      const res = await api("/auth/v1/token?grant_type=password", { method: "POST", auth: false, body: { email: emailFor(name), password } });
      keep(res);
    } catch (e) { throw new Error(friendly(e)); }
    flush();
  }
  function logout() {
    const t = session && session.access_token;
    if (t && configured()) fetch(CFG.url + "/auth/v1/logout", { method: "POST", headers: { apikey: CFG.key, Authorization: "Bearer " + t } }).catch(() => {});
    session = null;
    write(SESSION, null);
    emit();
  }

  // ---------- results ----------
  function record(game, stake, payout, detail) {
    if (!GAMES[game]) return;
    const e = { cid: uuid(), game, stake: Math.round(stake * 100) / 100, payout: Math.round(payout * 100) / 100, detail: String(detail || "").slice(0, 80), at: new Date().toISOString() };
    const hist = read(HISTORY, []);
    hist.unshift(e);
    write(HISTORY, hist.slice(0, 300));
    if (session) {
      const q = read(QUEUE, []);
      q.push({ ...e, uid: session.user_id });
      write(QUEUE, q.slice(-1000));
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 1500);
    }
  }
  let flushTimer, flushing = false;
  async function flush() {
    if (flushing || !configured() || !session || navigator.onLine === false) return;
    const mine = read(QUEUE, []).filter(x => x.uid === session.user_id).slice(0, 200);
    if (!mine.length) return;
    flushing = true;
    try {
      await api("/rest/v1/games?on_conflict=client_id", {
        method: "POST",
        headers: { Prefer: "return=minimal,resolution=ignore-duplicates" },
        body: mine.map(x => ({ game: x.game, stake: x.stake, payout: x.payout, detail: x.detail, played_at: x.at, client_id: x.cid }))
      });
      const sent = new Set(mine.map(x => x.cid));
      write(QUEUE, read(QUEUE, []).filter(x => !sent.has(x.cid)));
    } catch (e) {
      // keep the queue; it is retried on the next result, page load or reconnection
    } finally { flushing = false; }
  }
  const pending = () => session ? read(QUEUE, []).filter(x => x.uid === session.user_id) : [];

  async function history(limit = 200) {
    const rows = await api(`/rest/v1/games?select=game,stake,payout,detail,played_at,client_id&order=played_at.desc&limit=${limit}`);
    return rows.map(r => ({ cid: r.client_id, game: r.game, stake: +r.stake, payout: +r.payout, detail: r.detail, at: r.played_at }));
  }
  const leaderboard = (scope, max = 50) => api("/rest/v1/rpc/leaderboard", { method: "POST", body: { scope, max_rows: max } });
  async function addFriend(name) {
    const r = await api("/rest/v1/rpc/add_friend", { method: "POST", body: { friend_name: name } });
    if (r === "introuvable") throw new Error(`Aucun joueur nommé « ${name} ».`);
    if (r === "soi") throw new Error("C'est toi !");
    return r;
  }
  const removeFriend = name => api("/rest/v1/rpc/remove_friend", { method: "POST", body: { friend_name: name } });

  // ---------- personal invitation (QR code) ----------
  const INVITE = "casino.invite";
  const myInvite = () => api("/rest/v1/rpc/my_invite", { method: "POST", body: {} });
  const resetInvite = () => api("/rest/v1/rpc/reset_invite", { method: "POST", body: {} });
  const inviteInfo = code => api("/rest/v1/rpc/invite_info", { method: "POST", auth: false, body: { code } });
  async function acceptInvite(code) {
    const r = await api("/rest/v1/rpc/accept_invite", { method: "POST", body: { code } });
    if (r === "introuvable") throw new Error("Ce QR code n'est plus valable. Demande à ton ami de te remontrer le sien.");
    if (r === "soi") throw new Error("C'est ton propre QR code !");
    return r;
  }
  const inviteUrl = code => new URL("classement.html", location.href).href.split("#")[0] + "#invite=" + code;
  // pull an invitation code out of a scanned text or link
  const parseInvite = text => {
    const m = String(text).match(/invite=([0-9A-Za-z]{6,12})/) || String(text).trim().match(/^([0-9A-Fa-f]{8})$/);
    return m ? m[1].toUpperCase() : null;
  };
  const fromLink = parseInvite(location.hash);
  if (fromLink) write(INVITE, fromLink);
  const pendingInvite = {
    get: () => read(INVITE, null),
    clear: () => write(INVITE, null)
  };

  window.CasinoAccount = {
    configured, GAMES, get session() { return session; },
    signUp, signIn, logout, record, flush, pending, history, leaderboard, addFriend, removeFriend,
    myInvite, resetInvite, inviteInfo, acceptInvite, inviteUrl, parseInvite, pendingInvite, NAME_RE,
    localHistory: () => read(HISTORY, []),
    onChange: f => { listeners.add(f); return () => listeners.delete(f); }
  };
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });
  setTimeout(flush, 800);

  // ---------- navigation ----------
  const ICONS = {
    blackjack: '<rect x="3" y="6" width="11" height="15" rx="2"/><path d="M9.5 5.2l7.8-1.6a2 2 0 0 1 2.4 1.5l2.2 10.6a2 2 0 0 1-1.5 2.4L14 19.6"/>',
    roulette: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    poker: '<path d="M12 3c-2.6 3.6-7 6-7 10a3.5 3.5 0 0 0 6.1 2.3L10 20.5h4l-1.1-5.2A3.5 3.5 0 0 0 19 13c0-4-4.4-6.4-7-10z"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    rank: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4.2M17 6h3a3 3 0 0 1-3 4.2"/>'
  };
  const TABS = [
    ["./", "blackjack", "Blackjack", /(^$|index\.html$)/],
    ["roulette.html", "roulette", "Roulette", /roulette\.html$/],
    ["poker.html", "poker", "Poker", /(poker|online)\.html$/],
    ["historique.html", "history", "Historique", /historique\.html$/],
    ["classement.html", "rank", "Classement", /classement\.html$/]
  ];
  const page = location.pathname.split("/").pop();
  const css = document.createElement("style");
  css.textContent = `
.tabbar { flex: none; margin-top: 6px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; border-top: 1px solid var(--felt-line); padding-top: 6px; margin-bottom: -4px; }
.tabbar a { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 3px 0; border-radius: 10px; color: var(--muted); text-decoration: none; font-size: 10.5px; font-weight: 600; letter-spacing: .01em; }
.tabbar a svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.tabbar a[aria-current] { color: var(--brass); }
.tabbar a:focus-visible, .acct-chip:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
.acct-chip { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 12px 0 6px; border-radius: 18px; background: var(--glass); border: 1px solid var(--felt-line); color: var(--ink); text-decoration: none; font-size: 14px; font-weight: 600; max-width: 46vw; }
.acct-chip span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acct-chip .av { flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--brass); color: var(--brass-ink); display: grid; place-items: center; font-size: 13px; font-weight: 700; }
.acct-chip.out .av { background: transparent; color: var(--muted); border: 1.5px dashed var(--felt-line); box-sizing: border-box; }`;
  document.head.appendChild(css);

  function chipHTML() {
    const n = session && session.username;
    return n ? `<span class="av">${n[0].toUpperCase()}</span><span>${n.replace(/[<>&"]/g, "")}</span>` : `<span class="av">?</span><span>Se connecter</span>`;
  }
  function mountNav() {
    const app = document.querySelector(".app");
    if (!app || app.querySelector(".tabbar")) return;
    const old = app.querySelector("nav.switch");
    const chip = document.createElement("a");
    chip.href = "classement.html";
    chip.className = "acct-chip" + (session ? "" : " out");
    chip.setAttribute("aria-label", session ? `Compte de ${session.username}` : "Se connecter");
    chip.innerHTML = chipHTML();
    if (old) old.replaceWith(chip);
    else { const bar = app.querySelector(".bar"); if (bar && bar.children.length > 1) bar.insertBefore(chip, bar.children[1]); }
    listeners.add(() => { chip.className = "acct-chip" + (session ? "" : " out"); chip.innerHTML = chipHTML(); });
    const nav = document.createElement("nav");
    nav.className = "tabbar";
    nav.setAttribute("aria-label", "Onglets");
    nav.innerHTML = TABS.map(([href, icon, label, re]) =>
      `<a href="${href}"${re.test(page) ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>${label}</a>`).join("");
    app.appendChild(nav);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountNav); else mountNav();
})();
