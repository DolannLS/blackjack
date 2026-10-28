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

  // ---------- shop & weekly rewards ----------
  // Prices are checked again by the server; this list only drives the display.
  const SHOP = [
    { id: "tapis", kind: "banner", name: "Tapis vert", price: 0 },
    { id: "nuit-etoilee", kind: "banner", name: "Nuit étoilée", price: 400 },
    { id: "velours", kind: "banner", name: "Velours rouge", price: 400 },
    { id: "riviera", kind: "banner", name: "Riviera", price: 500 },
    { id: "coucher", kind: "banner", name: "Coucher de soleil", price: 600 },
    { id: "art-deco", kind: "banner", name: "Art déco", price: 700 },
    { id: "cartes", kind: "banner", name: "Jeu de cartes", price: 800 },
    { id: "jetons", kind: "banner", name: "Pile de jetons", price: 800 },
    { id: "marbre", kind: "banner", name: "Marbre", price: 1000 },
    { id: "aurore", kind: "banner", name: "Aurore boréale", price: 1500 },
    { id: "or-champion", kind: "banner", name: "Or du champion", price: null, how: "1ᵉʳ de la semaine" },
    { id: "argent-podium", kind: "banner", name: "Argent du podium", price: null, how: "2ᵉ de la semaine" },
    { id: "bronze-podium", kind: "banner", name: "Bronze du podium", price: null, how: "3ᵉ de la semaine" },
    { id: "aucun", kind: "frame", name: "Sans cadre", price: 0 },
    { id: "laiton", kind: "frame", name: "Laiton", price: 300 },
    { id: "emeraude", kind: "frame", name: "Émeraude", price: 500 },
    { id: "rubis", kind: "frame", name: "Rubis", price: 500 },
    { id: "saphir", kind: "frame", name: "Saphir", price: 500 },
    { id: "prisme", kind: "frame", name: "Prisme", price: 900 },
    { id: "flammes", kind: "frame", name: "Flammes", price: 1200 },
    { id: "couronne", kind: "frame", name: "Couronne", price: null, how: "1ᵉʳ de la semaine" },
    { id: "sans-titre", kind: "title", name: "Sans titre", price: 0 },
    { id: "chanceux", kind: "title", name: "Chanceux", price: 150 },
    { id: "flambeur", kind: "title", name: "Flambeur", price: 250 },
    { id: "requin", kind: "title", name: "Requin", price: 400 },
    { id: "as-du-bluff", kind: "title", name: "As du bluff", price: 400 },
    { id: "compteur", kind: "title", name: "Compteur de cartes", price: 400 },
    { id: "high-roller", kind: "title", name: "High roller", price: 800 },
    { id: "legende", kind: "title", name: "Légende du casino", price: 1500 },
    { id: "champion", kind: "title", name: "Champion de la semaine", price: null, how: "1ᵉʳ de la semaine" },
    { id: "podium", kind: "title", name: "Sur le podium", price: null, how: "2ᵉ ou 3ᵉ de la semaine" }
  ];
  const ITEM = Object.fromEntries(SHOP.map(x => [x.id, x]));
  // weekly prizes by global weekly rank (players with at least 10 games that week)
  const PRIZES = [
    { ranks: "1ᵉʳ", crowns: 1000, items: ["or-champion", "couronne", "champion"] },
    { ranks: "2ᵉ", crowns: 600, items: ["argent-podium", "podium"] },
    { ranks: "3ᵉ", crowns: 400, items: ["bronze-podium", "podium"] },
    { ranks: "4ᵉ à 10ᵉ", crowns: 200, items: [] },
    { ranks: "Tous les autres classés", crowns: 50, items: [] }
  ];
  const PROFILE = "casino.profile";
  let profile = read(PROFILE, null);
  if (profile && session && profile.username !== session.username) profile = null;
  function keepProfile(p) {
    profile = p;
    write(PROFILE, p);
    emit();
  }
  async function loadProfile() {
    const p = await api("/rest/v1/rpc/my_profile", { method: "POST", body: {} });
    if (p) keepProfile(p);
    return p;
  }
  const SHOP_ERR = {
    solde: "Pas assez de couronnes pour l'instant.", exclusif: "Cet objet se gagne uniquement en récompense.",
    possede: "Tu l'as déjà.", non_possede: "Achète-le d'abord.", introuvable: "Objet introuvable."
  };
  const shopError = e => new Error(SHOP_ERR[e.raw] || (/my_profile|buy_item|equip|function/.test(e.raw || "") ? "Le serveur n'a pas encore la mise à jour de la boutique." : e.message));
  async function buy(id) {
    try {
      const left = await api("/rest/v1/rpc/buy_item", { method: "POST", body: { item: id } });
      if (profile) keepProfile({ ...profile, crowns: left, owned: [...new Set([...(profile.owned || []), id])] });
      return left;
    } catch (e) { throw shopError(e); }
  }
  async function equip(id) {
    try {
      await api("/rest/v1/rpc/equip", { method: "POST", body: { item: id } });
      const kind = ITEM[id].kind;
      if (profile) keepProfile({ ...profile, [kind]: id });
    } catch (e) { throw shopError(e); }
  }
  const markRewardsSeen = () => api("/rest/v1/rpc/mark_rewards_seen", { method: "POST", body: {} })
    .then(() => profile && keepProfile({ ...profile, rewards: [] }));
  // falls back to the older all-time ranking while the server lacks the shop update
  const leaderboardBy = (scope, max = 50, period = "all") =>
    api("/rest/v1/rpc/leaderboard", { method: "POST", body: { scope, max_rows: max, period } }).catch(e => {
      if (e.status !== 404 && !/leaderboard|function/i.test(e.raw || "")) throw e;
      if (period === "week") throw new Error("Le classement de la semaine arrive avec la mise à jour du serveur.");
      return api("/rest/v1/rpc/leaderboard", { method: "POST", body: { scope, max_rows: max } });
    });

  // ---------- shared player card ----------
  const escHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function avatarHTML(name, frame, size = "") {
    return `<span class="av ${size} fr-${frame || "aucun"}">${escHTML((name || "?")[0].toUpperCase())}</span>`;
  }
  function titleText(id) {
    const t = ITEM[id];
    return t && t.kind === "title" && t.id !== "sans-titre" ? t.name : "";
  }
  function cardHTML({ name, banner, frame, title, sub = "", right = "", cls = "" }) {
    const t = titleText(title);
    const special = ITEM[title] && ITEM[title].price === null ? " gold" : "";
    return `<div class="pcard bn-${banner || "tapis"} ${cls}">
      ${avatarHTML(name, frame, "lg")}
      <div class="pc-who"><b>${escHTML(name)}</b>${t ? `<span class="pc-title${special}">${escHTML(t)}</span>` : ""}${sub ? `<span class="pc-sub">${sub}</span>` : ""}</div>
      ${right ? `<div class="pc-right">${right}</div>` : ""}
    </div>`;
  }

  window.CasinoAccount = {
    configured, GAMES, get session() { return session; }, get profile() { return profile; },
    signUp, signIn, logout, record, flush, pending, history, leaderboard: leaderboardBy, addFriend, removeFriend,
    myInvite, resetInvite, inviteInfo, acceptInvite, inviteUrl, parseInvite, pendingInvite, NAME_RE,
    SHOP, ITEM, PRIZES, loadProfile, buy, equip, markRewardsSeen,
    localHistory: () => read(HISTORY, []),
    onChange: f => { listeners.add(f); return () => listeners.delete(f); }
  };
  window.CasinoUI = { cardHTML, avatarHTML, titleText, esc: escHTML };
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });
  setTimeout(flush, 800);

  // ---------- look & motion shared by every page ----------
  const ICONS = {
    blackjack: '<rect x="3" y="6" width="11" height="15" rx="2"/><path d="M9.5 5.2l7.8-1.6a2 2 0 0 1 2.4 1.5l2.2 10.6a2 2 0 0 1-1.5 2.4L14 19.6"/>',
    roulette: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    poker: '<path d="M12 3c-2.6 3.6-7 6-7 10a3.5 3.5 0 0 0 6.1 2.3L10 20.5h4l-1.1-5.2A3.5 3.5 0 0 0 19 13c0-4-4.4-6.4-7-10z"/>',
    shop: '<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    rank: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4.2M17 6h3a3 3 0 0 1-3 4.2"/>'
  };
  const TABS = [
    ["./", "blackjack", "Blackjack", /(^$|index\.html$)/],
    ["roulette.html", "roulette", "Roulette", /roulette\.html$/],
    ["poker.html", "poker", "Poker", /(poker|online)\.html$/],
    ["boutique.html", "shop", "Boutique", /boutique\.html$/],
    ["historique.html", "history", "Historique", /historique\.html$/],
    ["classement.html", "rank", "Classement", /classement\.html$/]
  ];
  const page = location.pathname.split("/").pop();
  const STAR = (x, y, s = 1.4) => `radial-gradient(${s}px ${s}px at ${x}% ${y}%, #fff 50%, transparent 100%)`;
  const SUITS_SVG = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56"><g fill="#fff" fill-opacity=".09" font-family="Georgia" font-size="18"><text x="4" y="20">♠</text><text x="32" y="20">♥</text><text x="18" y="48">♦</text><text x="44" y="48">♣</text></g></svg>');
  const GRAIN = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .5 0"/></filter><rect width="160" height="160" filter="url(#n)" opacity=".35"/></svg>');
  const css = document.createElement("style");
  css.textContent = `
@view-transition { navigation: auto; }
::view-transition-old(root) { animation: vt-out .18s ease both; }
::view-transition-new(root) { animation: vt-in .26s cubic-bezier(.2,.8,.25,1) both; }
@keyframes vt-out { to { opacity: 0; } }
@keyframes vt-in { from { opacity: 0; transform: translateY(8px); } }
.tabbar { view-transition-name: tabbar; }
.bar { view-transition-name: topbar; }

body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: url("${GRAIN}"); opacity: .5; mix-blend-mode: soft-light; z-index: 0; }
.app { position: relative; z-index: 1; }

/* header */
.bar { min-height: 46px; }
.bank strong { transition: color .3s; }

/* buttons: shared press feel */
.btn, .chip, .small-btn, .icon-btn, .seg button, .chips button, .tabbar a, .acct-chip, .x { transition: transform .12s ease, background-color .2s, color .2s, box-shadow .2s, opacity .2s; }
.btn:active:not(:disabled), .small-btn:active, .icon-btn:active, .x:active, .acct-chip:active { transform: scale(.96); }
.btn.primary { background: linear-gradient(180deg, #e6c483, var(--brass) 55%, #c49a50); box-shadow: inset 0 1px 0 rgba(255,255,255,.45), 0 4px 14px rgba(0,0,0,.25); }

/* bottom tab bar */
.tray .chips, #chips { padding: 8px 2px 2px 6px; margin: -8px -2px -2px -6px; }
.msg-wrap { margin-block: 2px; }
.tabbar { flex: none; position: relative; margin-top: 8px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 0; padding: 6px 4px 2px; border-radius: 18px 18px 0 0; background: rgba(3, 18, 14, .62); border-top: 1px solid var(--felt-line); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); margin-inline: -6px; margin-bottom: -6px; }
.tabbar a { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 5px 0 4px; border-radius: 12px; color: var(--muted); text-decoration: none; font-size: 10px; font-weight: 600; letter-spacing: 0; white-space: nowrap; min-width: 0; }
.tabbar a svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform .25s cubic-bezier(.3,1.6,.5,1); }
.tabbar a[aria-current] { color: var(--brass); }
.tabbar a[aria-current]::before { content: ""; position: absolute; inset: 1px 6px; border-radius: 12px; background: rgba(216,178,106,.13); animation: tab-in .3s cubic-bezier(.3,1.4,.5,1) both; z-index: -1; }
.tabbar a[aria-current] svg { transform: translateY(-1px) scale(1.08); }
.tabbar a:active svg { transform: scale(.88); }
@keyframes tab-in { from { transform: scale(.6); opacity: 0; } }
.tabbar a:focus-visible, .acct-chip:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

/* account chip */
.acct-chip { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px 0 5px; border-radius: 19px; background: var(--glass); border: 1px solid var(--felt-line); color: var(--ink); text-decoration: none; font-size: 14px; font-weight: 600; max-width: 46vw; min-width: 0; }
.acct-chip > span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acct-chip.out .av { background: transparent; color: var(--muted); border: 1.5px dashed var(--felt-line); box-sizing: border-box; }

/* avatars and frames */
.av { position: relative; flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--brass); color: var(--brass-ink); display: grid; place-items: center; font-size: 13px; font-weight: 700; font-family: var(--f-ui); }
.av.md { width: 38px; height: 38px; font-size: 16px; }
.av.lg { width: 52px; height: 52px; font-size: 22px; }
.av::before { content: ""; position: absolute; inset: -4px; border-radius: 50%; pointer-events: none;
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px)); }
.fr-laiton::before { background: linear-gradient(135deg, #f4dca0, #a8823e); }
.fr-emeraude::before { background: linear-gradient(135deg, #7ff0b0, #12804a); } .fr-emeraude { box-shadow: 0 0 12px rgba(47,191,113,.55); }
.fr-rubis::before { background: linear-gradient(135deg, #ff9aa8, #b3132f); } .fr-rubis { box-shadow: 0 0 12px rgba(224,67,90,.55); }
.fr-saphir::before { background: linear-gradient(135deg, #a8c6ff, #1f4fd1); } .fr-saphir { box-shadow: 0 0 12px rgba(59,123,255,.55); }
.fr-prisme::before { background: conic-gradient(#ff5f6d, #ffc371, #7cf29a, #4facfe, #b06ab3, #ff5f6d); animation: spin 4s linear infinite; }
.fr-flammes::before { background: conic-gradient(from 0deg, #ff3d00, #ffb300, #ff6f00, #ffe082, #ff3d00); animation: spin 1.6s linear infinite; }
.fr-flammes { box-shadow: 0 0 14px rgba(255,120,0,.65); }
.fr-couronne::before { background: linear-gradient(135deg, #fff3c4, #e9c46a 40%, #8a6420); }
.fr-couronne::after { content: "♛"; position: absolute; top: -.95em; left: 50%; transform: translateX(-50%); font-size: .8em; color: #f2cf6b; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
@keyframes spin { to { transform: rotate(360deg); } }

/* banners */
.pcard { position: relative; isolation: isolate; overflow: hidden; display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; padding: 16px; border-radius: 18px; border: 1px solid rgba(255,255,255,.14); color: #fff; min-height: 64px; }
.pcard::after { content: ""; position: absolute; inset: 0; z-index: -1; background: linear-gradient(90deg, rgba(0,0,0,.5), rgba(0,0,0,.12) 65%, rgba(0,0,0,.3)); }
.pcard .av { z-index: 1; }
.pc-who { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pc-who b { font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
.pc-title { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #f1dfb0; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
.pc-title.gold { background: linear-gradient(90deg, #fff3c4, #e9c46a, #fff3c4); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-sub { font-size: 13px; color: rgba(255,255,255,.75); }
.pc-right { text-align: right; font-variant-numeric: tabular-nums; }
[class*="bn-"] { background-color: #0b3d30; }
.bn-tapis { background: radial-gradient(circle at 25% 20%, #1c7259, #0d4536 55%, #062a21); }
.bn-nuit-etoilee { background: ${STAR(12, 30)}, ${STAR(28, 70, 1)}, ${STAR(46, 22, 1.8)}, ${STAR(63, 60, 1.1)}, ${STAR(78, 28)}, ${STAR(90, 75, 1.6)}, ${STAR(55, 85, 1)}, linear-gradient(160deg, #0a1433, #1d2b5c 60%, #3b2a63); }
.bn-velours { background: radial-gradient(ellipse at 30% 0%, rgba(255,255,255,.18), transparent 55%), linear-gradient(115deg, #3d0911, #8e1b2c 42%, #5a0f1c 62%, #2b060c); }
.bn-riviera { background: radial-gradient(ellipse at 80% 120%, rgba(255,240,200,.55), transparent 60%), linear-gradient(165deg, #06485a, #0f8792 50%, #3ec1b8); }
.bn-coucher { background: radial-gradient(circle at 78% 85%, #ffd27a 0 10%, transparent 11%), linear-gradient(175deg, #2a1b4a, #a83a5c 55%, #f0954b); }
.bn-art-deco { background: repeating-conic-gradient(from -90deg at 50% 130%, rgba(216,178,106,.55) 0 1.5deg, transparent 1.5deg 10deg), linear-gradient(#15171c, #0c0d10); }
.bn-cartes { background: url("${SUITS_SVG}"), linear-gradient(135deg, #4a0f19, #2a0710); }
.bn-jetons { background: radial-gradient(circle at 50% 50%, #c43a3a 0 9px, #f2eee3 9px 11px, #c43a3a 11px 13px, transparent 13.5px) 0 0 / 38px 38px, radial-gradient(circle at 50% 50%, #1d1f24 0 9px, #f2eee3 9px 11px, #1d1f24 11px 13px, transparent 13.5px) 19px 19px / 38px 38px, linear-gradient(#0d4536, #072a21); }
.bn-marbre { background: linear-gradient(115deg, transparent 40%, rgba(80,80,90,.45) 41%, transparent 43%), linear-gradient(35deg, transparent 60%, rgba(120,110,100,.4) 61%, transparent 62.5%), linear-gradient(160deg, transparent 20%, rgba(90,90,100,.3) 21%, transparent 22%), linear-gradient(135deg, #e9e6e0, #b9b5ad 60%, #8f8a82); }
.bn-aurore { background: linear-gradient(120deg, #071723, #0f5c4a, #3fd69b, #5a3fa0, #071723); background-size: 300% 100%; animation: drift 9s ease-in-out infinite alternate; }
.bn-or-champion { background: linear-gradient(110deg, #6d4c12, #e9c46a 35%, #fff3c4 45%, #e9c46a 55%, #6d4c12); background-size: 250% 100%; animation: shine 4s linear infinite; }
.bn-argent-podium { background: linear-gradient(110deg, #4b525c, #c9cfd6 35%, #ffffff 45%, #c9cfd6 55%, #4b525c); background-size: 250% 100%; animation: shine 5s linear infinite; }
.bn-bronze-podium { background: linear-gradient(110deg, #5a3416, #c98b5a 35%, #f3c9a4 45%, #c98b5a 55%, #5a3416); background-size: 250% 100%; animation: shine 5s linear infinite; }
@keyframes shine { from { background-position: 100% 0; } to { background-position: -150% 0; } }
@keyframes drift { to { background-position: 100% 0; } }

/* lists rise in */
.rise { animation: rise .42s cubic-bezier(.2,.8,.25,1) both; animation-delay: calc(var(--i, 0) * 35ms); }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } }
.scrim:not([hidden]) { animation: fade .2s ease both; }
@keyframes fade { from { opacity: 0; } }

/* weekly reward celebration */
.reward-scrim { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.6); display: grid; place-items: center; padding: 20px; animation: fade .25s both; }
.reward-box { position: relative; width: min(100%, 380px); max-height: 88vh; overflow-y: auto; box-sizing: border-box; border-radius: 24px; padding: 24px 20px 20px; background: linear-gradient(160deg, #0f4c3c, #062a21); border: 1px solid var(--brass); text-align: center; display: flex; flex-direction: column; gap: 14px; animation: pop-in .5s cubic-bezier(.3,1.5,.5,1) both; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
@keyframes pop-in { from { transform: scale(.7); opacity: 0; } }
.reward-box h2 { margin: 0; font-family: var(--f-display); font-weight: 400; font-size: 28px; color: var(--ink); }
.reward-box p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
.reward-crowns { font-size: 40px; font-weight: 700; color: var(--brass); font-variant-numeric: tabular-nums; }
.reward-items { display: flex; flex-direction: column; gap: 8px; text-align: left; }
.reward-canvas { position: fixed; inset: 0; pointer-events: none; z-index: 51; width: 100%; height: 100%; }
.crown-ico { display: inline-block; width: 1em; height: 1em; vertical-align: -.12em; }

@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  .rise, .bn-aurore, .bn-or-champion, .bn-argent-podium, .bn-bronze-podium, .fr-prisme::before, .fr-flammes::before { animation: none !important; }
}`;
  document.head.appendChild(css);
  const CROWN = '<svg class="crown-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 8l4.5 4L12 5l4.5 7L21 8l-1.8 10.5a1 1 0 0 1-1 .8H5.8a1 1 0 0 1-1-.8L3 8z"/></svg>';
  window.CasinoUI.CROWN = CROWN;

  function chipHTML() {
    const n = session && session.username;
    if (!n) return `<span class="av">?</span><span>Se connecter</span>`;
    return `${avatarHTML(n, profile && profile.frame)}<span>${escHTML(n)}</span>`;
  }
  function mountNav() {
    const app = document.querySelector(".app");
    if (!app || app.querySelector(".tabbar")) return;
    const old = app.querySelector("nav.switch");
    const chip = document.createElement("a");
    chip.href = "classement.html";
    const paint = () => {
      chip.className = "acct-chip" + (session ? "" : " out");
      chip.setAttribute("aria-label", session ? `Compte de ${session.username}` : "Se connecter");
      chip.innerHTML = chipHTML();
    };
    paint();
    if (old) old.replaceWith(chip);
    else { const bar = app.querySelector(".bar"); if (bar && bar.children.length > 1) bar.insertBefore(chip, bar.children[1]); }
    listeners.add(paint);
    const nav = document.createElement("nav");
    nav.className = "tabbar";
    nav.setAttribute("aria-label", "Onglets");
    nav.innerHTML = TABS.map(([href, icon, label, re]) =>
      `<a href="${href}"${re.test(page) ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>${label}</a>`).join("");
    app.appendChild(nav);
    animateBank();
  }

  // the balance counts up or down instead of jumping
  function animateBank() {
    const el = document.getElementById("bank");
    if (!el || !window.MutationObserver) return;
    const num = t => { const v = parseFloat(String(t).replace(/[\s  ]/g, "").replace(",", ".")); return isNaN(v) ? null : v; };
    let shown = num(el.textContent), mine = null, raf = 0;
    const fmtN = n => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
    new MutationObserver(() => {
      if (el.textContent === mine) return;
      const target = num(el.textContent);
      if (target === null || shown === null || target === shown || matchMedia("(prefers-reduced-motion: reduce)").matches) { shown = target; return; }
      const from = shown, t0 = performance.now(), D = Math.min(700, 250 + Math.abs(target - from) / 4);
      cancelAnimationFrame(raf);
      el.style.color = target > from ? "var(--win, #7fd99a)" : "";
      const step = now => {
        const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3);
        mine = k < 1 ? fmtN(Math.round((from + (target - from) * e) * 100) / 100) : fmtN(target);
        el.textContent = mine;
        if (k < 1) raf = requestAnimationFrame(step); else { shown = target; setTimeout(() => el.style.color = "", 350); }
      };
      raf = requestAnimationFrame(step);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  // ---------- weekly reward celebration ----------
  function confetti() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cv = document.createElement("canvas");
    cv.className = "reward-canvas";
    document.body.appendChild(cv);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    const colors = ["#d8b26a", "#fff3c4", "#c43a3a", "#2f8a55", "#f2eee3", "#6b3fa0"];
    const parts = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2, y: innerHeight * .42, vx: (Math.random() - .5) * 12, vy: -Math.random() * 13 - 3,
      r: Math.random() * Math.PI, vr: (Math.random() - .5) * .4, w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
      c: colors[Math.floor(Math.random() * colors.length)]
    }));
    const t0 = performance.now();
    const step = now => {
      g.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += .32; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
      }
      if (now - t0 < 3200) requestAnimationFrame(step); else cv.remove();
    };
    requestAnimationFrame(step);
  }
  function rankText(r) { return r === 1 ? "1ᵉʳ" : r + "ᵉ"; }
  function showRewards(list) {
    if (!list || !list.length || document.querySelector(".reward-scrim")) return;
    const total = list.reduce((a, r) => a + r.crowns, 0);
    const best = list.reduce((a, r) => Math.min(a, r.rank), 99);
    const items = [...new Set(list.flatMap(r => r.items || []))];
    const box = document.createElement("div");
    box.className = "reward-scrim";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML = `<div class="reward-box">
      <h2>${best <= 3 ? "Sur le podium !" : "Récompense de la semaine"}</h2>
      <p>${list.length > 1 ? `${list.length} semaines clôturées. Meilleure place : ${rankText(best)}.` : `La semaine est terminée : tu finis ${rankText(best)} du classement général.`}</p>
      <div class="reward-crowns">+${total.toLocaleString("fr-FR")} ${CROWN}</div>
      ${items.length ? `<div class="reward-items">${items.map(id => ITEM[id] ? (ITEM[id].kind === "banner"
        ? cardHTML({ name: session.username, banner: id, frame: profile && profile.frame, title: profile && profile.title, sub: "Nouvelle bannière : " + ITEM[id].name })
        : `<div class="pcard bn-tapis">${avatarHTML(session.username, ITEM[id].kind === "frame" ? id : profile && profile.frame, "md")}<div class="pc-who"><b>${escHTML(ITEM[id].name)}</b><span class="pc-sub">${ITEM[id].kind === "frame" ? "Nouveau cadre" : "Nouveau titre"}</span></div></div>`) : "").join("")}</div>` : ""}
      <button class="btn primary" type="button">Récupérer</button>
      <a href="boutique.html" class="btn" style="text-decoration:none;color:inherit">Voir la boutique</a>
    </div>`;
    document.body.appendChild(box);
    confetti();
    const done = () => { box.remove(); markRewardsSeen().catch(() => {}); };
    box.querySelector("button").onclick = done;
    box.querySelector("a").onclick = () => { markRewardsSeen().catch(() => {}); };
  }
  async function checkRewards() {
    if (!configured() || !session || navigator.onLine === false) return;
    try { const p = await loadProfile(); if (p && p.rewards && p.rewards.length) showRewards(p.rewards); } catch (e) {}
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountNav); else mountNav();
  setTimeout(checkRewards, 1200);
})();
