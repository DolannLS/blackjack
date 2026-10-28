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
      if (typeof afterFlush === "function") afterFlush();
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
    { id: "vegas", kind: "banner", name: "Néons de Vegas", price: 700 },
    { id: "monaco", kind: "banner", name: "Monaco", price: 900 },
    { id: "jade", kind: "banner", name: "Jade", price: 500 },
    { id: "braise", kind: "banner", name: "Braise", price: 600 },
    { id: "glacier", kind: "banner", name: "Glacier", price: 600 },
    { id: "cuir", kind: "banner", name: "Cuir club", price: 500 },
    { id: "pop", kind: "banner", name: "Pop", price: 400 },
    { id: "damier", kind: "banner", name: "Damier", price: 450 },
    { id: "feutre-bleu", kind: "banner", name: "Feutre bleu", price: 350 },
    { id: "sakura", kind: "banner", name: "Sakura", price: 650 },
    { id: "aucun", kind: "frame", name: "Sans cadre", price: 0 },
    { id: "laiton", kind: "frame", name: "Laiton", price: 300 },
    { id: "emeraude", kind: "frame", name: "Émeraude", price: 500 },
    { id: "rubis", kind: "frame", name: "Rubis", price: 500 },
    { id: "saphir", kind: "frame", name: "Saphir", price: 500 },
    { id: "prisme", kind: "frame", name: "Prisme", price: 900 },
    { id: "flammes", kind: "frame", name: "Flammes", price: 1200 },
    { id: "or-rose", kind: "frame", name: "Or rose", price: 450 },
    { id: "onyx", kind: "frame", name: "Onyx", price: 400 },
    { id: "perle", kind: "frame", name: "Perle", price: 600 },
    { id: "turquoise", kind: "frame", name: "Turquoise", price: 500 },
    { id: "ambre", kind: "frame", name: "Ambre", price: 500 },
    { id: "couronne", kind: "frame", name: "Couronne", price: null, how: "1ᵉʳ de la semaine, tant que tu le restes" },
    { id: "sans-titre", kind: "title", name: "Sans titre", price: 0 },
    { id: "chanceux", kind: "title", name: "Chanceux", price: 150 },
    { id: "flambeur", kind: "title", name: "Flambeur", price: 250 },
    { id: "requin", kind: "title", name: "Requin", price: 400 },
    { id: "as-du-bluff", kind: "title", name: "As du bluff", price: 400 },
    { id: "compteur", kind: "title", name: "Compteur de cartes", price: 400 },
    { id: "high-roller", kind: "title", name: "High roller", price: 800 },
    { id: "legende", kind: "title", name: "Légende du casino", price: 1500 },
    { id: "beau-joueur", kind: "title", name: "Beau joueur", price: 150 },
    { id: "roi-du-tapis", kind: "title", name: "Roi du tapis", price: 700 },
    { id: "tete-brulee", kind: "title", name: "Tête brûlée", price: 300 },
    { id: "gros-poisson", kind: "title", name: "Gros poisson", price: 350 },
    { id: "main-chaude", kind: "title", name: "Main chaude", price: 300 },
    { id: "sang-froid", kind: "title", name: "Sang-froid", price: 450 },
    { id: "pro-du-split", kind: "title", name: "Pro du split", price: 350 },
    { id: "roi-roulette", kind: "title", name: "Roi de la roulette", price: 600 },
    { id: "ocean-profond", kind: "banner", name: "Océan profond", price: 600 },
    { id: "lagon", kind: "banner", name: "Lagon", price: 500 },
    { id: "desert", kind: "banner", name: "Désert", price: 450 },
    { id: "foret", kind: "banner", name: "Forêt", price: 450 },
    { id: "volcan", kind: "banner", name: "Volcan", price: 900 },
    { id: "cosmos", kind: "banner", name: "Cosmos", price: 1400 },
    { id: "neige", kind: "banner", name: "Neige", price: 400 },
    { id: "automne", kind: "banner", name: "Automne", price: 450 },
    { id: "lavande", kind: "banner", name: "Lavande", price: 500 },
    { id: "menthe", kind: "banner", name: "Menthe glaciale", price: 500 },
    { id: "rubis-royal", kind: "banner", name: "Rubis royal", price: 1100 },
    { id: "saphir-nuit", kind: "banner", name: "Saphir de nuit", price: 1100 },
    { id: "emeraude-casino", kind: "banner", name: "Émeraude du casino", price: 1200 },
    { id: "retro-80", kind: "banner", name: "Rétro 80", price: 900 },
    { id: "synthwave", kind: "banner", name: "Synthwave", price: 1000 },
    { id: "tartan", kind: "banner", name: "Tartan", price: 550 },
    { id: "pied-de-poule", kind: "banner", name: "Pied-de-poule", price: 600 },
    { id: "bayadere", kind: "banner", name: "Bayadère", price: 450 },
    { id: "mosaique", kind: "banner", name: "Mosaïque", price: 700 },
    { id: "ondes", kind: "banner", name: "Ondes", price: 550 },
    { id: "eclair", kind: "banner", name: "Éclair", price: 800 },
    { id: "roue", kind: "banner", name: "Roue de roulette", price: 1000 },
    { id: "des", kind: "banner", name: "Coup de dés", price: 650 },
    { id: "tapis-rouge", kind: "banner", name: "Tapis rouge", price: 1800 },
    { id: "argent-poli", kind: "frame", name: "Argent poli", price: 300 },
    { id: "bronze-antique", kind: "frame", name: "Bronze antique", price: 300 },
    { id: "cuivre", kind: "frame", name: "Cuivre", price: 350 },
    { id: "jade-imperial", kind: "frame", name: "Jade impérial", price: 600 },
    { id: "amethyste", kind: "frame", name: "Améthyste", price: 600 },
    { id: "grenat", kind: "frame", name: "Grenat", price: 550 },
    { id: "citrine", kind: "frame", name: "Citrine", price: 550 },
    { id: "opale", kind: "frame", name: "Opale", price: 1100 },
    { id: "neon-rose", kind: "frame", name: "Néon rose", price: 800 },
    { id: "neon-cyan", kind: "frame", name: "Néon cyan", price: 800 },
    { id: "galaxie", kind: "frame", name: "Galaxie", price: 1400 },
    { id: "arc-or", kind: "frame", name: "Arc doré", price: 700 },
    { id: "pointilles", kind: "frame", name: "Pointillés", price: 300 },
    { id: "electrique", kind: "frame", name: "Électrique", price: 1300 },
    { id: "la-bankroll", kind: "title", name: "La Bankroll", price: 600 },
    { id: "croupier-fou", kind: "title", name: "Croupier fou", price: 300 },
    { id: "maitre-du-bluff", kind: "title", name: "Maître du bluff", price: 700 },
    { id: "jamais-deux", kind: "title", name: "Jamais deux sans trois", price: 350 },
    { id: "coup-de-poker", kind: "title", name: "Coup de poker", price: 300 },
    { id: "coeur-de-pierre", kind: "title", name: "Cœur de pierre", price: 450 },
    { id: "tapis-volant", kind: "title", name: "Tapis volant", price: 400 },
    { id: "roi-de-coeur", kind: "title", name: "Roi de cœur", price: 500 },
    { id: "reine-de-pique", kind: "title", name: "Reine de pique", price: 500 },
    { id: "valet-de-carreau", kind: "title", name: "Valet de carreau", price: 400 },
    { id: "as-de-trefle", kind: "title", name: "As de trèfle", price: 600 },
    { id: "mains-d-argent", kind: "title", name: "Mains d'argent", price: 450 },
    { id: "joueur-nocturne", kind: "title", name: "Joueur nocturne", price: 250 },
    { id: "chasseur-jackpot", kind: "title", name: "Chasseur de jackpot", price: 800 },
    { id: "rien-ne-va-plus", kind: "title", name: "Rien ne va plus", price: 350 },
    { id: "faites-vos-jeux", kind: "title", name: "Faites vos jeux", price: 200 },
    { id: "banco", kind: "title", name: "Banco", price: 300 },
    { id: "double-ou-rien", kind: "title", name: "Double ou rien", price: 550 },
    { id: "oeil-de-lynx", kind: "title", name: "Œil de lynx", price: 450 },
    { id: "sans-peur", kind: "title", name: "Sans peur", price: 900 },
    { id: "eclipse", kind: "banner", name: "Éclipse", price: 1300 },
    { id: "tropiques", kind: "banner", name: "Tropiques", price: 500 },
    { id: "minuit", kind: "banner", name: "Minuit", price: 400 },
    { id: "orage", kind: "banner", name: "Orage", price: 750 },
    { id: "marbre-noir", kind: "banner", name: "Marbre noir", price: 900 },
    { id: "marbre-blanc", kind: "banner", name: "Marbre blanc", price: 900 },
    { id: "or-massif", kind: "banner", name: "Or massif", price: 2000 },
    { id: "bambou", kind: "banner", name: "Bambou", price: 500 },
    { id: "corail", kind: "banner", name: "Récif de corail", price: 650 },
    { id: "nebuleuse", kind: "banner", name: "Nébuleuse", price: 1200 },
    { id: "code-vert", kind: "banner", name: "Code vert", price: 800 },
    { id: "pixel", kind: "banner", name: "Pixel", price: 600 },
    { id: "zebre", kind: "banner", name: "Zèbre", price: 550 },
    { id: "leopard", kind: "banner", name: "Léopard", price: 650 },
    { id: "camouflage", kind: "banner", name: "Camouflage", price: 450 },
    { id: "arc-en-ciel", kind: "banner", name: "Arc-en-ciel", price: 700 },
    { id: "bonbon", kind: "banner", name: "Bonbon", price: 400 },
    { id: "cerise", kind: "banner", name: "Cerise", price: 450 },
    { id: "agrumes", kind: "banner", name: "Agrumes", price: 450 },
    { id: "pluie-jetons", kind: "banner", name: "Pluie de jetons", price: 1100 },
    { id: "main-gagnante", kind: "banner", name: "Main gagnante", price: 900 },
    { id: "porte-bonheur", kind: "banner", name: "Trèfle porte-bonheur", price: 700 },
    { id: "gatsby", kind: "banner", name: "Gatsby", price: 1300 },
    { id: "vitrail", kind: "banner", name: "Vitrail", price: 1000 },
    { id: "origami", kind: "banner", name: "Origami", price: 550 },
    { id: "circuit", kind: "banner", name: "Circuit", price: 800 },
    { id: "lave", kind: "banner", name: "Lave", price: 950 },
    { id: "abysses", kind: "banner", name: "Abysses", price: 850 },
    { id: "crepuscule", kind: "banner", name: "Crépuscule", price: 500 },
    { id: "champagne", kind: "banner", name: "Champagne", price: 1500 },
    { id: "platine-pur", kind: "frame", name: "Platine pur", price: 900 },
    { id: "obsidienne", kind: "frame", name: "Obsidienne", price: 650 },
    { id: "corail-vif", kind: "frame", name: "Corail", price: 450 },
    { id: "menthe-givree", kind: "frame", name: "Menthe givrée", price: 450 },
    { id: "lilas", kind: "frame", name: "Lilas", price: 400 },
    { id: "feu-glace", kind: "frame", name: "Feu et glace", price: 1300 },
    { id: "ruban-arc-en-ciel", kind: "frame", name: "Ruban arc-en-ciel", price: 1000 },
    { id: "aurore-polaire", kind: "frame", name: "Aurore polaire", price: 1200 },
    { id: "chrome", kind: "frame", name: "Chrome", price: 700 },
    { id: "coulee-lave", kind: "frame", name: "Coulée de lave", price: 1100 },
    { id: "tournesol", kind: "frame", name: "Tournesol", price: 500 },
    { id: "nuit-bleue", kind: "frame", name: "Nuit bleue", price: 450 },
    { id: "diamant-noir", kind: "frame", name: "Diamant noir", price: 1600 },
    { id: "jeton", kind: "frame", name: "Jeton de casino", price: 800 },
    { id: "fleur-cerisier", kind: "frame", name: "Fleur de cerisier", price: 600 },
    { id: "toxique", kind: "frame", name: "Toxique", price: 750 },
    { id: "all-in", kind: "title", name: "All-in", price: 500 },
    { id: "le-croupier", kind: "title", name: "Le Croupier", price: 400 },
    { id: "vingt-et-un", kind: "title", name: "Vingt-et-un", price: 350 },
    { id: "poker-face", kind: "title", name: "Poker face", price: 600 },
    { id: "le-parrain", kind: "title", name: "Le Parrain", price: 1200 },
    { id: "nerfs-d-acier", kind: "title", name: "Nerfs d'acier", price: 500 },
    { id: "petit-joueur", kind: "title", name: "Petit joueur", price: 100 },
    { id: "roi-de-la-river", kind: "title", name: "Roi de la river", price: 650 },
    { id: "zero-pointe", kind: "title", name: "Zéro pointé", price: 200 },
    { id: "quinte-royale", kind: "title", name: "Quinte flush royale", price: 1500 },
    { id: "fortune", kind: "title", name: "Fortune", price: 700 },
    { id: "le-stratege", kind: "title", name: "Le Stratège", price: 450 },
    { id: "chat-noir", kind: "title", name: "Chat noir", price: 300 },
    { id: "trefle-a-quatre", kind: "title", name: "Trèfle à quatre feuilles", price: 550 },
    { id: "baron", kind: "title", name: "Baron du casino", price: 900 },
    { id: "duchesse", kind: "title", name: "Duchesse", price: 900 },
    { id: "mise-max", kind: "title", name: "Mise max", price: 400 },
    { id: "pas-de-chance", kind: "title", name: "Pas de chance", price: 150 },
    { id: "le-calculateur", kind: "title", name: "Le Calculateur", price: 500 },
    { id: "grand-seigneur", kind: "title", name: "Grand seigneur", price: 750 },
    { id: "tout-ou-rien", kind: "title", name: "Tout ou rien", price: 450 },
    { id: "loup-du-tapis", kind: "title", name: "Loup du tapis", price: 800 },
    { id: "maitre-zen", kind: "title", name: "Maître zen", price: 350 },
    { id: "nuit-blanche", kind: "title", name: "Nuit blanche", price: 300 },
    { id: "champion", kind: "title", name: "Champion de la semaine", price: null, how: "1ᵉʳ de la semaine, tant que tu le restes" }
  ];
  const STATIC = Object.fromEntries(SHOP.map(x => [x.id, x]));
  // monthly season ranks, lowest first (mirrors supabase/casier.sql)
  const TIERS = [
    { id: "bronze", name: "Bronze", min: 20, crowns: 100, base: "Joueur du dimanche" },
    { id: "fer", name: "Fer", min: 100, crowns: 200, base: "Main de fer" },
    { id: "argent", name: "Argent", min: 250, crowns: 350, base: "Joueur d'argent" },
    { id: "or", name: "Or", min: 400, crowns: 550, base: "Main en or" },
    { id: "platine", name: "Platine", min: 600, crowns: 800, base: "Mise de platine" },
    { id: "diamant", name: "Diamant", min: 1000, crowns: 1200, base: "Cœur de diamant" },
    { id: "alexandrite", name: "Alexandrite", min: 2000, crowns: 2000, base: "Alexandrite" },
    { id: "top-100", name: "Top 100", min: 2000, crowns: 3000, base: "Top 100", note: "100 meilleurs, dès 2 000 points" }
  ];
  const TIER = Object.fromEntries(TIERS.map(t => [t.id, t]));
  const CHAMPION = { id: "champion", name: "Champion", crowns: 5000, base: "Champion de la saison", note: "1ᵉʳ de la saison, dès le rang Argent" };
  // season 1 = October 2026; each season has its own banner, frame and title for every rank
  const seasonNumber = (d = new Date()) => (d.getFullYear() - 2026) * 12 + d.getMonth() + 1 - 10 + 1;
  const SEASON_RE = /^s(\d+)-([a-z0-9-]+?)(-cadre|-titre)?$/;
  function itemInfo(id) {
    if (!id) return null;
    if (STATIC[id]) return STATIC[id];
    const m = SEASON_RE.exec(id);
    if (!m) return null;
    const t = m[2] === "champion" ? CHAMPION : TIER[m[2]];
    if (!t) return null;
    const n = +m[1], kind = m[3] === "-cadre" ? "frame" : m[3] === "-titre" ? "title" : "banner";
    return { id, kind, season: n, tier: t.id, price: null, how: `${t.id === "champion" ? "Champion" : "rang " + t.name} de la saison ${n}`,
      name: kind === "title" ? `${t.base} · S${n}` : `Saison ${n} · ${t.name}` };
  }
  const ITEM = new Proxy(STATIC, { get: (o, k) => (typeof k === "string" ? itemInfo(k) || undefined : o[k]) });
  const seasonSet = (n, tierId) => [`s${n}-${tierId}`, `s${n}-${tierId}-cadre`, `s${n}-${tierId}-titre`];
  // weekly prizes by global weekly rank (players with at least 10 games that week)
  const PRIZES = [
    { ranks: "1ᵉʳ", crowns: 1000, items: ["couronne", "champion"], note: "gardés tant que tu restes 1ᵉʳ" },
    { ranks: "2ᵉ", crowns: 600, items: [] },
    { ranks: "3ᵉ", crowns: 400, items: [] },
    { ranks: "4ᵉ à 10ᵉ", crowns: 200, items: [] },
    { ranks: "Tous les autres classés", crowns: 50, items: [] }
  ];
  function rarity(holders, players) {
    if (holders == null || !players) return null;
    const pct = holders / players * 100;
    const label = pct <= 2 ? "Légendaire" : pct <= 8 ? "Épique" : pct <= 25 ? "Rare" : "Commun";
    return { holders, players, pct, label, key: label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") };
  }
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
    possede: "Tu l'as déjà.", non_possede: "Cet objet n'est pas dans ton casier.", introuvable: "Objet introuvable.",
    hors_rotation: "Cet objet n'est plus en boutique cette semaine."
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
      const kind = itemInfo(id).kind;
      if (profile) keepProfile({ ...profile, [kind]: id });
    } catch (e) { throw shopError(e); }
  }
  const markRewardsSeen = () => api("/rest/v1/rpc/mark_rewards_seen", { method: "POST", body: {} })
    .then(() => profile && keepProfile({ ...profile, rewards: [], season_rewards: [] }));
  // falls back to the older all-time ranking while the server lacks the shop update
  const leaderboardBy = (scope, max = 50, period = "all") =>
    api("/rest/v1/rpc/leaderboard", { method: "POST", body: { scope, max_rows: max, period } }).catch(e => {
      if (e.status !== 404 && !/leaderboard|function/i.test(e.raw || "")) throw e;
      if (period === "week") throw new Error("Le classement de la semaine arrive avec la mise à jour du serveur.");
      return api("/rest/v1/rpc/leaderboard", { method: "POST", body: { scope, max_rows: max } });
    });
  // locker, weekly shop, rarity, search
  const shopWeek = () => api("/rest/v1/rpc/shop_week", { method: "POST", body: {} });
  const itemStats = () => api("/rest/v1/rpc/item_stats", { method: "POST", body: {} });
  const locker = () => api("/rest/v1/rpc/locker", { method: "POST", body: {} });
  const searchPlayers = q => api("/rest/v1/rpc/search_players", { method: "POST", body: { q } });

  // profile photo: cropped to a 256 px square JPEG on the phone, then uploaded to the player's own folder
  function squareJpeg(file) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight), out = 256;
        const cv = document.createElement("canvas");
        cv.width = cv.height = out;
        cv.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
        URL.revokeObjectURL(url);
        cv.toBlob(b => (b ? ok(b) : ko(new Error("Image illisible."))), "image/jpeg", .86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("Ce fichier n'est pas une image lisible. Essaie une photo JPEG ou PNG.")); };
      img.src = url;
    });
  }
  async function uploadAvatar(file) {
    if (!session) throw new Error("Connecte-toi d'abord.");
    const blob = await squareJpeg(file);
    const t = await token();
    const path = `${session.user_id}/${Date.now()}.jpg`;
    let r;
    try {
      r = await fetch(`${CFG.url}/storage/v1/object/avatars/${path}`, {
        method: "POST", headers: { apikey: CFG.key, Authorization: "Bearer " + t, "Content-Type": "image/jpeg", "x-upsert": "true" }, body: blob
      });
    } catch (e) { throw new Error("Pas de connexion internet."); }
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(/bucket not found|not found/i.test(txt) ? "Le serveur n'a pas encore la mise à jour des photos." : "Envoi de la photo impossible : " + txt.slice(0, 80));
    }
    const pub = `${CFG.url}/storage/v1/object/public/avatars/${path}`;
    await api("/rest/v1/rpc/set_avatar", { method: "POST", body: { url: pub } });
    if (profile) keepProfile({ ...profile, avatar_url: pub });
    return pub;
  }
  async function removeAvatar() {
    await api("/rest/v1/rpc/set_avatar", { method: "POST", body: { url: null } });
    if (profile) keepProfile({ ...profile, avatar_url: null });
  }

  // ---------- shared player card ----------
  const escHTML = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (typeof u === "string" && /^https:\/\/[^"'<>\s]+$/.test(u) ? u : "");
  function avatarHTML(name, frame, size = "", photo = "") {
    const src = safeUrl(photo);
    return `<span class="av ${size} fr-${escHTML(frame || "aucun")}${src ? " has-photo" : ""}">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : escHTML((name || "?")[0].toUpperCase())}</span>`;
  }
  function titleText(id) {
    const t = itemInfo(id);
    return t && t.kind === "title" && t.id !== "sans-titre" ? t.name : "";
  }
  function cardHTML({ name, banner, frame, title, avatar = "", sub = "", right = "", cls = "" }) {
    const t = titleText(title);
    const it = itemInfo(title);
    const special = it && it.price === null ? " gold" : "";
    return `<div class="pcard bn-${escHTML(banner || "tapis")} ${cls}">
      ${avatarHTML(name, frame, "lg", avatar)}
      <div class="pc-who"><b>${escHTML(name)}</b>${t ? `<span class="pc-title${special}">${escHTML(t)}</span>` : ""}${sub ? `<span class="pc-sub">${sub}</span>` : ""}</div>
      ${right ? `<div class="pc-right">${right}</div>` : ""}
    </div>`;
  }

  // seasons, public profiles, account settings, live activity
  const seasonBoard = (scope, max = 50) => api("/rest/v1/rpc/season_board", { method: "POST", body: { scope, max_rows: max } });
  const publicProfile = name => api("/rest/v1/rpc/public_profile", { method: "POST", body: { name } });
  const liveFeed = (max = 15) => api("/rest/v1/rpc/live_feed", { method: "POST", body: { max_rows: max } });
  const botsTick = () => api("/rest/v1/rpc/bots_tick", { method: "POST", body: {} }).catch(() => 0);
  const ACCOUNT_ERR = { pseudo_pris: "Ce pseudo est déjà pris.", pseudo_invalide: "Le pseudo fait 3 à 16 caractères : lettres sans accent, chiffres, - ou _." };
  async function renameAccount(name) {
    try {
      const n = await api("/rest/v1/rpc/rename_account", { method: "POST", body: { new_name: name } });
      session = { ...session, username: n };
      write(SESSION, session);
      if (profile) profile = { ...profile, username: n };
      write(PROFILE, profile);
      emit();
      return n;
    } catch (e) { throw new Error(ACCOUNT_ERR[e.raw] || (/rename_account/.test(e.raw || "") ? "Le serveur n'a pas encore la mise à jour des comptes." : friendly(e))); }
  }
  async function changePassword(current, next) {
    if (next.length < 6) throw new Error("Le nouveau mot de passe doit faire au moins 6 caractères.");
    try { await api("/auth/v1/token?grant_type=password", { method: "POST", auth: false, body: { email: emailFor(session.username), password: current } }); }
    catch (e) { throw new Error(/invalid login/i.test(e.raw || "") ? "Mot de passe actuel incorrect." : friendly(e)); }
    try { await api("/auth/v1/user", { method: "PUT", body: { password: next } }); }
    catch (e) { throw new Error(/same/i.test(e.raw || "") ? "Choisis un mot de passe différent de l'actuel." : friendly(e)); }
  }
  async function deleteAccount() {
    await api("/rest/v1/rpc/delete_account", { method: "POST", body: {} });
    write(QUEUE, []);
    write(PROFILE, null);
    profile = null;
    logout();
  }

  window.CasinoAccount = {
    configured, GAMES, get session() { return session; }, get profile() { return profile; },
    signUp, signIn, logout, record, flush, pending, history, leaderboard: leaderboardBy, addFriend, removeFriend,
    myInvite, resetInvite, inviteInfo, acceptInvite, inviteUrl, parseInvite, pendingInvite, NAME_RE,
    SHOP, ITEM, itemInfo, PRIZES, TIERS, TIER, CHAMPION, seasonNumber, seasonSet, rarity, loadProfile, buy, equip, markRewardsSeen,
    shopWeek, itemStats, locker, searchPlayers, uploadAvatar, removeAvatar,
    seasonBoard, publicProfile, liveFeed, botsTick, renameAccount, changePassword, deleteAccount,
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
    games: '<rect x="2.5" y="6" width="10" height="14" rx="1.6"/><path d="M8.5 5l7.4-1.5a1.6 1.6 0 0 1 1.9 1.3l2.6 12.4a1.6 1.6 0 0 1-1.3 1.9L14 20"/><path d="M7.5 10.5c-1.2 1.4-2.3 2.2-2.3 3.4a1.3 1.3 0 0 0 2.3.8 1.3 1.3 0 0 0 2.3-.8c0-1.2-1.1-2-2.3-3.4z"/>',
    challenge: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/><path d="M15.5 8.5L21 3M17.5 3H21v3.5"/>',
    ranks: '<path d="M7 3l5 6 5-6M8.5 3h7"/><circle cx="12" cy="15" r="6"/><path d="M12 12l.9 1.9 2.1.3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.4 2.1-.3z"/>',
    locker: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v18M9 10v2M15 10v2"/>',
    rank: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4.2M17 6h3a3 3 0 0 1-3 4.2"/>'
  };
  const TABS = [
    ["#jeux", "games", "Jeux", /(^$|index\.html$|roulette\.html$|poker\.html$|online\.html$)/],
    ["defis.html", "challenge", "Défis", /defis\.html$/],
    ["rangs.html", "ranks", "Rangs", /rangs\.html$/],
    ["boutique.html", "shop", "Boutique", /boutique\.html$/],
    ["casier.html", "locker", "Casier", /casier\.html$/],
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

html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
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
.tabbar { flex: none; position: relative; margin-top: 8px; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0; padding: 6px 2px 2px; border-radius: 18px 18px 0 0; background: rgba(3, 18, 14, .62); border-top: 1px solid var(--felt-line); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); margin-inline: -6px; margin-bottom: -6px; }
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
.table-return { flex: none; position: relative; z-index: 5; display: flex; align-items: center; gap: 8px; margin: 2px 0 6px; padding: 6px 10px; border-radius: 12px; background: rgba(8,38,29,.9); border: 1px solid rgba(216,178,106,.45); color: var(--ink, #fff); text-decoration: none; font-size: 12.5px; animation: tr-in .35s cubic-bezier(.3,1.4,.5,1) both; }
.table-return > span:nth-child(2) { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.table-return small { color: var(--muted, #aab); font-size: 11.5px; }
.table-return .tr-go { color: var(--brass, #d8b26a); font-weight: 700; white-space: nowrap; }
.table-return .tr-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: #5fd38a; box-shadow: 0 0 0 0 rgba(95,211,138,.6); animation: tr-pulse 1.6s ease-out infinite; }
@keyframes tr-in { from { opacity: 0; transform: translateY(-6px); } }
@keyframes tr-pulse { to { box-shadow: 0 0 0 8px rgba(95,211,138,0); } }

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

  // games: one tab opens a picker; it remembers the last game played
  const GAME_PAGES = [
    { href: "./", page: "blackjack", name: "Blackjack", text: "Bats le croupier sans dépasser 21.", icon: "blackjack" },
    { href: "roulette.html", page: "roulette", name: "Roulette", text: "Mise sur un numéro, une couleur ou une douzaine.", icon: "roulette" },
    { href: "poker.html", page: "poker", name: "Poker", text: "Texas Hold'em contre 3 adversaires, et vidéo poker.", icon: "poker" },
    { href: "online.html", page: "online", name: "Poker en ligne", text: "Une table entre amis, de 2 à 6 joueurs.", icon: "games" }
  ];
  function lastGame() {
    const p = (location.pathname.split("/").pop() || "index.html").replace(".html", "");
    const here = GAME_PAGES.find(g => g.page === (p === "index" || p === "" ? "blackjack" : p));
    if (here) { try { localStorage.setItem("casino.lastgame", here.href); } catch (e) {} return here.href; }
    try { return localStorage.getItem("casino.lastgame") || "./"; } catch (e) { return "./"; }
  }
  function openGames() {
    const cur = document.body.dataset.page;
    openSheet((sheet) => {
      sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
        <div class="ph"><h2>Jeux</h2><button class="x" data-close aria-label="Fermer">×</button></div>
        <div class="gpick">${GAME_PAGES.map((g, i) => `<a class="gtile rise${g.page === cur ? " here" : ""}" style="--i:${i}" href="${g.href}">
          <span class="gico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[g.icon]}</svg></span>
          <span class="gtxt"><b>${g.name}</b><span>${g.text}</span></span>${g.page === cur ? `<span class="gnow">En cours</span>` : `<span class="go" aria-hidden="true">›</span>`}</a>`).join("")}</div>`;
    });
  }
  function chipHTML() {
    const n = session && session.username;
    if (!n) return `<span class="av"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><span>Se connecter</span>`;
    return `${avatarHTML(n, profile && profile.frame, "", profile && profile.avatar_url)}<span>${escHTML(n)}</span>`;
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
      `<a href="${href === "#jeux" ? lastGame() : href}"${href === "#jeux" ? ' data-games="1"' : ""}${re.test(page) ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>${label}</a>`).join("");
    nav.querySelector("[data-games]").addEventListener("click", e => { e.preventDefault(); openGames(); });
    app.appendChild(nav);
    mountTableReturn(app);
    animateBank();
  }

  // an online poker seat is kept while browsing the other pages: a pill leads back to the table
  function mountTableReturn(app) {
    if (page === "online.html") return;
    let t = null;
    try { t = JSON.parse(localStorage.getItem("online.table") || "null"); } catch (e) {}
    if (!t || !t.code || Date.now() - (t.at || 0) > 12 * 3600e3) return;
    const a = document.createElement("a");
    a.className = "table-return";
    a.href = "online.html";
    a.innerHTML = `<span class="tr-dot" aria-hidden="true"></span><span><b>Poker en ligne en cours</b> <small>· ${t.role === "host"
      ? "ta table est en pause sans toi"
      : "ta place est gardée"}</small></span><span class="tr-go">Revenir ›</span>`;
    const bar = app.querySelector(".bar");
    if (bar) bar.after(a); else app.prepend(a);
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
  function rankText(r) { return +r === 1 ? "1ᵉʳ" : r + "ᵉ"; }
  const monthName = d => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  function tierBadge(id, size = "") {
    const t = TIER[id];
    if (!t) return `<span class="tier none ${size}">Sans rang</span>`;
    return `<span class="tier t-${t.id} ${size}"><i aria-hidden="true"></i>${t.name}</span>`;
  }

  // ---------- extra look: ranks, season items, sheets ----------
  const css2 = document.createElement("style");
  css2.textContent = `
.tier { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px 0 6px; border-radius: 12px; font-size: 12px; font-weight: 700; letter-spacing: .04em; color: #111; background: var(--tc, #888); box-shadow: inset 0 1px 0 rgba(255,255,255,.5); white-space: nowrap; }
.tier i { width: 12px; height: 12px; background: rgba(255,255,255,.75); clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); }
.tier.lg { height: 30px; font-size: 14px; padding: 0 12px 0 8px; border-radius: 15px; }
.tier.none { background: rgba(255,255,255,.12); color: var(--muted, #aaa); box-shadow: none; }
.t-bronze { --tc: linear-gradient(135deg, #e3a978, #9a5f33); }
.t-fer { --tc: linear-gradient(135deg, #c3c8cf, #6d737c); }
.t-argent { --tc: linear-gradient(135deg, #f4f6f8, #a9b1ba); }
.t-platine { --tc: linear-gradient(135deg, #d9fff8, #6fd1c4); }
.t-diamant { --tc: linear-gradient(135deg, #e3f6ff, #6cc4ff 60%, #b6a2ff); }
.t-alexandrite { --tc: linear-gradient(135deg, #48d6a2, #2f8f74 45%, #9b4fc4); color: #fff; }
.t-top-100 { --tc: linear-gradient(135deg, #ffe08a, #ff9a4a 50%, #e8414f); }
.tier { background: var(--tc); }

.fr-cadre-platine::before { background: linear-gradient(135deg, #f0fffb, #6fd1c4, #e9fffb); }
.fr-cadre-diamant::before { background: conic-gradient(#e3f6ff, #6cc4ff, #ffffff, #b6a2ff, #e3f6ff); animation: spin 5s linear infinite; }
.fr-cadre-diamant { box-shadow: 0 0 14px rgba(140,200,255,.6); }
.fr-cadre-alexandrite::before { background: conic-gradient(#48d6a2, #2f8f74, #9b4fc4, #d07ae8, #48d6a2); animation: spin 3s linear infinite; }
.fr-cadre-alexandrite { box-shadow: 0 0 14px rgba(155,79,196,.55); }
.fr-cadre-champion-saison::before { background: conic-gradient(#fff3c4, #e9c46a, #e8414f, #e9c46a, #fff3c4); animation: spin 2.4s linear infinite; }
.fr-cadre-champion-saison { box-shadow: 0 0 16px rgba(233,196,106,.7); }
.fr-cadre-champion-saison::after { content: "♛"; position: absolute; top: -.95em; left: 50%; transform: translateX(-50%); font-size: .8em; color: #ffd76a; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
.bn-saison-diamant { background: conic-gradient(from 210deg at 70% 40%, rgba(255,255,255,.35), transparent 20%, rgba(182,162,255,.35) 35%, transparent 55%, rgba(108,196,255,.4) 75%, transparent), linear-gradient(135deg, #0d2a4a, #1f5f99 55%, #7fb8e8); }
.bn-saison-alexandrite { background: linear-gradient(120deg, #0c3b2e, #2f8f74, #9b4fc4, #3c1550, #0c3b2e); background-size: 300% 100%; animation: drift 7s ease-in-out infinite alternate; }
.bn-saison-top100 { background: repeating-linear-gradient(135deg, rgba(255,207,90,.22) 0 10px, transparent 10px 26px), linear-gradient(135deg, #2a0b10, #6a1520 60%, #b8323f); }
.bn-saison-champion { background: repeating-conic-gradient(from 0deg at 85% 50%, rgba(255,215,106,.28) 0 4deg, transparent 4deg 14deg), radial-gradient(circle at 85% 50%, #ffd76a 0 6%, transparent 30%), linear-gradient(135deg, #1d0b2e, #4a1660 60%, #7a2a52); }

.psheet-scrim { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.55); display: flex; align-items: flex-end; justify-content: center; animation: fade .2s both; }
.psheet { width: 100%; max-width: 560px; max-height: 92%; overflow-y: auto; -webkit-overflow-scrolling: touch; box-sizing: border-box; background: #0a3328; border-top: 1px solid var(--felt-line); border-radius: 22px 22px 0 0; padding: 14px max(18px, env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) max(18px, env(safe-area-inset-left, 0px)); display: flex; flex-direction: column; gap: 14px; animation: sheet-up .32s cubic-bezier(.2,.8,.25,1) both; color: var(--ink); font-family: var(--f-ui); }
.psheet > * { flex: none; }
@keyframes sheet-up { from { transform: translateY(100%); } }
.psheet .grab { width: 40px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.25); align-self: center; }
.psheet .ph { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.psheet h2 { margin: 0; font-family: var(--f-display); font-weight: 400; font-size: 24px; }
.psheet h3 { margin: 4px 0 0; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.psheet .x { width: 38px; height: 38px; border-radius: 50%; background: var(--glass); font-size: 20px; color: var(--ink); border: 0; }
.ps-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.ps-tile { background: var(--glass); border-radius: 12px; padding: 9px 10px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ps-tile span { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.ps-tile b { font-size: 17px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-box { background: var(--glass); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.ps-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 14px; }
.ps-row .m { color: var(--muted); }
.ps-bar { height: 8px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; }
.ps-bar i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #e6c483, var(--brass)); transform-origin: left; animation: grow .8s cubic-bezier(.2,.8,.25,1) both; }
@keyframes grow { from { transform: scaleX(0); } }
.ps-games { display: flex; flex-direction: column; gap: 6px; }
.ps-game { display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; font-size: 14px; font-variant-numeric: tabular-nums; }
.ps-game .m { color: var(--muted); font-size: 13px; }
.ps-seasons { display: flex; flex-direction: column; gap: 6px; }
.ps-plus { color: var(--win, #7fd99a); } .ps-minus { color: var(--lose, #ff8a7a); }
.ps-actions { display: grid; grid-template-columns: 1fr; gap: 8px; }
.ps-field { display: flex; flex-direction: column; gap: 6px; }
.ps-field label { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.ps-field input { height: 46px; border-radius: 12px; border: 1px solid var(--felt-line); background: rgba(0,0,0,.25); color: var(--ink); font: 600 16px var(--f-ui); padding: 0 12px; box-sizing: border-box; width: 100%; }
.ps-msg { min-height: 18px; font-size: 14px; color: var(--lose, #ff8a7a); }
.ps-msg.ok { color: var(--win, #7fd99a); }
.psheet .btn { height: 46px; border-radius: 14px; font-weight: 600; font-size: 15.5px; background: var(--glass); border: 1px solid var(--felt-line); color: var(--ink); display: flex; align-items: center; justify-content: center; padding: 0 14px; text-decoration: none; }
.psheet .btn.primary { color: var(--brass-ink); background: linear-gradient(180deg, #e6c483, var(--brass) 55%, #c49a50); border-color: var(--brass); box-shadow: inset 0 1px 0 rgba(255,255,255,.45); }
.psheet .btn.danger { color: var(--lose, #ff8a7a); }
.psheet .btn:disabled { opacity: .45; }
.psheet .loading { text-align: center; color: var(--muted); padding: 30px 0; }
.clickable { cursor: pointer; }
`;
  document.head.appendChild(css2);

  // ---------- reward celebration (week and season) ----------
  function itemLine(id) {
    const it = ITEM[id];
    if (!it || !session) return "";
    if (it.kind === "banner") return cardHTML({ name: session.username, banner: id, frame: profile && profile.frame, title: profile && profile.title, avatar: profile && profile.avatar_url, sub: "Nouvelle bannière : " + it.name });
    return `<div class="pcard bn-tapis">${avatarHTML(session.username, it.kind === "frame" ? id : profile && profile.frame, "md")}<div class="pc-who"><b>${escHTML(it.name)}</b><span class="pc-sub">${it.kind === "frame" ? "Nouveau cadre" : "Nouveau titre"}</span></div></div>`;
  }
  function showRewards(weeks, seasons) {
    weeks = weeks || []; seasons = seasons || [];
    if ((!weeks.length && !seasons.length) || document.querySelector(".reward-scrim")) return;
    const total = [...weeks, ...seasons].reduce((a, r) => a + r.crowns, 0);
    const items = [...new Set([...seasons, ...weeks].flatMap(r => r.items || []))];
    let head, text;
    const champ = seasons.find(r => r.champion);
    if (champ) { head = "Champion de la saison !"; text = `Tu termines 1ᵉʳ de la saison de ${monthName(champ.season)}.`; }
    else if (seasons.length) { const r = seasons[0]; head = "Fin de saison"; text = `Saison de ${monthName(r.season)} terminée au rang ${TIER[r.tier] ? TIER[r.tier].name : r.tier} (${rankText(r.rank)}).`; }
    else {
      const best = weeks.reduce((a, r) => Math.min(a, r.rank), 99);
      head = best <= 3 ? "Sur le podium !" : "Récompense de la semaine";
      text = weeks.length > 1 ? `${weeks.length} semaines clôturées. Meilleure place : ${rankText(best)}.` : `La semaine est terminée : tu finis ${rankText(best)} du classement général.`;
    }
    if (seasons.length && weeks.length) text += ` Et ${weeks.length} semaine${weeks.length > 1 ? "s" : ""} récompensée${weeks.length > 1 ? "s" : ""}.`;
    const box = document.createElement("div");
    box.className = "reward-scrim";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML = `<div class="reward-box">
      <h2>${head}</h2>
      ${seasons.length ? `<div style="display:flex;justify-content:center">${tierBadge(seasons[0].tier, "lg")}</div>` : ""}
      <p>${text}</p>
      <div class="reward-crowns">+${total.toLocaleString("fr-FR")} ${CROWN}</div>
      ${items.length ? `<div class="reward-items">${items.map(itemLine).join("")}</div>` : ""}
      <button class="btn primary" type="button">Récupérer</button>
      <a href="boutique.html" class="btn" style="text-decoration:none;color:inherit">Voir la boutique</a>
    </div>`;
    document.body.appendChild(box);
    confetti();
    box.querySelector("button").onclick = () => { box.remove(); markRewardsSeen().catch(() => {}); };
    box.querySelector("a").onclick = () => { markRewardsSeen().catch(() => {}); };
  }
  async function checkRewards() {
    if (!configured() || !session || navigator.onLine === false) return;
    try {
      const p = await loadProfile();
      if (p && ((p.rewards && p.rewards.length) || (p.season_rewards && p.season_rewards.length))) showRewards(p.rewards, p.season_rewards);
    } catch (e) {}
  }

  // ---------- sheets: public profile and account settings ----------
  function openSheet(build) {
    const scrim = document.createElement("div");
    scrim.className = "psheet-scrim";
    scrim.innerHTML = `<div class="psheet" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div><div class="loading">Chargement…</div></div>`;
    const sheet = scrim.firstElementChild;
    const close = () => { scrim.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") close(); };
    scrim.addEventListener("click", e => { if (e.target === scrim || e.target.closest("[data-close]")) close(); });
    document.addEventListener("keydown", onKey);
    // swipe down to close
    let y0 = null;
    sheet.addEventListener("touchstart", e => { y0 = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    sheet.addEventListener("touchend", e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 90) close(); y0 = null; }, { passive: true });
    document.body.appendChild(scrim);
    build(sheet, close);
    return close;
  }
  const fmtN = n => Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 });
  const signedN = n => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtN(Math.abs(n));
  const cls = n => n > 0 ? "ps-plus" : n < 0 ? "ps-minus" : "";

  function seasonBlock(se, label) {
    if (!se) return "";
    const pts = +se.points || 0;
    const cur = TIER[se.tier];
    const next = se.next_tier ? TIER[se.next_tier] : null;
    const from = cur ? cur.min : 0, to = next ? next.min : from;
    const pct = next ? Math.max(4, Math.min(100, (pts - from) / Math.max(1, to - from) * 100)) : 100;
    const end = se.season_end ? new Date(se.season_end) : null;
    const days = end ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null;
    return `<div class="ps-box">
      <div class="ps-row"><b>${label || "Saison de " + monthName(se.season)}</b>${tierBadge(se.tier)}</div>
      <div class="ps-row"><span class="m">${fmtN(pts)} points${se.rank ? ` · ${rankText(se.rank)} sur ${fmtN(se.players)}` : ""}</span><span class="m">${days !== null ? `fin dans ${days} j` : ""}</span></div>
      ${next ? `<div class="ps-bar" aria-label="Progression vers ${next.name}"><i style="width:${pct}%"></i></div>
      <div class="ps-row"><span class="m">Prochain rang : ${next.name}</span><span class="m">encore ${fmtN(next.min - pts)} pts</span></div>` : ""}
    </div>`;
  }

  async function openProfile(name) {
    openSheet(async (sheet, close) => {
      let p;
      try { p = await publicProfile(name); }
      catch (e) { sheet.innerHTML = `<div class="grab"></div><div class="ph"><h2>Profil</h2><button class="x" data-close aria-label="Fermer">×</button></div><p class="loading">${escHTML(e.code === "network" ? "Il faut internet pour voir les profils." : /public_profile/.test(e.raw || "") ? "Le serveur n'a pas encore la mise à jour des profils." : e.message)}</p>`; return; }
      if (!p) { sheet.innerHTML = `<div class="grab"></div><div class="ph"><h2>Profil</h2><button class="x" data-close aria-label="Fermer">×</button></div><p class="loading">Ce joueur n'existe plus.</p>`; return; }
      const st = p.stats || {}, games = +st.games || 0;
      const rate = games ? Math.round(+st.wins / games * 100) : 0;
      const since = p.since ? new Date(p.since).toLocaleDateString("fr-FR", { month: "short", year: "numeric" }) : "—";
      const tr = p.trophies || {};
      const right = p.season && p.season.tier ? tierBadge(p.season.tier) : "";
      sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
        <div class="ph"><h2>${p.is_me ? "Mon profil" : "Profil"}</h2><button class="x" data-close aria-label="Fermer">×</button></div>
        ${cardHTML({ name: p.username, banner: p.banner, frame: p.frame, title: p.title, avatar: p.avatar_url, sub: `Membre depuis ${since}`, right })}
        <div class="ps-actions">${p.is_me ? `<button class="btn" data-act="account">Modifier mon compte</button>`
          : p.is_friend ? `<button class="btn" disabled>Dans tes amis</button>` : `<button class="btn primary" data-act="friend">Ajouter en ami</button>`}</div>
        <div class="ps-msg" role="status"></div>
        <div class="ps-tiles">
          <div class="ps-tile"><span>Gains nets</span><b class="${cls(+st.net)}">${signedN(+st.net)}</b></div>
          <div class="ps-tile"><span>Parties</span><b>${fmtN(games)}</b></div>
          <div class="ps-tile"><span>Victoires</span><b>${rate} %</b></div>
          <div class="ps-tile"><span>Record</span><b>${+st.best > 0 ? "+" + fmtN(st.best) : "—"}</b></div>
          <div class="ps-tile"><span>Total misé</span><b>${fmtN(st.staked)}</b></div>
          <div class="ps-tile"><span>Semaine</span><b>${p.week && p.week.rank ? rankText(p.week.rank) : "—"}</b></div>
        </div>
        ${seasonBlock(p.season)}
        <h3>Trophées</h3>
        <div class="ps-box">
          <div class="ps-row"><span>Semaines gagnées</span><b>${fmtN(tr.week_wins)}</b></div>
          <div class="ps-row"><span>Podiums de la semaine</span><b>${fmtN(tr.week_podiums)}</b></div>
          <div class="ps-row"><span>Meilleure semaine</span><b>${tr.best_week ? rankText(tr.best_week) : "—"}</b></div>
          ${(tr.seasons || []).length ? `<div class="ps-seasons">${tr.seasons.map(x => `<div class="ps-row"><span>${monthName(x.season)}${x.champion ? " · Champion" : ""}</span>${tierBadge(x.tier)}</div>`).join("")}</div>` : `<div class="ps-row"><span class="m">Aucune saison terminée pour l'instant.</span></div>`}
        </div>
        ${(p.by_game || []).length ? `<h3>Par jeu</h3><div class="ps-box ps-games">${p.by_game.map(g => `<div class="ps-game"><span>${GAMES[g.game] || g.game}<br><span class="m">${fmtN(g.games)} parties · ${g.games ? Math.round(g.wins / g.games * 100) : 0} % gagnées</span></span><span></span><b class="${cls(+g.net)}">${signedN(+g.net)}</b></div>`).join("")}</div>` : ""}`;
      const msg = sheet.querySelector(".ps-msg");
      const act = sheet.querySelector("[data-act]");
      if (act) act.onclick = async () => {
        if (act.dataset.act === "account") { close(); openAccount(); return; }
        act.disabled = true;
        try { await addFriend(p.username); act.textContent = "Dans tes amis"; msg.className = "ps-msg ok"; msg.textContent = `${p.username} est dans tes amis.`; }
        catch (e) { act.disabled = false; msg.textContent = e.message; }
      };
    });
  }

  function openAccount() {
    if (!session) { location.href = "classement.html"; return; }
    openSheet((sheet, close) => {
      sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
        <div class="ph"><h2>Mon compte</h2><button class="x" data-close aria-label="Fermer">×</button></div>
        <form class="ps-box" data-f="name" novalidate>
          <div class="ps-field"><label for="acName">Pseudo</label><input id="acName" maxlength="16" autocapitalize="off" spellcheck="false" autocomplete="username" value="${escHTML(session.username)}"></div>
          <button class="btn primary" type="submit">Changer de pseudo</button>
          <div class="ps-msg" role="status"></div>
        </form>
        <form class="ps-box" data-f="pass" novalidate>
          <div class="ps-field"><label for="acOld">Mot de passe actuel</label><input id="acOld" type="password" autocomplete="current-password"></div>
          <div class="ps-field"><label for="acNew">Nouveau mot de passe</label><input id="acNew" type="password" autocomplete="new-password" placeholder="6 caractères minimum"></div>
          <div class="ps-field"><label for="acNew2">Confirme le nouveau</label><input id="acNew2" type="password" autocomplete="new-password"></div>
          <button class="btn primary" type="submit">Changer de mot de passe</button>
          <div class="ps-msg" role="status"></div>
        </form>
        <div class="ps-box">
          <button class="btn" data-act="profile">Voir mon profil public</button>
          <button class="btn" data-act="logout">Se déconnecter</button>
        </div>
        <form class="ps-box" data-f="delete" novalidate>
          <div class="ps-field"><label for="acDel">Supprimer le compte : tape ton pseudo</label><input id="acDel" autocapitalize="off" spellcheck="false" placeholder="${escHTML(session.username)}"></div>
          <button class="btn danger" type="submit">Supprimer définitivement</button>
          <div class="ps-msg" role="status"></div>
        </form>`;
      const say = (form, t, ok) => { const m = form.querySelector(".ps-msg"); m.className = "ps-msg" + (ok ? " ok" : ""); m.textContent = t; };
      sheet.querySelectorAll("form").forEach(form => form.addEventListener("submit", async e => {
        e.preventDefault();
        const btn = form.querySelector("button"); btn.disabled = true; say(form, "");
        try {
          if (form.dataset.f === "name") {
            const v = form.querySelector("#acName").value.trim();
            if (v === session.username) throw new Error("C'est déjà ton pseudo.");
            const n = await renameAccount(v);
            say(form, `Tu t'appelles maintenant ${n}. Utilise ce pseudo pour te connecter.`, true);
          } else if (form.dataset.f === "pass") {
            const a = form.querySelector("#acOld").value, b = form.querySelector("#acNew").value, c = form.querySelector("#acNew2").value;
            if (!a) throw new Error("Entre ton mot de passe actuel.");
            if (b !== c) throw new Error("Les deux nouveaux mots de passe ne sont pas identiques.");
            await changePassword(a, b);
            form.reset();
            say(form, "Mot de passe changé.", true);
          } else {
            if (form.querySelector("#acDel").value.trim() !== session.username) throw new Error("Tape exactement ton pseudo pour confirmer.");
            await deleteAccount();
            close();
            location.href = "classement.html";
            return;
          }
        } catch (err) { say(form, err.message); }
        btn.disabled = false;
      }));
      sheet.querySelector('[data-act="profile"]').onclick = () => { const n = session.username; close(); openProfile(n); };
      sheet.querySelector('[data-act="logout"]').onclick = () => { logout(); close(); };
    });
  }
  Object.assign(window.CasinoUI, { tierBadge, openProfile, openAccount, seasonBlock, rankText, monthName });

  // ---------- devices, responsive layouts, season items, photos, search ----------
  (function deviceClasses() {
    const ua = navigator.userAgent || "", root = document.documentElement;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const touch = matchMedia("(pointer: coarse)").matches;
    const minSide = Math.min(screen.width, screen.height);
    root.classList.add(ios ? "is-ios" : android ? "is-android" : "is-other");
    root.classList.add(touch ? (minSide >= 600 ? "is-tablet" : "is-phone") : "is-desktop");
    if (navigator.standalone || matchMedia("(display-mode: standalone)").matches) root.classList.add("is-standalone");
    const p = (location.pathname.split("/").pop() || "index.html").replace(".html", "") || "index";
    const name = { index: "blackjack", "": "blackjack" }[p] || p;
    const set = () => document.body && (document.body.dataset.page = name);
    if (document.body) set(); else document.addEventListener("DOMContentLoaded", set);
  })();

  // season banners and frames are drawn from their tier colours and the season number
  const PAL = {
    bronze: ["#5c3417", "#e3a978"], fer: ["#2c3138", "#b4bcc6"], argent: ["#56606c", "#f4f6f8"], or: ["#6b4a0e", "#ffd76a"],
    platine: ["#1d5a54", "#d9fff8"], diamant: ["#16406f", "#bfe8ff"], alexandrite: ["#145641", "#c07ae8"],
    "top-100": ["#5a0f19", "#ffcf5a"], champion: ["#2a0b3d", "#ffd76a"]
  };
  const MOTIFS = [
    (a, b) => `repeating-linear-gradient(135deg, ${b}55 0 7px, transparent 7px 20px)`,
    (a, b) => `repeating-linear-gradient(45deg, ${b}40 0 6px, transparent 6px 16px), repeating-linear-gradient(-45deg, ${b}40 0 6px, transparent 6px 16px)`,
    (a, b) => `repeating-conic-gradient(from 0deg at 88% 50%, ${b}55 0 5deg, transparent 5deg 15deg)`,
    (a, b) => `radial-gradient(${b}66 1.6px, transparent 2.2px) 0 0 / 14px 14px`,
    (a, b) => `repeating-radial-gradient(circle at 100% 50%, ${b}50 0 3px, transparent 3px 15px)`,
    (a, b) => `conic-gradient(from 45deg, ${b}38 25%, transparent 0 50%, ${b}38 0 75%, transparent 0) 0 0 / 24px 24px`
  ];
  const seasonCSS = document.createElement("style");
  document.head.appendChild(seasonCSS);
  const madeCSS = new Set();
  function seasonRule(cls) {
    if (madeCSS.has(cls)) return;
    madeCSS.add(cls);
    const m = /^(bn|fr)-s(\d+)-([a-z0-9-]+?)(-cadre)?$/.exec(cls);
    if (!m) return;
    const n = +m[2], tier = m[3], [a, b] = PAL[tier] || PAL.bronze;
    const top = ["alexandrite", "top-100", "champion", "diamant"].includes(tier);
    let rule;
    if (m[1] === "bn") {
      rule = `.${cls} { background: ${MOTIFS[n % MOTIFS.length](a, b)}, linear-gradient(135deg, ${a}, ${b}aa 140%) ${top ? "; background-size: auto, 220% 100%; animation: drift 8s ease-in-out infinite alternate" : ""}; }
.${cls}::before { content: "S${n}"; position: absolute; right: 8px; bottom: -.14em; z-index: 0; pointer-events: none; font: 400 3.6em/1 var(--f-display, Georgia, serif); color: ${b}; opacity: .55; letter-spacing: -.02em; text-shadow: 0 2px 8px rgba(0,0,0,.4); }`;
    } else {
      rule = `.${cls}::before { background: conic-gradient(${b}, ${a}, ${b}, ${a}, ${b}); ${top ? "animation: spin 3.5s linear infinite;" : ""} }
.${cls} { box-shadow: 0 0 ${top ? 14 : 8}px ${b}88; }
.${cls}::after { content: "${n}"; position: absolute; right: -6px; bottom: -6px; min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box; border-radius: 8px; background: ${b}; color: ${a}; font: 700 10px/16px var(--f-ui, Arial, sans-serif); text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.5); }`;
    }
    seasonCSS.textContent += rule + "\n";
  }
  function scanSeasonClasses(rootEl) {
    const els = rootEl.querySelectorAll ? rootEl.querySelectorAll('[class*="bn-s"], [class*="fr-s"]') : [];
    const check = el => el.classList && el.classList.forEach(c => { if (/^(bn|fr)-s\d/.test(c)) seasonRule(c); });
    check(rootEl); els.forEach(check);
  }
  new MutationObserver(list => list.forEach(m => {
    if (m.type === "attributes") scanSeasonClasses(m.target);
    else m.addedNodes.forEach(n => n.nodeType === 1 && scanSeasonClasses(n));
  })).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });

  const css3 = document.createElement("style");
  css3.textContent = `
/* more shop designs */
.bn-vegas { background: repeating-linear-gradient(90deg, rgba(255,64,200,.5) 0 2px, transparent 2px 22px), repeating-linear-gradient(0deg, rgba(64,220,255,.35) 0 2px, transparent 2px 22px), linear-gradient(135deg, #12002a, #3a0057); }
.bn-monaco { background: repeating-linear-gradient(90deg, rgba(216,178,106,.35) 0 3px, transparent 3px 26px), linear-gradient(135deg, #07142e, #13306a); }
.bn-jade { background: radial-gradient(ellipse at 20% 0%, rgba(255,255,255,.25), transparent 50%), linear-gradient(135deg, #0b4a3a, #1f9a73 55%, #8ee0b8); }
.bn-braise { background: radial-gradient(circle at 80% 120%, #ffb347 0 15%, transparent 45%), linear-gradient(160deg, #1a0503, #6a1406 55%, #c2410c); }
.bn-glacier { background: linear-gradient(115deg, transparent 45%, rgba(255,255,255,.45) 46%, transparent 48%), linear-gradient(150deg, #0e3a5a, #5fa8d3 55%, #e8f6ff); }
.bn-cuir { background: radial-gradient(circle at 30% 30%, rgba(255,255,255,.08), transparent 60%), repeating-linear-gradient(0deg, rgba(0,0,0,.12) 0 1px, transparent 1px 4px), linear-gradient(135deg, #3b2210, #6e4320); }
.bn-pop { background: radial-gradient(circle, #ff3fa4 0 5px, transparent 5.5px) 0 0 / 22px 22px, linear-gradient(135deg, #ffd23f, #ff8c42); }
.bn-damier { background: conic-gradient(#111 25%, #f2eee3 0 50%, #111 0 75%, #f2eee3 0) 0 0 / 26px 26px; }
.bn-feutre-bleu { background: radial-gradient(circle at 25% 20%, #2b5fb4, #173a7a 55%, #0b1f45); }
.bn-sakura { background: radial-gradient(circle at 15% 30%, #fff 0 3px, transparent 4px), radial-gradient(circle at 55% 70%, #ffe1ec 0 4px, transparent 5px), radial-gradient(circle at 80% 25%, #fff 0 2px, transparent 3px), linear-gradient(135deg, #e86a92, #f7b7cb 60%, #fde2ea); }
.fr-or-rose::before { background: linear-gradient(135deg, #ffd9cf, #c97b6b); }
.fr-onyx::before { background: linear-gradient(135deg, #555, #0b0b0b 60%, #444); }
.fr-perle::before { background: conic-gradient(#fff, #e8e1f5, #fdf6e6, #e3f3ff, #fff); }
.fr-perle { box-shadow: 0 0 10px rgba(255,255,255,.45); }
.fr-turquoise::before { background: linear-gradient(135deg, #a7fff2, #0fa3a3); } .fr-turquoise { box-shadow: 0 0 10px rgba(15,163,163,.5); }
.fr-ambre::before { background: linear-gradient(135deg, #ffe0a3, #c46a00); } .fr-ambre { box-shadow: 0 0 10px rgba(196,106,0,.5); }
.t-or { --tc: linear-gradient(135deg, #fff1b8, #e0a92a 60%, #b07b12); }

/* catalogue additions */
.bn-ocean-profond { background: radial-gradient(ellipse at 70% 0%, rgba(120,220,255,.35), transparent 55%), linear-gradient(180deg, #02121f, #053a5c 60%, #0a6d8f); }
.bn-lagon { background: radial-gradient(circle at 25% 75%, rgba(170,255,240,.7), transparent 45%), linear-gradient(135deg, #087f8c, #3cc8be 60%, #a6f0e4); }
.bn-desert { background: radial-gradient(ellipse at 30% 115%, #b5562a 0 35%, transparent 36%), radial-gradient(ellipse at 85% 120%, #8c3d1c 0 40%, transparent 41%), linear-gradient(175deg, #f7d08a, #e08a3e 70%); }
.bn-foret { background: repeating-linear-gradient(100deg, rgba(0,0,0,.18) 0 4px, transparent 4px 19px), linear-gradient(160deg, #0d3a1c, #2e7d32 70%, #6fa83f); }
.bn-volcan { background: radial-gradient(circle at 50% 125%, #ffb000 0 12%, #ff4d00 22%, transparent 52%), linear-gradient(#140604, #4a1206); }
.bn-cosmos { background: radial-gradient(1.4px 1.4px at 15% 25%, #fff 50%, transparent), radial-gradient(1.2px 1.2px at 70% 15%, #fff 50%, transparent), radial-gradient(1.6px 1.6px at 45% 70%, #fff 50%, transparent), radial-gradient(1px 1px at 88% 60%, #fff 50%, transparent), radial-gradient(ellipse at 70% 60%, rgba(214,80,200,.55), transparent 50%), radial-gradient(ellipse at 25% 40%, rgba(80,90,255,.5), transparent 55%), #070019; }
.bn-neige { background: radial-gradient(#fff 1.4px, transparent 2px) 0 0 / 18px 18px, radial-gradient(#fff 1px, transparent 1.6px) 9px 9px / 18px 18px, linear-gradient(170deg, #9fb6cc, #4f6d8f); }
.bn-automne { background: radial-gradient(circle at 20% 30%, rgba(255,210,120,.45), transparent 40%), linear-gradient(135deg, #6b250b, #c4561a 50%, #e3a33b); }
.bn-lavande { background: repeating-linear-gradient(80deg, rgba(255,255,255,.08) 0 3px, transparent 3px 14px), linear-gradient(135deg, #4b3c78, #9a82d0 60%, #d9ccff); }
.bn-menthe { background: linear-gradient(120deg, transparent 40%, rgba(255,255,255,.3) 41%, transparent 44%), linear-gradient(135deg, #0b5444, #3fc196 60%, #c8ffe9); }
.bn-rubis-royal { background: repeating-linear-gradient(60deg, rgba(255,255,255,.08) 0 2px, transparent 2px 12px), repeating-linear-gradient(-60deg, rgba(255,255,255,.08) 0 2px, transparent 2px 12px), linear-gradient(135deg, #3e000d, #a3122f); }
.bn-saphir-nuit { background: repeating-linear-gradient(60deg, rgba(255,255,255,.07) 0 2px, transparent 2px 12px), repeating-linear-gradient(-60deg, rgba(255,255,255,.07) 0 2px, transparent 2px 12px), linear-gradient(135deg, #020b3a, #173ea3); }
.bn-emeraude-casino { background: conic-gradient(from 45deg, rgba(216,178,106,.3) 25%, transparent 0 50%, rgba(216,178,106,.3) 0 75%, transparent 0) 0 0 / 30px 30px, linear-gradient(135deg, #03301f, #0c7a4f); }
.bn-retro-80 { background: repeating-linear-gradient(0deg, rgba(255,40,200,.55) 0 2px, transparent 2px 14px) 0 100% / 100% 45% no-repeat, linear-gradient(180deg, #ff8a3d 0, #ff3d8b 45%, #2a0a4a 46%, #12002a); }
.bn-synthwave { background: repeating-linear-gradient(180deg, transparent 0 7px, #1a0533 7px 10px) 88% 30% / 64px 64px no-repeat, radial-gradient(circle at 50% 50%, #ffe14d 0 40%, #ff5f8f 70%, transparent 71%) 88% 30% / 92px 92px no-repeat, linear-gradient(#1a0533, #3d0b6b); }
.bn-tartan { background: repeating-linear-gradient(90deg, rgba(0,60,20,.6) 0 10px, transparent 10px 30px), repeating-linear-gradient(0deg, rgba(0,60,20,.6) 0 10px, transparent 10px 30px), repeating-linear-gradient(90deg, transparent 0 14px, rgba(255,220,120,.35) 14px 16px, transparent 16px 30px), #8f1020; }
.bn-pied-de-poule { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.55) 45%, transparent 80%), conic-gradient(#1c1c1c 25%, #8d877b 0 50%, #1c1c1c 0 75%, #8d877b 0) 0 0 / 12px 12px, #1c1c1c; }
.bn-bayadere { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.55) 45%, transparent 80%), repeating-linear-gradient(180deg, #e63946 0 8px, #f1a208 8px 16px, #2a9d8f 16px 24px, #264653 24px 32px, #e9c46a 32px 40px); }
.bn-mosaique { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.55) 45%, transparent 80%), conic-gradient(#e76f51 0 25%, #2a9d8f 0 50%, #e9c46a 0 75%, #264653 0) 0 0 / 22px 22px; }
.bn-ondes { background: repeating-radial-gradient(circle at 15% 50%, rgba(255,255,255,.14) 0 2px, transparent 2px 13px), linear-gradient(135deg, #0b2e4a, #1f6f8b); }
.bn-eclair { background: linear-gradient(115deg, transparent 70%, #ffe14d 70% 72.5%, transparent 72.5% 77%, #ffe14d 77% 79.5%, transparent 79.5%), linear-gradient(135deg, #0a1030, #24306b); }
.bn-roue { background: repeating-conic-gradient(from 0deg at 92% 50%, #b3262f 0 9.7deg, #17191d 0 19.4deg), #17191d; }
.bn-des { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.55) 45%, transparent 80%), radial-gradient(rgba(255,255,255,.7) 2.4px, transparent 3px) 0 0 / 16px 16px, radial-gradient(rgba(255,255,255,.7) 2.4px, transparent 3px) 8px 8px / 16px 16px, linear-gradient(135deg, #8f0f1c, #d1263a); }
.bn-tapis-rouge { background: linear-gradient(90deg, transparent 0 6px, #d8b26a 6px 8px, transparent 8px calc(100% - 8px), #d8b26a calc(100% - 8px) calc(100% - 6px), transparent 0), radial-gradient(ellipse at 50% 0%, rgba(255,255,255,.2), transparent 60%), linear-gradient(135deg, #4a0008, #9e0f1f 50%, #5a000c); }
.fr-argent-poli::before { background: linear-gradient(135deg, #ffffff, #9aa3ad 50%, #e6eaee); }
.fr-bronze-antique::before { background: linear-gradient(135deg, #f0b98a, #8a4f24 60%, #c98b5a); }
.fr-cuivre::before { background: linear-gradient(135deg, #ffcfa8, #b5532a 60%, #e88a5a); }
.fr-jade-imperial::before { background: linear-gradient(135deg, #c8ffe2, #1f8a5a 60%, #63d39b); } .fr-jade-imperial { box-shadow: 0 0 12px rgba(31,138,90,.55); }
.fr-amethyste::before { background: linear-gradient(135deg, #f0d6ff, #7b2fbf 60%, #b77ae8); } .fr-amethyste { box-shadow: 0 0 12px rgba(123,47,191,.55); }
.fr-grenat::before { background: linear-gradient(135deg, #ffb3c0, #7a0f24 60%, #c43a57); } .fr-grenat { box-shadow: 0 0 12px rgba(196,58,87,.5); }
.fr-citrine::before { background: linear-gradient(135deg, #fff6c2, #d9a400 60%, #ffd84d); } .fr-citrine { box-shadow: 0 0 12px rgba(217,164,0,.5); }
.fr-opale::before { background: conic-gradient(#ffe3f1, #d6f5ff, #e9ffd9, #fff4cc, #f0e1ff, #ffe3f1); animation: spin 4s linear infinite; } .fr-opale { box-shadow: 0 0 12px rgba(255,255,255,.5); }
.fr-neon-rose::before { background: linear-gradient(135deg, #ff7ad9, #ff2fb9); } .fr-neon-rose { box-shadow: 0 0 12px rgba(255,47,185,.85); }
.fr-neon-cyan::before { background: linear-gradient(135deg, #7af5ff, #00c8ff); } .fr-neon-cyan { box-shadow: 0 0 12px rgba(0,200,255,.85); }
.fr-galaxie::before { background: conic-gradient(#2a0a5e, #7a3cff, #ff5fd2, #2a0a5e, #3cc8ff, #2a0a5e); animation: spin 4s linear infinite; } .fr-galaxie { box-shadow: 0 0 12px rgba(122,60,255,.6); }
.fr-arc-or::before { background: repeating-conic-gradient(#ffe08a 0 12deg, #8a6420 12deg 18deg); } .fr-arc-or { box-shadow: 0 0 12px rgba(233,196,106,.45); }
.fr-pointilles::before { background: repeating-conic-gradient(#f2eee3 0 8deg, transparent 8deg 16deg); }
.fr-electrique::before { background: conic-gradient(#fff36b, #3b7bff, #fff36b, #3b7bff, #fff36b); animation: spin 4s linear infinite; } .fr-electrique { box-shadow: 0 0 12px rgba(80,140,255,.7); }
/* new arrivals */
.bn-eclipse { background: radial-gradient(circle at 85% 50%, #050505 0 22px, rgba(255,214,120,.95) 23px, rgba(255,160,60,.35) 30px, transparent 46px), linear-gradient(135deg, #0a0a12, #1c1630); }
.bn-tropiques { background: radial-gradient(circle at 80% 100%, #ffd35a 0 14%, transparent 15%), linear-gradient(180deg, #2b1055, #a43a6b 45%, #ff7e47 80%, #ffb347); }
.bn-minuit { background: radial-gradient(circle at 85% 30%, #f5f1d6 0 9%, transparent 10%), radial-gradient(1px 1px at 20% 30%, #fff 50%, transparent), radial-gradient(1px 1px at 55% 60%, #fff 50%, transparent), linear-gradient(180deg, #050a1f, #0f1d45); }
.bn-orage { background: linear-gradient(110deg, transparent 74%, #e9f1ff 74% 75.5%, transparent 75.5%), radial-gradient(ellipse at 30% 0%, rgba(160,170,190,.5), transparent 60%), linear-gradient(180deg, #1c2230, #3b4456); }
.bn-marbre-noir { background: linear-gradient(125deg, transparent 30%, rgba(255,255,255,.18) 31%, transparent 33%, transparent 60%, rgba(216,178,106,.35) 61%, transparent 62.5%), linear-gradient(160deg, transparent 45%, rgba(255,255,255,.1) 46%, transparent 48%), linear-gradient(135deg, #0b0b0d, #26262b); }
.bn-marbre-blanc { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), linear-gradient(125deg, transparent 30%, rgba(90,90,100,.35) 31%, transparent 33%, transparent 60%, rgba(150,140,120,.4) 61%, transparent 62.5%), linear-gradient(135deg, #f2f0ea, #cfcac0); }
.bn-or-massif { background: linear-gradient(120deg, transparent 35%, rgba(255,255,255,.45) 45%, transparent 55%), linear-gradient(135deg, #6b4a0e, #d8a531 35%, #ffe08a 55%, #b07b12); }
.bn-bambou { background: repeating-linear-gradient(90deg, transparent 0 22px, rgba(20,60,10,.55) 22px 25px, transparent 25px 40px), repeating-linear-gradient(0deg, transparent 0 30px, rgba(20,60,10,.35) 30px 32px), linear-gradient(135deg, #3f7d20, #8cc152); }
.bn-corail { background: radial-gradient(circle at 80% 110%, #ff7f6e 0 18%, transparent 19%), radial-gradient(circle at 92% 95%, #ffb38a 0 12%, transparent 13%), linear-gradient(180deg, #0c6e8f, #18a7b5); }
.bn-nebuleuse { background: radial-gradient(1.2px 1.2px at 30% 30%, #fff 50%, transparent), radial-gradient(1.2px 1.2px at 78% 70%, #fff 50%, transparent), radial-gradient(ellipse at 75% 40%, rgba(255,90,140,.6), transparent 50%), radial-gradient(ellipse at 55% 80%, rgba(60,200,255,.45), transparent 50%), #0b0320; }
.bn-code-vert { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), repeating-linear-gradient(180deg, transparent 0 7px, #001a07 7px 10px), repeating-linear-gradient(90deg, transparent 0 11px, rgba(0,255,90,.6) 11px 13px), linear-gradient(180deg, #002b0c, #001405); }
.bn-pixel { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), conic-gradient(#ff4d6d 25%, #4dd0ff 0 50%, #ffd84d 0 75%, #7cff6b 0) 0 0 / 16px 16px, #222; }
.bn-zebre { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), repeating-linear-gradient(120deg, #111 0 10px, #f2f2f2 10px 20px, #111 20px 26px, #f2f2f2 26px 40px); }
.bn-leopard { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), radial-gradient(circle, #2b1a0a 0 3px, transparent 3.5px) 0 0 / 18px 18px, radial-gradient(circle, #2b1a0a 0 2.5px, transparent 3px) 9px 9px / 18px 18px, linear-gradient(135deg, #c98a2b, #e8b45a); }
.bn-camouflage { background: radial-gradient(ellipse 30px 16px at 20% 30%, #3a4a24 98%, transparent), radial-gradient(ellipse 26px 18px at 60% 70%, #2a3318 98%, transparent), radial-gradient(ellipse 34px 14px at 85% 25%, #6b6b3a 98%, transparent), #4f5d2f; }
.bn-arc-en-ciel { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), linear-gradient(135deg, #ff4d4d, #ff9f40, #ffe14d, #5be36b, #4db8ff, #8e6bff); }
.bn-bonbon { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), repeating-linear-gradient(135deg, #ff8fc7 0 12px, #fff 12px 24px, #8fe3ff 24px 36px, #fff 36px 48px); }
.bn-cerise { background: radial-gradient(circle at 85% 60%, #d10f3a 0 9%, transparent 10%), radial-gradient(circle at 92% 50%, #e3224d 0 8%, transparent 9%), linear-gradient(135deg, #5e0a1c, #b0243f); }
.bn-agrumes { background: radial-gradient(circle at 88% 50%, #fff3b0 0 8%, #ffb300 9% 20%, transparent 21%), linear-gradient(135deg, #d35400, #f39c12 60%, #f7dc6f); }
.bn-pluie-jetons { background: radial-gradient(circle at 70% 30%, #d8b26a 0 7px, #b3262f 7px 11px, transparent 12px), radial-gradient(circle at 85% 70%, #fff 0 6px, #1e7a4a 6px 10px, transparent 11px), radial-gradient(circle at 95% 20%, #fff 0 5px, #17191d 5px 9px, transparent 10px), linear-gradient(135deg, #0b3d30, #145c47); }
.bn-main-gagnante { background: radial-gradient(circle, #c0392b 0 4px, transparent 5px) 86% 52% / 30px 42px no-repeat, linear-gradient(#fff, #f3eee0) 86% 52% / 30px 42px no-repeat, radial-gradient(circle, #17191d 0 4px, transparent 5px) 76% 46% / 30px 42px no-repeat, linear-gradient(#fff, #e9e2cf) 76% 46% / 30px 42px no-repeat, linear-gradient(135deg, #0d4a36, #10664a); }
.bn-porte-bonheur { background: radial-gradient(circle at 86% 40%, #2ecc71 0 9%, transparent 10%), radial-gradient(circle at 93% 55%, #27ae60 0 9%, transparent 10%), radial-gradient(circle at 79% 55%, #27ae60 0 9%, transparent 10%), radial-gradient(circle at 86% 70%, #2ecc71 0 9%, transparent 10%), linear-gradient(135deg, #0d3d1f, #1c6b39); }
.bn-gatsby { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), repeating-conic-gradient(from 180deg at 50% 100%, rgba(216,178,106,.55) 0 4deg, transparent 4deg 14deg), linear-gradient(180deg, #0c0c0c, #1f1a12); }
.bn-vitrail { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), conic-gradient(from 30deg, #c0392b, #2980b9, #f1c40f, #27ae60, #8e44ad, #c0392b) 0 0 / 34px 34px, #111; }
.bn-origami { background: linear-gradient(45deg, rgba(255,255,255,.18) 25%, transparent 25% 50%, rgba(0,0,0,.12) 50% 75%, transparent 75%) 0 0 / 40px 40px, linear-gradient(135deg, #e0607e, #f2a07b); }
.bn-circuit { background: linear-gradient(90deg, rgba(5,10,8,.78) 0, rgba(5,10,8,.5) 45%, transparent 80%), linear-gradient(90deg, transparent 0 18px, rgba(80,255,200,.5) 18px 20px, transparent 20px) 0 0 / 40px 40px, linear-gradient(0deg, transparent 0 28px, rgba(80,255,200,.5) 28px 30px, transparent 30px) 0 0 / 40px 40px, #04261f; }
.bn-lave { background: radial-gradient(ellipse at 80% 80%, #ffcc33, #ff5a00 25%, transparent 50%), linear-gradient(115deg, transparent 50%, rgba(255,90,0,.6) 51%, transparent 53%), linear-gradient(135deg, #1a0503, #4a0d05); }
.bn-abysses { background: radial-gradient(circle at 85% 30%, rgba(80,255,240,.5) 0 3px, transparent 4px), radial-gradient(circle at 70% 70%, rgba(80,255,240,.4) 0 2px, transparent 3px), linear-gradient(180deg, #021a2e, #000814); }
.bn-crepuscule { background: linear-gradient(180deg, #2c3e74, #6a4c93 50%, #d17b88); }
.bn-champagne { background: radial-gradient(circle at 80% 70%, rgba(255,255,255,.8) 0 2px, transparent 3px), radial-gradient(circle at 88% 40%, rgba(255,255,255,.7) 0 3px, transparent 4px), radial-gradient(circle at 74% 30%, rgba(255,255,255,.6) 0 2px, transparent 3px), linear-gradient(135deg, #6b5320, #d9b860 55%, #f6e7b0); }
.fr-platine-pur::before { background: linear-gradient(135deg, #ffffff, #b9e4df 50%, #7fbfb8); } .fr-platine-pur { box-shadow: 0 0 12px rgba(185,228,223,.6); }
.fr-obsidienne::before { background: linear-gradient(135deg, #4a4a5a, #050507 50%, #2c2c38); } .fr-obsidienne { box-shadow: 0 0 10px rgba(120,120,160,.4); }
.fr-corail-vif::before { background: linear-gradient(135deg, #ffc2b3, #ff6f61); }
.fr-menthe-givree::before { background: linear-gradient(135deg, #e6fff6, #4fd1a5); }
.fr-lilas::before { background: linear-gradient(135deg, #f1e4ff, #a77bd8); }
.fr-feu-glace::before { background: conic-gradient(#ff4d00, #ffb000, #ff4d00 25%, #3cc8ff 50%, #b8f0ff, #3cc8ff 75%, #ff4d00); animation: spin 4s linear infinite; } .fr-feu-glace { box-shadow: 0 0 12px rgba(255,120,60,.5); }
.fr-ruban-arc-en-ciel::before { background: conic-gradient(#ff4d4d, #ffb84d, #ffe94d, #5be36b, #4db8ff, #8e6bff, #ff4d4d); }
.fr-aurore-polaire::before { background: conic-gradient(#50ffaa, #3cc8ff, #8c5aff, #50ffaa); animation: spin 4s linear infinite; } .fr-aurore-polaire { box-shadow: 0 0 12px rgba(80,255,170,.55); }
.fr-chrome::before { background: linear-gradient(180deg, #ffffff, #8a9099 45%, #3a3f46 55%, #d9dde2); }
.fr-coulee-lave::before { background: conic-gradient(#3a0a04, #ff5a00, #ffcc33, #ff5a00, #3a0a04); animation: spin 4s linear infinite; } .fr-coulee-lave { box-shadow: 0 0 12px rgba(255,90,0,.6); }
.fr-tournesol::before { background: repeating-conic-gradient(#ffd23f 0 15deg, #e09400 15deg 30deg); }
.fr-nuit-bleue::before { background: linear-gradient(135deg, #6c8cff, #101a4a); }
.fr-diamant-noir::before { background: conic-gradient(#000, #555, #fff, #555, #000, #888, #000); animation: spin 4s linear infinite; } .fr-diamant-noir { box-shadow: 0 0 14px rgba(255,255,255,.45); }
.fr-jeton::before { background: repeating-conic-gradient(#b3262f 0 20deg, #f2eee3 20deg 30deg); }
.fr-fleur-cerisier::before { background: conic-gradient(#ffd1e0, #ff8fb4, #ffe8f0, #ff8fb4, #ffd1e0); } .fr-fleur-cerisier { box-shadow: 0 0 10px rgba(255,143,180,.5); }
.fr-toxique::before { background: linear-gradient(135deg, #e4ff4d, #3cff2e); } .fr-toxique { box-shadow: 0 0 12px rgba(120,255,46,.75); }
/* season number sits above the banner art but under the player info */
[class*="bn-s"] > * { position: relative; z-index: 1; }
.sw[class*="bn-s"]::before { font-size: 2.4em; }
/* seven tabs on narrow phones */
@media (max-width: 400px) {
  .tabbar a { font-size: 9px; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; }
  .tabbar a svg { width: 21px; height: 21px; }
}

/* game picker */
.gpick { display: flex; flex-direction: column; gap: 10px; }
.gtile { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; padding: 14px; border-radius: 16px; background: var(--glass); border: 1px solid var(--felt-line); color: var(--ink); text-decoration: none; }
.gtile.here { border-color: var(--brass); background: rgba(216,178,106,.12); }
.gico { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: radial-gradient(circle at 30% 25%, #1c7259, #0b3d30); box-shadow: inset 0 0 0 1px var(--felt-line); color: var(--brass); }
.gico svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.gtxt b { display: block; font-size: 17px; }
.gtxt span { font-size: 13.5px; color: var(--muted); }
.gnow { font-size: 12px; font-weight: 700; color: var(--brass); }
.gtile .go { font-size: 22px; color: var(--muted); }

/* profile photos */
.av.has-photo { background: #0b3d30; }
.av img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }

/* rarity */
.rar { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 700; letter-spacing: .02em; }
.rar::before { content: ""; width: 8px; height: 8px; border-radius: 2px; transform: rotate(45deg); background: currentColor; }
.rar-commun { color: #b9c2bf; } .rar-rare { color: #6cc4ff; } .rar-epique { color: #c07ae8; } .rar-legendaire { color: #ffcf5a; }

/* header search */
.search-btn { width: 38px; height: 38px; flex: none; border-radius: 50%; background: var(--glass); border: 1px solid var(--felt-line); display: grid; place-items: center; color: var(--ink); cursor: pointer; }
.search-btn svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.bar .acct-chip { max-width: 38vw; }
.bar-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ps-search { position: relative; }
.ps-search input { height: 48px; width: 100%; box-sizing: border-box; border-radius: 14px; border: 1px solid var(--felt-line); background: rgba(0,0,0,.25); color: var(--ink); font: 600 17px var(--f-ui); padding: 0 14px 0 42px; }
.ps-search svg { position: absolute; left: 14px; top: 50%; width: 18px; height: 18px; transform: translateY(-50%); fill: none; stroke: var(--muted); stroke-width: 2; stroke-linecap: round; }
.ps-results { display: flex; flex-direction: column; gap: 6px; }
.ps-hit { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 8px 12px; border-radius: 14px; border: 0; color: #fff; text-align: left; font: inherit; cursor: pointer; position: relative; isolation: isolate; overflow: hidden; }
.ps-hit::after { content: ""; position: absolute; inset: 0; z-index: -1; background: linear-gradient(90deg, rgba(3,16,12,.85), rgba(3,16,12,.55)); }
.ps-hit b { display: block; font-size: 15.5px; }
.ps-hit span { font-size: 12px; color: #f1dfb0; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
.ps-hit .go { color: rgba(255,255,255,.6); font-size: 20px; }

/* ===== tablets ===== */
@media (min-width: 700px) and (min-height: 500px) {
  .app { max-width: 880px; }
  .tabbar { max-width: 640px; margin-inline: auto; border-radius: 22px 22px 0 0; }
  .tabbar a { font-size: 11.5px; }
  .tabbar a svg { width: 24px; height: 24px; }
  body[data-page="blackjack"] { --cw: min(15vw, 14dvh, 130px); }
  body[data-page="blackjack"] .hands[data-n="2"] { --cw: min(12vw, 12dvh, 110px); }
  body[data-page="blackjack"] .hands[data-n="3"], body[data-page="blackjack"] .hands[data-n="4"] { --cw: min(9vw, 10dvh, 88px); }
  body[data-page="blackjack"] .chip, body[data-page="roulette"] .chip, body[data-page="poker"] .chip { width: 64px; height: 64px; font-size: 17px; }
  body[data-page="blackjack"] .controls, body[data-page="poker"] #hControls, body[data-page="online"] #hControls { max-width: 620px; width: 100%; margin-inline: auto; }
  body[data-page="poker"] .board .card, body[data-page="online"] .board .card { --cw: min(10vw, 9dvh, 104px); }
  body[data-page="poker"] .me .hole .card, body[data-page="online"] .me .hole .card { --cw: min(13vw, 11dvh, 124px); }
  body[data-page="poker"] .me, body[data-page="online"] .me { padding-block: 6px; }
  body[data-page="poker"] .mini .card, body[data-page="online"] .mini .card { --cw: min(5.5vw, 52px); }
  body[data-page="poker"] .vp-slot .card { --cw: min(14vw, 17dvh, 150px); }
  body[data-page="poker"] .paytable { font-size: 15px; }
  body[data-page="poker"] .seat .name, body[data-page="online"] .seat .name { font-size: 16px; }
  body[data-page="historique"] .app, body[data-page="classement"] .app { max-width: 980px; }
  body[data-page="defis"] .app, body[data-page="rangs"] .app { max-width: 820px; }
}
/* roulette: wheel beside the betting layout on wide screens */
@media (min-width: 900px) and (min-height: 500px) {
  body[data-page="roulette"] .app { display: grid; max-width: 1180px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); grid-template-rows: auto minmax(0, 1fr) auto auto; grid-template-areas: "bar bar" "stage board" "stage controls" "tab tab"; column-gap: 28px; }
  body[data-page="roulette"] .bar { grid-area: bar; }
  body[data-page="roulette"] .stage { grid-area: stage; }
  body[data-page="roulette"] .board { grid-area: board; align-self: center; grid-template-rows: repeat(3, minmax(44px, 8dvh)) repeat(2, minmax(40px, 6dvh)); }
  body[data-page="roulette"] .controls { grid-area: controls; }
  body[data-page="roulette"] .tabbar { grid-area: tab; }
  body[data-page="roulette"] .wheel-wrap { width: min(38vw, 62dvh, 520px); }
  body[data-page="roulette"] .result { font-size: calc(min(38vw, 62dvh, 520px) * .14); }
  body[data-page="roulette"] .cell { font-size: clamp(13px, 1.4vw, 19px); }
  body[data-page="roulette"] .history { display: flex !important; }
}
/* shop and locker: preview beside the grid */
@media (min-width: 1000px) and (min-height: 500px) {
  body[data-page="boutique"] .app, body[data-page="casier"] .app { display: grid; max-width: 1180px; grid-template-columns: 380px minmax(0, 1fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto; grid-template-areas: "bar bar" "preview seg" "preview tools" "preview scroll" "tab tab"; column-gap: 28px; }
  body[data-page="boutique"] .bar, body[data-page="casier"] .bar { grid-area: bar; }
  body[data-page="boutique"] .preview, body[data-page="casier"] .preview { grid-area: preview; align-self: start; }
  body[data-page="boutique"] .seg, body[data-page="casier"] .seg { grid-area: seg; }
  body[data-page="casier"] .tools { grid-area: tools; }
  body[data-page="boutique"] .scroll, body[data-page="casier"] .scroll { grid-area: scroll; }
  body[data-page="boutique"] .tabbar, body[data-page="casier"] .tabbar { grid-area: tab; }
  body[data-page="boutique"] .grid, body[data-page="casier"] .grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  body[data-page="classement"] #ranks { display: grid !important; grid-template-columns: 380px minmax(0, 1fr); column-gap: 28px; align-items: start;
    grid-template-areas: "find seg" "me period" "btns notes" "tools board" "err board" "live board" "live foot"; }
  body[data-page="classement"] #findBtn { grid-area: find; }
  body[data-page="classement"] #meCard { grid-area: me; } body[data-page="classement"] .mebtns { grid-area: btns; margin-top: 0; }
  body[data-page="classement"] #friendTools { grid-area: tools; } body[data-page="classement"] #listErr { grid-area: err; }
  body[data-page="classement"] .seg { grid-area: seg; } body[data-page="classement"] .period { grid-area: period; justify-content: flex-start; }
  body[data-page="classement"] #weekNote, body[data-page="classement"] #seasonNote { grid-area: notes; text-align: left; margin: 0; }
  body[data-page="classement"] #board { grid-area: board; } body[data-page="classement"] .live { grid-area: live; margin-top: 12px; }
  body[data-page="classement"] #ranks > .hint { grid-area: foot; }
  body[data-page="classement"] .app, body[data-page="historique"] .app { max-width: 1180px; }
  body[data-page="classement"] #auth, body[data-page="classement"] #noConfig { max-width: 560px; margin-inline: auto; width: 100%; }
  .psheet-scrim { align-items: center; }
  .psheet { border-radius: 22px; max-height: 88%; border: 1px solid var(--felt-line); }
}
/* ===== computers: side rail instead of the bottom bar ===== */
@media (min-width: 1100px) and (hover: hover) and (pointer: fine) {
  body { padding-left: 96px; }
  .tabbar { position: fixed; left: 0; top: 0; bottom: 0; width: 96px; max-width: none; margin: 0; z-index: 30; grid-template-columns: 1fr; grid-auto-rows: 66px; align-content: center; gap: 4px; padding: 18px 8px; border-radius: 0; border-top: 0; border-right: 1px solid var(--felt-line); }
  .tabbar::before { content: "CASINO"; position: absolute; top: 22px; left: 0; right: 0; text-align: center; font: 400 15px var(--f-display, Georgia, serif); letter-spacing: .24em; color: var(--brass); }
  .tabbar a { font-size: 11.5px; justify-content: center; gap: 5px; }
  .tabbar a:hover { color: var(--ink); background: rgba(255,255,255,.05); }
  .btn:hover:not(:disabled), .small-btn:hover, .icon-btn:hover, .search-btn:hover { filter: brightness(1.12); }
  .line:hover, .feed:hover, .item:hover, .ps-hit:hover { filter: brightness(1.1); }
  .app { padding-top: 14px; }
}`;
  document.head.appendChild(css3);

  // header: player search on every page
  function mountSearch() {
    const bar = document.querySelector(".app .bar");
    if (!bar || bar.querySelector(".search-btn")) return;
    const btn = document.createElement("button");
    btn.className = "search-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Chercher un joueur");
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
    btn.onclick = () => openSearch();
    const chip = bar.querySelector(".acct-chip");
    if (chip) {
      const wrap = document.createElement("div");
      wrap.className = "bar-right";
      chip.replaceWith(wrap);
      wrap.append(btn, chip);
    } else bar.insertBefore(btn, bar.lastElementChild);
  }
  function openSearch(start = "") {
    openSheet((sheet, close) => {
      sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
        <div class="ph"><h2>Chercher un joueur</h2><button class="x" data-close aria-label="Fermer">×</button></div>
        <label class="ps-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="psQ" type="search" placeholder="Pseudo" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Pseudo du joueur" value="${escHTML(start)}"></label>
        <div class="ps-results" id="psRes"><p class="loading">Tape au moins une lettre.</p></div>`;
      const input = sheet.querySelector("#psQ"), out = sheet.querySelector("#psRes");
      let timer, seq = 0;
      const run = async () => {
        const q = input.value.trim(), my = ++seq;
        if (!q) { out.innerHTML = `<p class="loading">Tape au moins une lettre.</p>`; return; }
        if (!configured() || !session) { out.innerHTML = `<p class="loading">Connecte-toi dans l'onglet Classement pour chercher des joueurs.</p>`; return; }
        try {
          const rows = await searchPlayers(q);
          if (my !== seq) return;
          out.innerHTML = rows.length ? rows.map((r, i) => `<button class="ps-hit rise bn-${escHTML(r.banner || "tapis")}" style="--i:${i}" data-user="${escHTML(r.username)}">
              ${avatarHTML(r.username, r.frame, "md", r.avatar_url)}
              <div><b>${escHTML(r.username)}${r.is_friend ? " · ami" : ""}</b>${titleText(r.title) ? `<span>${escHTML(titleText(r.title))}</span>` : ""}</div><span class="go" aria-hidden="true">›</span></button>`).join("")
            : `<p class="loading">Aucun joueur ne correspond à « ${escHTML(q)} ».</p>`;
        } catch (e) {
          if (my === seq) out.innerHTML = `<p class="loading">${escHTML(e.code === "network" ? "Il faut internet pour chercher." : /search_players/.test(e.raw || "") ? "La recherche arrive avec la mise à jour du serveur." : e.message)}</p>`;
        }
      };
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 220); });
      out.addEventListener("click", e => { const b = e.target.closest("[data-user]"); if (b) { close(); openProfile(b.dataset.user); } });
      setTimeout(() => input.focus(), 250);
      if (start) run();
    });
  }

  // install button where the browser offers one (Android, computers)
  let installEvt = null;
  addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    installEvt = e;
    const bar = document.querySelector(".app .bar .bar-right");
    if (!bar || bar.querySelector(".install-btn")) return;
    const b = document.createElement("button");
    b.className = "search-btn install-btn";
    b.type = "button";
    b.setAttribute("aria-label", "Installer l'app");
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
    b.onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; b.remove(); };
    bar.prepend(b);
  });

  // ---------- rules and help for every game ----------
  // mini playing cards for examples, e.g. cards("A♠ R♠ D♠ V♠ 10♠")
  function cards(spec) {
    return `<span class="hc-row">${spec.split(" ").map(c => {
      const suit = c.slice(-1), rank = c.slice(0, -1), red = suit === "♥" || suit === "♦";
      return `<span class="hc${red ? " red" : ""}">${rank}<i>${suit}&#xFE0E;</i></span>`;
    }).join("")}</span>`;
  }
  const chipDot = (c, v) => `<span class="hchip" style="--c:${c}">${v}</span>`;
  const HELP = {
    blackjack: {
      title: "Blackjack",
      intro: "Bats le croupier en t'approchant le plus possible de 21, sans jamais dépasser.",
      sections: [
        ["Valeur des cartes", `<ul>
          <li>De 2 à 10 : leur valeur. ${cards("7♣ 10♥")} = 17</li>
          <li>Valet, Dame, Roi (V, D, R) : 10. ${cards("R♠ 6♦")} = 16</li>
          <li>As : 1 ou 11, au mieux pour toi. ${cards("A♥ 6♠")} s'affiche <b>7/17</b> : la main est « souple », tirer ne peut pas te faire sauter.</li></ul>`],
        ["Déroulement d'une main", `<ol>
          <li>Choisis ta mise avec les jetons ${chipDot("#c43a3a", 5)} ${chipDot("#2f8a55", 25)} ${chipDot("#1d1f24", 100)} ${chipDot("#6b3fa0", 500)}, puis <b>Distribuer</b>.</li>
          <li>Tu reçois 2 cartes visibles. Le croupier en a 2, dont une cachée.</li>
          <li>Tu joues ta main (voir les actions ci-dessous).</li>
          <li>Le croupier retourne sa carte et tire jusqu'à avoir au moins 17. Il reste sur tous les 17.</li></ol>`],
        ["Tes actions", `<dl>
          <dt>Tirer</dt><dd>Prendre une carte de plus. Au-dessus de 21, tu sautes et tu perds ta mise.</dd>
          <dt>Rester</dt><dd>Garder ta main telle quelle.</dd>
          <dt>Doubler</dt><dd>Doubler ta mise sur tes 2 premières cartes : tu reçois une seule carte, puis tu restes.</dd>
          <dt>Séparer</dt><dd>Avec deux cartes de même valeur ${cards("8♠ 8♦")}, en faire deux mains, chacune avec ta mise. Jusqu'à 4 mains. As séparés : une seule carte chacun.</dd></dl>`],
        ["Ce que tu gagnes", `<table class="hpay">
          <tr><td>Blackjack ${cards("A♠ R♥")}</td><td>3 pour 2</td><td>mise 20 → +30</td></tr>
          <tr><td>Main gagnante</td><td>1 pour 1</td><td>mise 20 → +20</td></tr>
          <tr><td>Égalité</td><td>mise rendue</td><td>0</td></tr>
          <tr><td>Tu sautes ou tu perds</td><td>mise perdue</td><td>−20</td></tr></table>`],
        ["Le sabot et le comptage des cartes", `<p>Les cartes viennent d'un sabot de 6 jeux (312 cartes). La barre en haut de la table montre les cartes restantes et combien avant le mélange : le sabot est remélangé quand il n'en reste qu'un quart (repère rouge).</p>
          <p>Les cartes déjà sorties ne reviennent pas avant le mélange : compter les cartes permet de savoir ce qu'il reste. Avec la méthode <b>Hi-Lo</b> :</p>
          <table class="hpay"><tr><td>${cards("2♠ 3♥ 4♦ 5♣ 6♠")}</td><td>+1</td></tr><tr><td>${cards("7♥ 8♣ 9♦")}</td><td>0</td></tr><tr><td>${cards("10♠ V♥ D♦ R♣ A♠")}</td><td>−1</td></tr></table>
          <ul><li>Additionne les valeurs de toutes les cartes vues : c'est le <b>compte</b>.</li>
          <li>Divise par le nombre de jeux restants : c'est le <b>compte réel</b>.</li>
          <li>Compte réel de +2 ou plus : il reste beaucoup de 10 et d'As, les blackjacks sont plus fréquents. Mise plus gros.</li>
          <li>Compte réel négatif : mise le minimum.</li></ul>
          <p>Pour t'entraîner, active <b>Aide au comptage</b> dans le menu ☰ : le compte s'affiche en direct.</p>`],
        ["Astuces de base", `<ul>
          <li>Reste toujours à 17 ou plus.</li>
          <li>Tire toujours à 11 ou moins : tu ne peux pas sauter.</li>
          <li>Double sur 10 ou 11 quand le croupier montre une petite carte (2 à 9).</li>
          <li>Sépare toujours les As et les 8. Ne sépare jamais les 10 ni les 5.</li>
          <li>De 12 à 16, reste si le croupier montre 2 à 6 : c'est lui qui risque de sauter.</li></ul>`]
      ]
    },
    roulette: {
      title: "Roulette française",
      intro: "Devine où la bille va s'arrêter. 37 cases : de 1 à 36 en rouge ou noir, et le 0 vert.",
      sections: [
        ["Comment miser", `<ol>
          <li>Choisis la valeur du jeton en bas ${chipDot("#c43a3a", 5)} ${chipDot("#2f8a55", 25)} ${chipDot("#1d1f24", 100)} ${chipDot("#6b3fa0", 500)}.</li>
          <li>Touche les cases du tapis. Chaque toucher ajoute un jeton, et tu peux miser sur plusieurs cases.</li>
          <li><b>Lancer</b> fait tourner la roue. <b>Remiser</b> rejoue les mêmes mises, <b>Effacer</b> retire tout.</li></ol>`],
        ["Les mises et leurs gains", `<table class="hpay">
          <tr><th>Mise</th><th>Paie</th><th>Chances</th></tr>
          <tr><td><b>Plein</b> : un seul numéro</td><td>35 pour 1</td><td>2,7 %</td></tr>
          <tr><td><b>Douzaine</b> : 1–12, 13–24 ou 25–36</td><td>2 pour 1</td><td>32,4 %</td></tr>
          <tr><td><b>Colonne</b> : les cases « 2:1 » au bout de chaque ligne</td><td>2 pour 1</td><td>32,4 %</td></tr>
          <tr><td><b>Chances simples</b> : rouge ou noir, pair ou impair, 1–18 ou 19–36</td><td>1 pour 1</td><td>48,6 %</td></tr></table>
          <p>« 35 pour 1 » : 10 jetons sur le bon numéro te rapportent 350 jetons, et tu gardes tes 10.</p>`],
        ["Le zéro et la partage", `<p>Le 0 n'est ni rouge ni noir, ni pair ni impair. Quand il sort, tes mises sur les chances simples ne sont pas perdues entièrement : <b>la moitié t'est rendue</b>. C'est la règle de « la partage » de la roulette française.</p>`],
        ["Astuces", `<ul>
          <li>Les chances simples font durer ton solde. Les pleins rapportent gros, mais rarement.</li>
          <li>Les derniers numéros sortis s'affichent sous la roue. Ils n'influencent pas le prochain : chaque lancer est indépendant.</li></ul>`]
      ]
    },
    holdem: {
      title: "Texas Hold'em",
      intro: "Remporte le pot avec la meilleure main de 5 cartes, ou en faisant coucher tous les autres joueurs.",
      sections: [
        ["Déroulement d'une main", `<ol>
          <li><b>Blindes</b> : les deux joueurs à gauche du bouton <span class="hd">D</span> misent d'office 10 et 20.</li>
          <li><b>Préflop</b> : chacun reçoit 2 cartes cachées, puis un tour de mises.</li>
          <li><b>Flop</b> : 3 cartes communes au milieu, puis un tour de mises.</li>
          <li><b>Turn</b> : une 4ᵉ carte, puis un tour de mises.</li>
          <li><b>River</b> : une 5ᵉ carte, puis un dernier tour de mises.</li>
          <li><b>Abattage</b> : les joueurs encore en jeu montrent leurs cartes. Chacun garde sa meilleure main de 5 cartes parmi les 7 (2 à lui + 5 communes).</li></ol>`],
        ["Tes actions", `<dl>
          <dt>Se coucher</dt><dd>Abandonner la main. Tu perds ce que tu as déjà misé.</dd>
          <dt>Parole</dt><dd>Passer sans miser, possible seulement si personne n'a misé.</dd>
          <dt>Suivre</dt><dd>Mettre autant que la plus grosse mise.</dd>
          <dt>Miser / Relancer</dt><dd>Augmenter la mise. Raccourcis Min, ½ pot, Pot ou Tapis, ou curseur.</dd>
          <dt>Tapis</dt><dd>Miser tous tes jetons. Tu ne peux gagner que ce que les autres ont misé face à toi : le reste forme un pot à part.</dd></dl>`],
        ["Les combinaisons, de la plus forte à la plus faible", `<table class="hrank">
          <tr><td>Quinte flush royale</td><td>${cards("A♠ R♠ D♠ V♠ 10♠")}</td></tr>
          <tr><td>Quinte flush</td><td>${cards("9♥ 8♥ 7♥ 6♥ 5♥")}</td></tr>
          <tr><td>Carré</td><td>${cards("7♠ 7♥ 7♦ 7♣ R♠")}</td></tr>
          <tr><td>Full</td><td>${cards("D♠ D♥ D♦ 4♣ 4♠")}</td></tr>
          <tr><td>Couleur</td><td>${cards("A♦ V♦ 8♦ 6♦ 2♦")}</td></tr>
          <tr><td>Quinte</td><td>${cards("10♣ 9♦ 8♠ 7♥ 6♣")}</td></tr>
          <tr><td>Brelan</td><td>${cards("5♠ 5♥ 5♦ R♣ 9♠")}</td></tr>
          <tr><td>Double paire</td><td>${cards("V♠ V♥ 3♦ 3♣ A♠")}</td></tr>
          <tr><td>Paire</td><td>${cards("A♥ A♣ 9♠ 7♦ 4♣")}</td></tr>
          <tr><td>Hauteur</td><td>${cards("R♦ 10♠ 8♥ 5♣ 2♦")}</td></tr></table>
          <p>À combinaison égale, la plus haute gagne (paire d'As > paire de Rois), puis la carte restante la plus forte départage. Si tout est égal, le pot est partagé. L'As compte aussi comme 1 dans la quinte ${cards("5♠ 4♥ 3♦ 2♣ A♠")}.</p>`],
        ["Astuces", `<ul>
          <li>Ne joue pas toutes les mains : les paires et deux grosses cartes (As, Roi, Dame) sont un bon départ.</li>
          <li>Ta main en cours s'affiche à côté de tes cartes, par exemple « Paire de 9 ».</li>
          <li>Relancer avec une bonne main fait payer les autres. Relancer sans rien, c'est bluffer : ça marche parfois.</li></ul>`]
      ]
    },
    videopoker: {
      title: "Vidéo poker",
      intro: "Le poker des machines de casino (Jacks or Better) : une seule main de 5 cartes, contre la machine.",
      sections: [
        ["Comment jouer", `<ol>
          <li>Choisis ta mise, puis <b>Distribuer</b> : tu reçois 5 cartes.</li>
          <li>Touche les cartes à <b>garder</b> (elles se soulèvent, marquées « GARDÉE »).</li>
          <li><b>Tirer</b> remplace les autres, une seule fois.</li>
          <li>Tu es payé selon ta main finale, d'après la table en haut de l'écran.</li></ol>`],
        ["Table des gains (pour 1 jeton misé)", `<table class="hpay">
          <tr><td>Quinte flush royale ${cards("A♠ R♠ D♠ V♠ 10♠")}</td><td>800</td></tr>
          <tr><td>Quinte flush</td><td>50</td></tr><tr><td>Carré</td><td>25</td></tr><tr><td>Full</td><td>9</td></tr>
          <tr><td>Couleur</td><td>6</td></tr><tr><td>Quinte</td><td>4</td></tr><tr><td>Brelan</td><td>3</td></tr>
          <tr><td>Double paire</td><td>2</td></tr><tr><td>Paire de Valets ou mieux ${cards("V♥ V♣")}</td><td>1 (mise rendue)</td></tr></table>
          <p>Une paire de 10 ou moins ne rapporte rien.</p>`],
        ["Astuces", `<ul>
          <li>Garde toujours une main déjà payante, sauf pour viser plus haut avec 4 cartes de la même couleur.</li>
          <li>Avec une petite paire, garde-la et tire 3 cartes.</li>
          <li>Sans rien, garde les figures (V, D, R) et l'As, et tire le reste.</li></ul>`]
      ]
    },
    online: {
      title: "Poker en ligne",
      intro: "Une table de Texas Hold'em entre amis, de 2 à 6 joueurs, chacun sur son téléphone.",
      sections: [
        ["Créer ou rejoindre", `<ol>
          <li>Écris ton prénom.</li>
          <li><b>Créer une table</b> donne un code de 5 caractères. <b>Inviter</b> l'envoie par message.</li>
          <li>Les autres tapent le code et touchent <b>Rejoindre</b>, ou ouvrent le lien reçu.</li>
          <li>Le créateur touche <b>Distribuer</b>. Il peut ajouter des bots pour compléter la table.</li></ol>`],
        ["Règles de la table", `<ul>
          <li>Mêmes règles que le Texas Hold'em (voir l'onglet Hold'em de cette aide).</li>
          <li>Chacun commence avec 1 000 jetons de table, séparés de ton solde du casino. À sec, tu repars à 1 000 à la main suivante.</li>
          <li>40 secondes pour jouer : ensuite, tu passes si c'est possible, sinon tu te couches.</li>
          <li>Les mains s'enchaînent toutes seules toutes les 8 secondes.</li></ul>`],
        ["Bon à savoir", `<ul>
          <li>Le téléphone du créateur fait tourner la table : s'il quitte l'app, la table s'arrête.</li>
          <li>Si ta connexion coupe, rejoins avec le même code et le même prénom pour retrouver ta place.</li>
          <li>Au bureau, si la connexion ne passe pas, essaie en 4G/5G.</li></ul>`]
      ]
    },
    classement: {
      title: "Classement, semaines et saisons",
      intro: "Tout ce que tu joues compte pour trois classements, et rapporte des couronnes à dépenser en boutique.",
      sections: [
        ["Les trois classements", `<dl>
          <dt>Semaine</dt><dd>Gains nets du lundi au dimanche. Classé à partir de 10 parties. Récompenses chaque lundi.</dd>
          <dt>Saison</dt><dd>Un mois. 1 point par partie, plus 1 point par tranche de 50 jetons gagnés. Perdre ne retire rien.</dd>
          <dt>Depuis toujours</dt><dd>Total gagné moins total misé. Les recharges de solde ne comptent pas.</dd></dl>`],
        ["Récompenses de la semaine", `<ul>
          <li>1ᵉʳ : 1 000 couronnes, plus le cadre Couronne et le titre Champion de la semaine, gardés tant que tu restes 1ᵉʳ.</li>
          <li>2ᵉ : 600, 3ᵉ : 400, 4ᵉ à 10ᵉ : 200, tous les autres classés : 50.</li></ul>`],
        ["Rangs de saison", `<p>Bronze (20 pts), Fer (100), Argent (250), Or (400), Platine (600), Diamant (1 000), Alexandrite (2 000), Top 100 (les 100 meilleurs dès 2 000 points).</p>
          <p>En fin de saison, tu reçois la bannière, le cadre, le titre et les couronnes de ton rang <b>et de tous les rangs en dessous</b>. Ces objets portent le numéro de la saison et ne reviennent jamais. Le 1ᵉʳ de la saison, dès le rang Argent, reçoit en plus l'ensemble Champion et 5 000 couronnes.</p>`],
        ["Amis et profils", `<ul>
          <li><b>Mon QR code</b> : fais-le scanner pour devenir amis dans les deux sens.</li>
          <li>Touche un joueur pour voir son profil, ou utilise la loupe en haut pour le chercher.</li></ul>`]
      ]
    },
    boutique: {
      title: "Boutique, couronnes et casier",
      intro: "Les couronnes servent à personnaliser ta carte de joueur : bannière, cadre autour de ta photo, titre sous ton pseudo.",
      sections: [
        ["Gagner des couronnes", `<ul>
          <li>150 offertes à la création du compte.</li>
          <li>Chaque lundi, selon ta place au classement de la semaine.</li>
          <li>Chaque fin de mois, selon ton rang de saison.</li>
          <li>Chaque jour : 3 défis (bonus de 50 si tu fais les 3) et la connexion quotidienne (5, 5, 5, 20, 20, 20 puis 50 couronnes le 7ᵉ jour d'affilée).</li></ul>`],
        ["La boutique", `<ul>
          <li>Une sélection différente chaque lundi : 8 bannières, 5 cadres et 7 titres.</li>
          <li>Touche un objet pour l'essayer en aperçu, puis Acheter. Il rejoint ton casier.</li>
          <li>La rareté indique combien de joueurs l'ont : Commun, Rare, Épique, Légendaire.</li></ul>`],
        ["Le casier", `<ul>
          <li>Tous tes objets : achats, récompenses de semaine et de saison, objets gratuits.</li>
          <li>Cherche un objet par son nom, touche-le pour l'essayer, puis Équiper.</li>
          <li><b>Changer la photo</b> met ta propre image dans ton avatar.</li></ul>`]
      ]
    }
  };
  HELP.casier = HELP.boutique;
  HELP.rangs = HELP.classement;
  HELP.defis = {
    title: "Défis et connexion",
    intro: "Deux façons de gagner des couronnes chaque jour, même sans être en tête du classement.",
    sections: [
      ["Défis du jour", `<ul>
        <li>3 défis tirés chaque jour à minuit (heure de Paris), les mêmes pour tout le monde.</li>
        <li>Joue normalement : le serveur suit ta progression et verse les couronnes dès qu'un défi est réussi.</li>
        <li>Réussis les 3 pour un bonus de 50 couronnes.</li></ul>`],
      ["Connexion quotidienne", `<p>Ouvre l'app chaque jour pour faire grandir ta série.</p>
        <table class="hpay"><tr><td>Jours 1, 2 et 3</td><td>5 couronnes</td></tr><tr><td>Jours 4, 5 et 6</td><td>20 couronnes</td></tr><tr><td>Jour 7</td><td>50 couronnes</td></tr></table>
        <p>Après le 7ᵉ jour, ou si tu manques un jour, la série repart au jour 1.</p>`]
    ]
  };
  const css4 = document.createElement("style");
  css4.textContent = `
.help-btn { font: 700 18px var(--f-display, Georgia, serif); color: var(--brass); }
.hc-row { display: inline-flex; gap: 3px; vertical-align: middle; margin: 0 2px; }
.hc { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; width: 24px; height: 32px; border-radius: 4px; background: #fbf8f1; color: #1b1e24; font: 700 11px/1 var(--f-ui, Arial, sans-serif); box-shadow: 0 1px 3px rgba(0,0,0,.4); }
.hc i { font-style: normal; font-size: 12px; margin-top: 1px; }
.hc.red { color: #c22f3a; }
.hchip { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--c); color: #fff; font-size: 10px; font-weight: 700; border: 2px dashed rgba(255,255,255,.6); vertical-align: middle; box-sizing: border-box; }
.hd { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #fbf8f1; color: #1b1e24; font-size: 11px; font-weight: 700; vertical-align: middle; }
.help-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.help-tabs button { height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid var(--felt-line); background: var(--glass); color: var(--muted); font: 600 14px var(--f-ui); cursor: pointer; }
.help-tabs button[aria-pressed="true"] { background: var(--brass); color: var(--brass-ink); border-color: var(--brass); }
.help-intro { margin: 0; font-size: 16px; line-height: 1.5; color: var(--ink); }
.help-sec { background: var(--glass); border-radius: 14px; overflow: hidden; }
.help-sec summary { list-style: none; cursor: pointer; padding: 13px 14px; font-weight: 700; font-size: 15.5px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.help-sec summary::-webkit-details-marker { display: none; }
.help-sec summary::after { content: "+"; font-size: 20px; color: var(--brass); transition: transform .2s; }
.help-sec[open] summary::after { transform: rotate(45deg); }
.help-body { padding: 0 14px 14px; font-size: 14.5px; line-height: 1.6; color: rgba(242,238,227,.88); }
.help-body p { margin: 8px 0 0; }
.help-body ul, .help-body ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.help-body dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
.help-body dt { font-weight: 700; color: var(--brass); }
.help-body dd { margin: 0; }
.help-body table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.help-body td, .help-body th { padding: 7px 6px; border-bottom: 1px solid rgba(255,255,255,.08); text-align: left; vertical-align: middle; }
.help-body th { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.hpay td:nth-child(2) { color: var(--brass); font-weight: 700; white-space: nowrap; }
.hpay td:nth-child(3) { color: var(--muted); white-space: nowrap; }
.hrank td:first-child { font-weight: 600; white-space: nowrap; padding-right: 10px; }
.help-foot { display: flex; justify-content: center; }
@media (max-width: 480px) { .bar .acct-chip > span:last-child { display: none; } .bar .acct-chip { padding: 0 4px; max-width: none; } }
@media (max-width: 380px) { .hc { width: 21px; height: 29px; font-size: 10px; } .help-body dl { grid-template-columns: 1fr; gap: 2px; } .help-body dd { margin-bottom: 6px; } }`;
  document.head.appendChild(css4);

  function helpTopic() {
    const p = document.body.dataset.page;
    if (p === "poker") return document.getElementById("modeV") && document.getElementById("modeV").getAttribute("aria-pressed") === "true" ? "videopoker" : "holdem";
    return HELP[p] ? p : null;
  }
  function openHelp(topic) {
    topic = topic || helpTopic();
    if (!HELP[topic]) return;
    const page = document.body.dataset.page;
    const tabs = page === "poker" || page === "online" ? ["holdem", "videopoker", "online"] : null;
    openSheet((sheet) => {
      const paint = t => {
        const h = HELP[t];
        try { localStorage.setItem("casino.help." + t, "1"); } catch (e) {}
        sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
          <div class="ph"><h2>Règles · ${h.title}</h2><button class="x" data-close aria-label="Fermer">×</button></div>
          ${tabs ? `<div class="help-tabs" role="group" aria-label="Jeu">${tabs.map(k => `<button data-t="${k}" aria-pressed="${k === t}">${HELP[k].title}</button>`).join("")}</div>` : ""}
          <p class="help-intro">${h.intro}</p>
          ${h.sections.map(([name, body], i) => `<details class="help-sec rise" style="--i:${i}"${i < 2 ? " open" : ""}><summary>${name}</summary><div class="help-body">${body}</div></details>`).join("")}
          <div class="help-foot"><button class="btn primary" data-close>J'ai compris</button></div>`;
        sheet.scrollTop = 0;
      };
      sheet.addEventListener("click", e => { const b = e.target.closest("[data-t]"); if (b) paint(b.dataset.t); });
      paint(topic);
    });
  }
  function mountHelp() {
    const right = document.querySelector(".app .bar .bar-right");
    if (!right || right.querySelector(".help-btn") || !helpTopic()) return;
    const b = document.createElement("button");
    b.className = "search-btn help-btn";
    b.type = "button";
    b.setAttribute("aria-label", "Règles du jeu");
    b.textContent = "?";
    b.onclick = () => openHelp();
    right.prepend(b);
    // the first time a game is opened, show its rules once
    const t = helpTopic();
    let seen = true;
    try { seen = !!localStorage.getItem("casino.help." + t); } catch (e) {}
    if (!seen && ["blackjack", "roulette", "holdem", "videopoker", "online"].includes(t)) {
      setTimeout(() => { if (!document.querySelector(".psheet-scrim, .reward-scrim")) openHelp(t); }, document.documentElement.classList.contains("booting") ? 2200 : 700);
    }
  }

  Object.assign(window.CasinoUI, { openSearch, rarity, openHelp });
  // ---------- iPhone: full height, safe areas, portrait only ----------
  // iOS ignores the manifest orientation for web apps, so on phones held sideways the
  // whole page is turned back upright; the app height is measured instead of trusting 100%.
  const isIOS = document.documentElement.classList.contains("is-ios");
  function fitScreen() {
    const root = document.documentElement;
    const phone = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
    const landscape = innerWidth > innerHeight;
    root.classList.remove("rot-l", "rot-r");
    if (phone && landscape) {
      const a = screen.orientation && typeof screen.orientation.angle === "number" ? screen.orientation.angle : (window.orientation || 90);
      root.classList.add(a === 270 || a === -90 ? "rot-r" : "rot-l");
      root.style.setProperty("--rot-w", innerHeight + "px");
      root.style.setProperty("--rot-h", innerWidth + "px");
    }
    const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
    const h = isIOS && standalone && !landscape ? Math.max(innerHeight, screen.height) : innerHeight;
    root.style.setProperty("--app-h", h + "px");
  }
  fitScreen();
  addEventListener("resize", fitScreen);
  addEventListener("orientationchange", () => setTimeout(fitScreen, 120));
  const css5 = document.createElement("style");
  css5.textContent = `
html { height: var(--app-h, 100%) !important; padding-bottom: 0 !important; }
html, body { min-height: 0 !important; }
body { height: 100% !important; }
.app { padding-bottom: 0 !important; }
.tabbar { margin-bottom: 0 !important; padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px)) !important; }
html.rot-l, html.rot-r { height: 100% !important; overflow: hidden; padding: 0 !important; }
html.rot-l body, html.rot-r body { position: fixed; width: var(--rot-w) !important; height: var(--rot-h) !important; transform-origin: 0 0; overflow: hidden; box-sizing: border-box; }
html.rot-l body { top: 100%; left: 0; transform: rotate(-90deg); padding-top: env(safe-area-inset-left, 0px); }
html.rot-r body { top: 0; left: 100%; transform: rotate(90deg); padding-top: env(safe-area-inset-right, 0px); }
html.rot-l .tabbar, html.rot-r .tabbar { padding-bottom: 4px !important; }

/* small notices */
.toasts { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 86px); transform: translateX(-50%); z-index: 60; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; width: min(92vw, 420px); }
.toast { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 14px; background: rgba(6, 30, 23, .94); border: 1px solid var(--brass); color: var(--ink); font: 600 14px var(--f-ui); box-shadow: 0 10px 30px rgba(0,0,0,.45); animation: toast-in .4s cubic-bezier(.3,1.4,.5,1) both; pointer-events: auto; }
.toast.out { animation: toast-out .3s ease both; }
.toast b { color: var(--brass); white-space: nowrap; }
.toast span { flex: 1; min-width: 0; }
@keyframes toast-in { from { transform: translateY(16px) scale(.95); opacity: 0; } }
@keyframes toast-out { to { transform: translateY(10px); opacity: 0; } }
@media (min-width: 1100px) and (hover: hover) and (pointer: fine) { .toasts { bottom: 24px; left: calc(50% + 48px); } }

/* 7-day login track */
.streak { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; }
.streak div { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 0 6px; border-radius: 10px; background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.08); font-size: 10.5px; color: var(--muted); }
.streak div b { font-size: 14px; color: var(--ink); font-variant-numeric: tabular-nums; }
.streak div.done { background: rgba(216,178,106,.18); border-color: rgba(216,178,106,.45); }
.streak div.done b { color: var(--brass); }
.streak div.today { background: var(--brass); border-color: var(--brass); color: var(--brass-ink); }
.streak div.today b { color: var(--brass-ink); }
.streak div.big b { font-size: 16px; }`;
  document.head.appendChild(css5);

  // ---------- daily login and challenges ----------
  const LOGIN_TRACK = [5, 5, 5, 20, 20, 20, 50];
  let daily = read("casino.daily", null), dailyBusy = false, dailyAt = 0;
  const dailyListeners = new Set();
  function streakHTML(streak, todayDone) {
    return `<div class="streak">${LOGIN_TRACK.map((c, i) => {
      const day = i + 1, cls = day < streak ? "done" : day === streak ? "today" : "";
      return `<div class="${cls}${day === 7 ? " big" : ""}">J${day}<b>${c}</b></div>`;
    }).join("")}</div>`;
  }
  function toast(text, crowns) {
    let box = document.querySelector(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `${CROWN}<span>${escHTML(text)}</span>${crowns ? `<b>+${crowns}</b>` : ""}`;
    box.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, 3800);
  }
  function showLogin(st) {
    if (document.querySelector(".reward-scrim")) { setTimeout(() => showLogin(st), 800); return; }
    const box = document.createElement("div");
    box.className = "reward-scrim";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const next = st.streak >= 7 ? "La série recommence demain au jour 1." : `Reviens demain pour +${st.login_next} couronnes.`;
    box.innerHTML = `<div class="reward-box">
      <h2>Connexion du jour</h2>
      <p>${st.streak === 1 ? "Premier jour de ta série." : `${st.streak} jours d'affilée !`}</p>
      <div class="reward-crowns">+${st.login_gain} ${CROWN}</div>
      ${streakHTML(st.streak, true)}
      <p>${next} Un jour manqué remet la série à zéro.</p>
      <button class="btn primary" type="button">Récupérer</button>
    </div>`;
    document.body.appendChild(box);
    if (st.streak === 7) confetti();
    box.querySelector("button").onclick = () => box.remove();
  }
  async function runDaily(force) {
    if (!configured() || !session || navigator.onLine === false || dailyBusy) return daily;
    if (!force && Date.now() - dailyAt < 15000) return daily;
    dailyBusy = true;
    try {
      const st = await api("/rest/v1/rpc/daily_status", { method: "POST", body: {} });
      dailyAt = Date.now();
      if (st) {
        daily = st;
        write("casino.daily", st);
        if (profile && typeof st.crowns === "number") keepProfile({ ...profile, crowns: st.crowns });
        if (st.login_gain > 0) showLogin(st);
        (st.newly || []).forEach((n, i) => setTimeout(() => toast(`Défi réussi : ${n.label}`, n.crowns), 400 + i * 700));
        dailyListeners.forEach(f => { try { f(st); } catch (e) {} });
      }
    } catch (e) { /* server not updated yet, or offline */ }
    dailyBusy = false;
    return daily;
  }
  // games just uploaded may complete a challenge
  const afterFlush = () => setTimeout(() => runDaily(false), 600);
  Object.assign(window.CasinoAccount, {
    daily: () => daily, runDaily, onDaily: f => { dailyListeners.add(f); return () => dailyListeners.delete(f); }, LOGIN_TRACK
  });
  Object.assign(window.CasinoUI, { toast, streakHTML });

  const boot = () => { mountNav(); mountSearch(); mountHelp(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  setTimeout(checkRewards, 1200);
  setTimeout(() => runDaily(true), 1900);
})();
