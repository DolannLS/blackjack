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
  const GAMES = { blackjack: "Blackjack", roulette: "Roulette", holdem: "Hold'em", videopoker: "Vidéo poker", online: "Poker en ligne", slots: "Machine à sous" };

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch (e) { return d; } };
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
    { id: "ft-vert", kind: "felt", name: "Feutre vert", price: 0 },
    { id: "ft-bleu-nuit", kind: "felt", name: "Feutre bleu nuit", price: 400 },
    { id: "ft-bordeaux", kind: "felt", name: "Feutre bordeaux", price: 400 },
    { id: "ft-noir", kind: "felt", name: "Feutre noir", price: 500 },
    { id: "ft-violet", kind: "felt", name: "Feutre violet", price: 450 },
    { id: "ft-turquoise", kind: "felt", name: "Feutre turquoise", price: 450 },
    { id: "ft-sable", kind: "felt", name: "Feutre sable", price: 350 },
    { id: "ft-anthracite", kind: "felt", name: "Feutre anthracite", price: 400 },
    { id: "ft-rose", kind: "felt", name: "Feutre rose", price: 350 },
    { id: "ft-vegas", kind: "felt", name: "Néons de Las Vegas", price: 1200 },
    { id: "ft-monaco", kind: "felt", name: "Salon de Monaco", price: 1500 },
    { id: "ft-carbone", kind: "felt", name: "Fibre de carbone", price: 900 },
    { id: "ft-marbre", kind: "felt", name: "Marbre et or", price: 1400 },
    { id: "ft-large", kind: "felt", name: "Grand large", price: 800 },
    { id: "ft-voie-lactee", kind: "felt", name: "Voie lactée", price: 1600 },
    { id: "ft-damier", kind: "felt", name: "Damier royal", price: 700 },
    { id: "ft-cuir", kind: "felt", name: "Cuir capitonné", price: 1000 },
    { id: "ft-chene", kind: "felt", name: "Table en chêne", price: 600 },
    // collection Prestige
    { id: "vegas-skyline", kind: "banner", name: "Skyline de Las Vegas", price: 2200 },
    { id: "pluie-cartes", kind: "banner", name: "Pluie de cartes", price: 2400 },
    { id: "roulette-live", kind: "banner", name: "Roulette en marche", price: 2600 },
    { id: "aurore-vivante", kind: "banner", name: "Aurore vivante", price: 1800 },
    { id: "dragon-imperial", kind: "banner", name: "Dragon impérial", price: 3000 },
    { id: "monte-carlo", kind: "banner", name: "Nuit à Monte-Carlo", price: 2200 },
    { id: "orage-electrique", kind: "banner", name: "Orage électrique", price: 2000 },
    { id: "neon-777", kind: "banner", name: "Néon 777", price: 2500 },
    { id: "tresor", kind: "banner", name: "Trésor du casino", price: 2400 },
    { id: "galaxie-spirale", kind: "banner", name: "Galaxie spirale", price: 2200 },
    { id: "feu-artifice", kind: "banner", name: "Feu d'artifice", price: 2600 },
    { id: "koi", kind: "banner", name: "Bassin des carpes koï", price: 2000 },
    { id: "pluie-diamants", kind: "banner", name: "Pluie de diamants", price: 2800 },
    { id: "rideau-velours", kind: "banner", name: "Lever de rideau", price: 1900 },
    { id: "route-synthwave", kind: "banner", name: "Route synthwave", price: 2400 },
    { id: "feu-sacre", kind: "banner", name: "Feu sacré", price: 2600 },
    { id: "laurier", kind: "frame", name: "Couronne de laurier", price: 1800, ornate: true },
    { id: "orbite-as", kind: "frame", name: "Orbite des As", price: 2000, ornate: true },
    { id: "anneau-feu", kind: "frame", name: "Anneau de feu", price: 1900, ornate: true },
    { id: "givre", kind: "frame", name: "Couronne de givre", price: 1600, ornate: true },
    { id: "neon-pulse", kind: "frame", name: "Néon pulsé", price: 1500 },
    { id: "serti-rubis", kind: "frame", name: "Serti de rubis", price: 1700, ornate: true },
    { id: "halo-celeste", kind: "frame", name: "Halo céleste", price: 2200, ornate: true },
    { id: "anneau-jetons", kind: "frame", name: "Anneau de jetons", price: 1600 },
    { id: "jackpot", kind: "title", name: "Jackpot", price: 1500 },
    { id: "main-du-diable", kind: "title", name: "Main du diable", price: 1800 },
    { id: "coeur-de-glace", kind: "title", name: "Cœur de glace", price: 1500 },
    { id: "oiseau-de-nuit", kind: "title", name: "Oiseau de nuit", price: 1600 },
    { id: "le-magnat", kind: "title", name: "Le Magnat", price: 2000 },
    { id: "hors-systeme", kind: "title", name: "Hors système", price: 1700 },
    { id: "empereur", kind: "title", name: "Empereur du casino", price: 2500 },
    { id: "intouchable", kind: "title", name: "Intouchable", price: 1800 },
    { id: "maitre-du-temps", kind: "title", name: "Maître du temps", price: 1400 },
    { id: "ame-de-dragon", kind: "title", name: "Âme de dragon", price: 2000 },
    { id: "etoile-filante", kind: "title", name: "Étoile filante", price: 1500 },
    { id: "millionnaire", kind: "title", name: "Millionnaire", price: 2200 },
    { id: "ft-royal", kind: "felt", name: "Feutre royal", price: 1800 },
    { id: "ft-cyber", kind: "felt", name: "Néon cyberpunk", price: 1900 },
    { id: "ft-dragon", kind: "felt", name: "Dragon rouge", price: 2400 },
    { id: "ft-monte-carlo", kind: "felt", name: "Monte-Carlo", price: 2000 },
    { id: "ft-lave", kind: "felt", name: "Lave en fusion", price: 2200 },
    { id: "ft-aurore", kind: "felt", name: "Aurore boréale", price: 2200 },
    { id: "roue-fortune", kind: "banner", name: "Roue de la fortune", price: null, how: "super lot de la roue du jour" },
    { id: "champion", kind: "title", name: "Champion de la semaine", price: null, how: "1ᵉʳ de la semaine, tant que tu le restes" }
  ];
  const STATIC = Object.fromEntries(SHOP.map(x => [x.id, x]));
  // monthly season ranks, lowest first (mirrors supabase/casier.sql)
  const TIERS = [
    { id: "bronze", name: "Bronze", min: 50, crowns: 100, base: "Joueur du dimanche" },
    { id: "fer", name: "Fer", min: 250, crowns: 200, base: "Main de fer" },
    { id: "argent", name: "Argent", min: 600, crowns: 350, base: "Joueur d'argent" },
    { id: "or", name: "Or", min: 1000, crowns: 550, base: "Main en or" },
    { id: "platine", name: "Platine", min: 1600, crowns: 800, base: "Mise de platine" },
    { id: "diamant", name: "Diamant", min: 2500, crowns: 1200, base: "Cœur de diamant" },
    { id: "alexandrite", name: "Alexandrite", min: 4000, crowns: 2000, base: "Alexandrite" },
    { id: "top-100", name: "Top 100", min: 4000, crowns: 3000, base: "Top 100", note: "100 meilleurs, dès 4 000 points" }
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
    const label = !holders ? "Inédit" : pct <= 2 ? "Légendaire" : pct <= 8 ? "Épique" : pct <= 25 ? "Rare" : "Commun";
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
    if (p) { keepProfile(p); syncChips(p).catch(() => {}); }
    return p;
  }

  // ---------- play balance, kept on the account ----------
  // The server follows the balance through the games it receives; this phone shows that balance
  // plus the games still waiting to be sent.
  const WALLET = "bj.table.v1";
  const pendingNet = () => pending().filter(x => x.game !== "online").reduce((a, x) => a + x.payout - x.stake, 0);
  const localChips = () => { const w = read(WALLET, {}) || {}; return typeof w.bankroll === "number" ? w.bankroll : 1000; };
  function setChips(n) {
    n = Math.max(0, Math.round(n * 100) / 100);
    if (typeof window.CasinoWallet === "function") { window.CasinoWallet(n); return; } // a game page applies it between hands
    const w = read(WALLET, {}) || {}; w.bankroll = n; write(WALLET, w);
  }
  async function syncChips(p) {
    if (!p || !session || flushing || !("chips" in p)) return;
    let chips = p.chips;
    if (chips == null) {
      // first time on the new system: the balance this phone had becomes the account's
      chips = await api("/rest/v1/rpc/init_chips", { method: "POST", body: { amount: localChips() - pendingNet() } });
      if (profile) keepProfile({ ...profile, chips });
    }
    if (flushing) return;
    setChips(+chips + pendingNet());
  }
  // a free refill of 1 000 every 4 hours, 3 a day at most, only when the balance is (almost) empty
  const REFILL_GAP = 4 * 3600e3, REFILLS_A_DAY = 3;
  const waitText = min => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`; };
  async function refillChips() {
    const localRefill = () => {
      const day = wheelDay(), st = read("refill.local", {}) || {};
      const used = st.day === day ? st.count || 0 : 0;
      if (used >= REFILLS_A_DAY) throw new Error("Tes 3 recharges gratuites du jour sont utilisées. Elles reviennent à minuit.");
      const left = (st.at || 0) + REFILL_GAP - Date.now();
      if (left > 0) throw new Error(`Prochaine recharge gratuite dans ${waitText(Math.ceil(left / 60000))}.`);
      write("refill.local", { day, count: used + 1, at: Date.now() });
      return 1000;
    };
    if (!configured() || !session) return localRefill();
    await flush();
    if (pending().length) throw new Error(navigator.onLine === false ? "Il faut internet pour recharger." : "Tes dernières parties sont en cours d'envoi, réessaie dans un instant.");
    try {
      const n = await api("/rest/v1/rpc/refill_chips", { method: "POST", body: {} });
      if (profile) keepProfile({ ...profile, chips: n, refill_next: new Date(Date.now() + REFILL_GAP).toISOString(),
        refills_left: Math.max(0, (profile.refills_left == null ? REFILLS_A_DAY : profile.refills_left) - 1) });
      return +n;
    } catch (e) {
      if (/refill_chips|function/.test(e.raw || "")) return localRefill(); // server not updated yet
      const soon = /^trop_tot:(\d+)/.exec(e.raw || "");
      if (soon && profile) keepProfile({ ...profile, refill_next: new Date(Date.now() + +soon[1] * 60000).toISOString() });
      if (e.raw === "deja_recharge" && profile) keepProfile({ ...profile, refills_left: 0 });
      throw new Error(soon ? `Prochaine recharge gratuite dans ${waitText(+soon[1])}. En attendant : la roue du jour, ou échange des couronnes contre des jetons dans la Boutique.`
        : e.raw === "deja_recharge" ? "Tes 3 recharges gratuites du jour sont utilisées. Elles reviennent à minuit. Tu peux aussi échanger des couronnes contre des jetons dans la Boutique."
        : e.raw === "pas_a_sec" ? "Ton solde n'est pas vide sur ton compte : recharge la page."
        : e.code === "network" ? "Il faut internet pour recharger." : e.message);
    }
  }
  // when the next free refill comes: on the account if the server knows it, otherwise on this phone
  function refillState() {
    let left, next;
    if (session && profile && "refills_left" in profile) {
      left = profile.refills_left == null ? REFILLS_A_DAY : +profile.refills_left;
      next = profile.refill_next ? Date.parse(profile.refill_next) : 0;
    } else {
      const st = read("refill.local", {}) || {}, today = st.day === wheelDay();
      left = REFILLS_A_DAY - (today ? st.count || 0 : 0);
      next = today ? (st.at || 0) + REFILL_GAP : 0;
    }
    if (left <= 0) {
      const d = daily && daily.resets_at ? Date.parse(daily.resets_at) : (() => { const m = new Date(); m.setHours(24, 0, 0, 0); return m.getTime(); })();
      return { ready: false, until: d, limit: true };
    }
    return next > Date.now() ? { ready: false, until: next } : { ready: true };
  }
  const clock = ms => { const t = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0"); };
  // every refill button of the games shows a live countdown until it can be used
  function paintRefill() {
    const st = refillState();
    document.querySelectorAll("[data-refill]").forEach(b => {
      const text = st.ready ? "Recharger 1 000" : st.limit ? `Nouvelles recharges dans ${clock(st.until - Date.now())}` : `Recharge dans ${clock(st.until - Date.now())}`;
      if (b.textContent !== text) b.textContent = text;
      if (b.disabled !== !st.ready) b.disabled = !st.ready;
      b.classList.toggle("refill-wait", !st.ready);
    });
  }
  setInterval(paintRefill, 1000);
  new MutationObserver(list => { if (list.some(m => m.target.nodeType === 1 && (m.target.closest("[data-refill]") || m.target.querySelector && m.target.querySelector("[data-refill]")))) paintRefill(); })
    .observe(document.documentElement, { childList: true, subtree: true });
  // 3. crowns for chips: 100 crowns = 1 000 chips
  async function buyChips(packs) {
    await flush();
    try {
      const r = await api("/rest/v1/rpc/buy_chips", { method: "POST", body: { packs } });
      if (profile) keepProfile({ ...profile, crowns: r.crowns, chips: r.chips });
      setChips(+r.chips + pendingNet());
      return r;
    } catch (e) {
      throw new Error(e.raw === "solde" ? "Pas assez de couronnes pour cet échange." : e.raw === "solde_inconnu" ? "Ton solde se met à jour, réessaie dans un instant."
        : /buy_chips|function/.test(e.raw || "") ? "L'échange arrive avec la mise à jour du serveur." : e.code === "network" ? "Il faut internet pour échanger." : e.message);
    }
  }
  // without an account, the daily 500 chips are given on this phone
  function localDailyChips() {
    if (session) return;
    const day = wheelDay();
    if (read("chips.bonus.day", "") === day) return;
    write("chips.bonus.day", day);
    setChips(localChips() + 500);
    setTimeout(() => toast("+500 jetons offerts aujourd'hui"), 1500);
  }
  setTimeout(localDailyChips, 900);

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
  // daily wheel: the server draws the prize; chips go to this phone's balance, crowns and items to the account
  const wheelStatus = () => api("/rest/v1/rpc/wheel_status", { method: "POST", body: {} });
  async function spinWheel() {
    let r;
    try { r = await api("/rest/v1/rpc/spin_wheel", { method: "POST", body: {} }); }
    catch (e) { throw new Error(e.raw === "deja_tourne" ? "Tu as déjà tourné la roue aujourd'hui. Reviens demain !" : /spin_wheel|function/.test(e.raw || "") ? "La roue arrive avec la mise à jour du serveur." : e.message); }
    if (r.total_chips != null) setChips(+r.total_chips + pendingNet());
    else if (r.chips) setChips(localChips() + r.chips);
    write("wheel.day", wheelDay());
    if (profile) keepProfile({ ...profile, crowns: r.total_crowns, owned: r.item ? [...new Set([...(profile.owned || []), r.item])] : profile.owned });
    return r;
  }
  // the current day in Paris, as the server counts it
  const wheelDay = () => new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date());
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
  const escHTML = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (typeof u === "string" && /^https:\/\/[^"'<>\s]+$/.test(u) ? u : "");
  function avatarHTML(name, frame, size = "", photo = "") {
    const src = safeUrl(photo), f = frame || "aucun", q = f === "aucun" ? 1 : quality(f);
    return `<span class="av ${size} fr-${escHTML(f)} fq${q}${src ? " has-photo" : ""}">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async">` : escHTML((name || "?")[0].toUpperCase())}${q === 4 && f !== "couronne" && !(STATIC[f] && STATIC[f].ornate) ? `<i class="gem" aria-hidden="true"></i>` : ""}</span>`;
  }
  // the felt equipped by the player (kept offline in the cached profile)
  const feltId = () => { const f = profile && profile.felt; return f && STATIC[f] && STATIC[f].kind === "felt" ? f : "ft-vert"; };
  const feltHTML = id => `<div class="mini-felt ${escHTML(id || "ft-vert")}"><i>A<b>♠︎</b></i><i class="r">R<b>♥︎</b></i><i class="r">10<b>♦︎</b></i></div>`;
  function applyFelt() {
    const f = feltId();
    document.querySelectorAll(".ptable .oval").forEach(el => {
      [...el.classList].filter(c => c.startsWith("ft-")).forEach(c => el.classList.remove(c));
      el.classList.add(f);
    });
  }
  function titleText(id) {
    const t = itemInfo(id);
    return t && t.kind === "title" && t.id !== "sans-titre" ? t.name : "";
  }
  // how much an item shines: 1 classique, 2 rare, 3 épique, 4 légendaire (from its price, or its season rank)
  function quality(id) {
    const it = itemInfo(id); if (!it) return 1;
    if (it.season) return it.tier === "champion" || ["platine", "diamant", "alexandrite", "top-100"].includes(it.tier) ? 4 : ["argent", "or"].includes(it.tier) ? 3 : 2;
    if (it.price === null) return 4;
    if (!it.price) return 1;
    return it.price <= 400 ? 1 : it.price <= 800 ? 2 : it.price <= 1300 ? 3 : 4;
  }
  const QUALITY = ["", "Classique", "Rare", "Épique", "Légendaire"];
  // gloss, coloured edge, moving sheen and sparkles laid over a banner or a swatch
  const fxHTML = q => q > 1 ? `<i class="fx q${q}" aria-hidden="true">${q === 4 ? "<b></b><b></b><b></b>" : ""}</i>` : "";
  const qualityTag = id => { const q = quality(id); return q > 1 ? `<span class="qtag q${q}">${QUALITY[q]}</span>` : ""; };
  const titleHTML = (id, text) => `<span class="pc-title tq${quality(id)} tt-${escHTML(id)}">${escHTML(text)}</span>`;
  // the picture of an item in the shop and the locker
  function swatchHTML(it, { name = "Toi", frame = "aucun", photo = "" } = {}) {
    const q = quality(it.id), tag = "";
    if (it.kind === "banner") return `<div class="sw bn-${escHTML(it.id)}">${fxHTML(q)}${avatarHTML(name, frame, "md", photo)}${tag}</div>`;
    if (it.kind === "frame") return `<div class="sw frame-sw">${avatarHTML(name, it.id, "md", photo)}${tag}</div>`;
    if (it.kind === "felt") return `<div class="sw felt-sw">${feltHTML(it.id)}${tag}</div>`;
    return `<div class="sw title-sw"><div class="plate"><small>${escHTML(name)}</small>${it.id === "sans-titre" ? `<span class="pc-title tq1">—</span>` : titleHTML(it.id, it.name)}</div>${tag}</div>`;
  }
  function cardHTML({ name, banner, frame, title, avatar = "", sub = "", right = "", cls = "" }) {
    const t = titleText(title);
    return `<div class="pcard bn-${escHTML(banner || "tapis")} ${cls}">
      ${fxHTML(quality(banner || "tapis"))}
      ${avatarHTML(name, frame, "lg", avatar)}
      <div class="pc-who"><b>${escHTML(name)}</b>${t ? titleHTML(title, t) : ""}${sub ? `<span class="pc-sub">${sub}</span>` : ""}</div>
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
    shopWeek, itemStats, locker, searchPlayers, uploadAvatar, removeAvatar, wheelStatus, spinWheel, wheelDay, refillChips, buyChips,
    seasonBoard, publicProfile, liveFeed, botsTick, renameAccount, changePassword, deleteAccount,
    localHistory: () => read(HISTORY, []),
    onChange: f => { listeners.add(f); return () => listeners.delete(f); }
  };
  window.CasinoUI = { cardHTML, avatarHTML, titleText, esc: escHTML, feltHTML, feltId, applyFelt, quality, QUALITY, fxHTML, swatchHTML, titleHTML, qualityTag };
  listeners.add(() => applyFelt());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyFelt); else applyFelt();
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });
  setTimeout(flush, 800);

  // ---------- look & motion shared by every page ----------
  const ICONS = {
    blackjack: '<rect x="3" y="6" width="11" height="15" rx="2"/><path d="M9.5 5.2l7.8-1.6a2 2 0 0 1 2.4 1.5l2.2 10.6a2 2 0 0 1-1.5 2.4L14 19.6"/>',
    roulette: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    slots: '<rect x="2.5" y="5" width="16" height="15" rx="2.5"/><path d="M7.5 5v15M13.5 5v15"/><path d="M4.4 11h1.5l-1 3M10.4 11h1.5l-1 3M16.4 11h1.5l-1 3"/><path d="M18.5 9h1.5a1 1 0 0 0 1-1V5.5"/><circle cx="21" cy="4.5" r="1.3"/>',
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
    ["#jeux", "games", "Jeux", /(^$|index\.html$|roulette\.html$|poker\.html$|online\.html$|slots\.html$)/],
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
.tabbar { flex: none; position: relative; margin-top: 8px; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0; padding: 6px 2px 2px; border-radius: 18px 18px 0 0; background: rgba(var(--deep-rgb, 3, 18, 14), .62); border-top: 1px solid var(--felt-line); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); margin-inline: -6px; margin-bottom: -6px; }
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
    { href: "online.html", page: "online", name: "Poker en ligne", text: "Une table entre amis, de 2 à 6 joueurs.", icon: "games" },
    { href: "slots.html", page: "slots", name: "Machine à sous", text: "Trois rouleaux, une ligne : vise le 7 7 7.", icon: "slots" }
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
    const defis = nav.querySelector('a[href="defis.html"]');
    const markWheel = () => defis && defis.classList.toggle("wheel-ready", !!session && read("wheel.day", "") !== wheelDay());
    markWheel(); listeners.add(markWheel);
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
.psheet { width: 100%; max-width: 560px; max-height: 92%; overflow-y: auto; -webkit-overflow-scrolling: touch; box-sizing: border-box; background: var(--sheet-bg, #0a3328); border-top: 1px solid var(--felt-line); border-radius: 22px 22px 0 0; padding: 14px max(18px, env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px)) max(18px, env(safe-area-inset-left, 0px)); display: flex; flex-direction: column; gap: 14px; animation: sheet-up .32s cubic-bezier(.2,.8,.25,1) both; color: var(--ink); font-family: var(--f-ui); }
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
      else if (p && p.gifts && p.gifts.length) showGift(p.gifts[0]);
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

  // ---------- app theme ----------
  const THEME_LIST = [
    ["vert", "Classique", "Le tapis vert du casino", "radial-gradient(circle at 50% 30%, #13604b, #0b3d30 55%, #062a21)"],
    ["sombre", "Sombre", "Noir profond, reposant le soir", "radial-gradient(circle at 50% 30%, #2c3038, #131519 55%, #08090c)"],
    ["nuit", "Bleu nuit", "Le bleu des salons de Monaco", "radial-gradient(circle at 50% 30%, #2453a6, #102b60 55%, #061533)"]
  ];
  const currentTheme = () => document.documentElement.dataset.theme || "vert";
  function themeHTML() {
    return `<div class="theme-pick" role="radiogroup" aria-label="Thème de l'application">${THEME_LIST.map(([id, name, text, bg]) =>
      `<button class="theme-opt" role="radio" data-theme-set="${id}" aria-checked="${currentTheme() === id}"><span class="tp-sw" style="background:${bg}"><i></i></span><b>${name}</b><small>${text}</small></button>`).join("")}</div>`;
  }
  // any theme picker on the page switches the theme at once
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-theme-set]"); if (!b) return;
    if (window.casinoSetTheme) window.casinoSetTheme(b.dataset.themeSet);
    document.querySelectorAll("[data-theme-set]").forEach(x => x.setAttribute("aria-checked", String(x.dataset.themeSet === currentTheme())));
  });

  function openAccount() {
    if (!session) { location.href = "classement.html"; return; }
    openSheet((sheet, close) => {
      sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
        <div class="ph"><h2>Mon compte</h2><button class="x" data-close aria-label="Fermer">×</button></div>
        <div class="ps-box"><b class="ps-lab">Thème de l'application</b>${themeHTML()}</div>
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
/* poker felts: the colour of the oval table in Texas Hold'em and online poker */
.ft-vert { --ft: radial-gradient(ellipse at 50% 40%, #17785c 0%, #0f5a45 55%, #0a3f31 100%); }
.ft-bleu-nuit { --ft: radial-gradient(ellipse at 50% 40%, #2a5ea6 0%, #183f78 55%, #0b2348 100%); }
.ft-bordeaux { --ft: radial-gradient(ellipse at 50% 40%, #9a2840 0%, #6a1426 55%, #3e0914 100%); }
.ft-noir { --ft: radial-gradient(ellipse at 50% 40%, #33363b 0%, #1c1e21 55%, #0b0c0d 100%); }
.ft-violet { --ft: radial-gradient(ellipse at 50% 40%, #7447ad 0%, #4e2c7a 55%, #2c1747 100%); }
.ft-turquoise { --ft: radial-gradient(ellipse at 50% 40%, #1fb0ac 0%, #117a78 55%, #08514f 100%); }
.ft-sable { --ft: radial-gradient(ellipse at 50% 40%, #b8925c 0%, #8f6d40 55%, #5e4424 100%); }
.ft-anthracite { --ft: radial-gradient(ellipse at 50% 40%, #555a62 0%, #373b41 55%, #1f2226 100%); }
.ft-rose { --ft: radial-gradient(ellipse at 50% 40%, #cf6f97 0%, #a34d72 55%, #6b2a48 100%); }
.ft-vegas { --ft: radial-gradient(circle, rgba(255,70,210,.45) 0 1.5px, transparent 2.5px) 0 0 / 20px 20px, radial-gradient(circle, rgba(70,220,255,.35) 0 1.5px, transparent 2.5px) 10px 10px / 20px 20px, radial-gradient(ellipse at 50% 40%, #4a1478 0%, #260a42 55%, #12031f 100%); }
.ft-monaco { --ft: repeating-linear-gradient(45deg, rgba(216,178,106,.14) 0 1.5px, transparent 1.5px 18px), repeating-linear-gradient(-45deg, rgba(216,178,106,.14) 0 1.5px, transparent 1.5px 18px), radial-gradient(ellipse at 50% 40%, #0e7457 0%, #08483a 55%, #042a22 100%); }
.ft-carbone { --ft: radial-gradient(ellipse at 50% 35%, rgba(255,255,255,.12), transparent 60%), repeating-linear-gradient(45deg, #1a1c1f 0 4px, #262a2e 4px 8px); }
.ft-marbre { --ft: linear-gradient(125deg, transparent 28%, rgba(216,178,106,.55) 29%, transparent 30.5%, transparent 61%, rgba(255,255,255,.2) 62%, transparent 63%), linear-gradient(160deg, transparent 45%, rgba(216,178,106,.3) 46%, transparent 47%), radial-gradient(ellipse at 50% 40%, #2a2a2e 0%, #161618 55%, #08080a 100%); }
.ft-large { --ft: repeating-radial-gradient(ellipse at 50% 120%, rgba(255,255,255,.05) 0 3px, transparent 3px 16px), radial-gradient(ellipse at 50% 40%, #1f8ab3 0%, #0f5a7a 55%, #062c40 100%); }
.ft-voie-lactee { --ft: radial-gradient(1.2px 1.2px at 20% 30%, #fff 50%, transparent), radial-gradient(1px 1px at 70% 20%, #fff 50%, transparent), radial-gradient(1.4px 1.4px at 45% 75%, #fff 50%, transparent), radial-gradient(1px 1px at 85% 65%, #fff 50%, transparent), radial-gradient(1px 1px at 30% 60%, #fff 50%, transparent), radial-gradient(ellipse at 65% 45%, rgba(214,80,200,.45), transparent 50%), radial-gradient(ellipse at 30% 55%, rgba(80,110,255,.45), transparent 55%), #090320; }
.ft-damier { --ft: conic-gradient(rgba(0,0,0,.2) 25%, transparent 0 50%, rgba(0,0,0,.2) 0 75%, transparent 0) 0 0 / 30px 30px, radial-gradient(ellipse at 50% 40%, #17785c 0%, #0f5a45 55%, #0a3f31 100%); }
.ft-cuir { --ft: radial-gradient(circle, rgba(0,0,0,.5) 0 2px, rgba(255,255,255,.08) 3px, transparent 4px) 0 0 / 28px 28px, radial-gradient(ellipse at 50% 40%, #80502e 0%, #5a341c 55%, #36200f 100%); }
.ft-chene { --ft: radial-gradient(ellipse at 50% 35%, rgba(255,255,255,.12), transparent 60%), repeating-linear-gradient(92deg, rgba(0,0,0,.14) 0 2px, transparent 2px 11px), linear-gradient(90deg, #7a4e26, #a46e3c 50%, #7a4e26); }
.ptable .oval[class*="ft-"] { background: var(--ft); }
.felt-sw { display: grid; place-items: center; }
.sw.felt-sw { background: radial-gradient(circle at 50% 40%, #1d2c26, #07120e); }
.sw.felt-sw .mini-felt { width: auto; height: 64%; }
.mini-felt { container-type: inline-size; position: relative; width: 78%; aspect-ratio: 2 / 1.15; border-radius: 50%; background: var(--ft);
  box-shadow: 0 0 0 4px #4a2412, 0 0 0 5px #8a5a2b, 0 0 0 6px rgba(216,178,106,.5), 0 6px 14px rgba(0,0,0,.45), inset 0 0 18px rgba(0,0,0,.35); }
.mini-felt::after { content: ""; position: absolute; inset: 12%; border-radius: 50%; border: 1px solid rgba(216,178,106,.3); }
.mini-felt i { position: absolute; top: 50%; width: 13%; aspect-ratio: 5 / 7; border-radius: 2px; background: #f7f3ea; box-shadow: 0 1px 3px rgba(0,0,0,.4); transform: translate(-50%, -50%);
  font: 700 9px/1 var(--f-ui, sans-serif); font: 700 4.6cqw/1 var(--f-ui, sans-serif); font-style: normal; color: #1d1d1f; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .1em; }
.mini-felt i b { font-size: 1.15em; }
.mini-felt i.r { color: #c8283b; }
.mini-felt i:nth-child(1) { left: 36%; } .mini-felt i:nth-child(2) { left: 50%; } .mini-felt i:nth-child(3) { left: 64%; }
.felt-preview { display: grid; place-items: center; min-height: 84px; padding: 10px; border-radius: 18px; background: rgba(0,0,0,.2); border: 1px solid var(--felt-line); }
.felt-preview .mini-felt { width: min(300px, 80%); }
.guide-link { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 42px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--felt-line, rgba(216,178,106,.32)); background: rgba(216,178,106,.1); color: var(--brass, #d8b26a); font: inherit; font-size: 14px; font-weight: 700; cursor: pointer; }
.guide-link::before { content: "?"; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--brass, #d8b26a); color: #2a1f0c; font-size: 13px; flex: none; }

/* ===== item finish: the pricier the item, the more it shines ===== */
.pcard { box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 0 0 1px rgba(255,255,255,.06), 0 10px 26px rgba(0,0,0,.38); }
.pcard > .fx, .sw > .fx { position: absolute !important; inset: 0; z-index: 0 !important; pointer-events: none; border-radius: inherit; overflow: hidden; }
.pcard > .av, .pcard > .pc-who, .pcard > .pc-right, .sw > .av { position: relative; z-index: 1; }
.fx::before { content: ""; position: absolute; inset: 0; background: linear-gradient(168deg, rgba(255,255,255,.24), rgba(255,255,255,.04) 34%, transparent 46%); }
.fx.q2 { box-shadow: inset 0 0 0 1px rgba(170,215,255,.38); }
.fx.q3 { box-shadow: inset 0 0 0 1.5px rgba(205,175,255,.6), inset 0 0 22px rgba(170,120,255,.18); }
.fx.q4 { box-shadow: inset 0 0 0 1.5px rgba(255,215,106,.85), inset 0 0 0 3px rgba(120,80,10,.35), inset 0 0 26px rgba(255,200,80,.28); }
.fx.q3::after, .fx.q4::after { content: ""; position: absolute; top: -40%; bottom: -40%; width: 32%; left: -60%; transform: skewX(-20deg);
  background: linear-gradient(100deg, transparent, rgba(255,255,255,.32), transparent); animation: fx-sheen 5s ease-in-out infinite; }
.fx.q4::after { background: linear-gradient(100deg, transparent, rgba(255,238,175,.6), transparent); animation-duration: 3.4s; }
@keyframes fx-sheen { 0%, 58% { left: -60%; } 100% { left: 135%; } }
.fx b { position: absolute; width: 10px; height: 10px; background: #fff6d2; clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%);
  filter: drop-shadow(0 0 3px #ffd76a); opacity: 0; animation: fx-twinkle 2.6s ease-in-out infinite; }
.fx b:nth-child(1) { top: 16%; right: 10%; }
.fx b:nth-child(2) { top: 60%; right: 26%; width: 7px; height: 7px; animation-delay: .9s; }
.fx b:nth-child(3) { top: 28%; right: 42%; width: 8px; height: 8px; animation-delay: 1.7s; }
@keyframes fx-twinkle { 0%, 100% { opacity: 0; transform: scale(.3) rotate(0); } 45% { opacity: 1; transform: scale(1.2) rotate(45deg); } }
/* frames: a bevelled ring, a soft glow for épique, a gem on top for légendaire */
.av { box-shadow: 0 0 0 1px rgba(0,0,0,.28), 0 3px 8px rgba(0,0,0,.35); }
.av::before { -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4.5px), #000 calc(100% - 4px)); mask: radial-gradient(farthest-side, transparent calc(100% - 4.5px), #000 calc(100% - 4px)); }
.av.fq3, .av.fq4 { animation: fq-glow 2.8s ease-in-out infinite; }
.av.fq4 { --glow: rgba(255,215,106,.75); }
@keyframes fq-glow { 50% { filter: drop-shadow(0 0 6px var(--glow, rgba(210,180,255,.7))); } }
.av .gem { position: absolute; top: -7px; left: 50%; width: 9px; height: 9px; transform: translateX(-50%) rotate(45deg); border-radius: 2px; z-index: 2;
  background: linear-gradient(135deg, #ffffff, #bfe8ff 45%, #6aa8ff); box-shadow: 0 0 0 1.5px #8a6420, 0 0 8px rgba(160,210,255,.9); }
.av.lg .gem { width: 11px; height: 11px; top: -9px; }
/* titles */
.pc-title.tq1 { color: rgba(242,238,227,.85); }
.pc-title.tq3 { background: linear-gradient(90deg, #e6d8ff, #ffffff 50%, #cfe4ff); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.7)); }
.pc-title.tq3::before { content: "◆ "; font-size: .8em; }
.pc-title.tq4, .pc-title.gold { background: linear-gradient(90deg, #b8862b, #fff3c4 25%, #e9c46a 50%, #fff8dc 75%, #b8862b); background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.75)); animation: tq-shine 3.2s linear infinite; }
.pc-title.tq4::before { content: "✦ "; } .pc-title.tq4::after { content: " ✦"; }
@keyframes tq-shine { to { background-position: -200% 0; } }
/* shop and locker cards */
.item { transition: transform .15s ease, box-shadow .25s, border-color .25s; }
.item:active { transform: scale(.97); }
.item .sw { box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), 0 4px 10px rgba(0,0,0,.3); }
.item.q2 { border-color: rgba(140,200,255,.32); }
.item.q3 { border-color: rgba(195,155,255,.55); box-shadow: 0 0 16px rgba(170,110,255,.16); background: linear-gradient(160deg, rgba(170,120,255,.1), var(--glass, rgba(var(--glass-rgb, 4, 22, 17),.55)) 55%); }
.item.q4 { border-color: rgba(255,210,110,.75); box-shadow: 0 0 20px rgba(255,200,90,.22); background: linear-gradient(160deg, rgba(255,215,106,.14), var(--glass, rgba(var(--glass-rgb, 4, 22, 17),.55)) 55%); }
.item[aria-pressed="true"] { border-color: var(--brass, #d8b26a); box-shadow: 0 0 0 2px rgba(216,178,106,.45), 0 8px 22px rgba(0,0,0,.35); }
.item .st { align-self: flex-start; padding: 3px 9px; border-radius: 999px; background: rgba(0,0,0,.32); }
.item .meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.qtag { font-size: 9.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; padding: 3px 7px; border-radius: 6px; background: rgba(0,0,0,.4); white-space: nowrap; }
.qtag.q2 { color: #a8d6ff; } .qtag.q3 { color: #d6bcff; } .qtag.q4 { color: #ffd76a; box-shadow: 0 0 0 1px rgba(255,215,106,.45); }
.sw.title-sw { background: radial-gradient(ellipse at 50% 0%, var(--felt-hi, #1d5a48), var(--felt-deep, #07241c) 70%) !important; }
.sw .plate { display: flex; flex-direction: column; align-items: center; gap: 3px; max-width: 92%; padding: 6px 12px; border-radius: 10px; background: linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.25)); box-shadow: inset 0 0 0 1px rgba(216,178,106,.35); text-align: center; }
.sw .plate small { font-size: 10.5px; font-weight: 700; color: #fff; opacity: .85; }
.sw .plate .pc-title { font-size: 10.5px; line-height: 1.25; letter-spacing: .08em; }
.item .sw { height: 74px !important; }
.sw .plate .pc-title.tq4::after { content: none; }
/* long titles stay on one line on player cards */
.pcard .pc-title { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.rar.count::before { content: none; }
.rar.count { font-weight: 600; opacity: .9; }
.sw.frame-sw { background: radial-gradient(circle at 50% 45%, var(--felt-hi, #1f6e57), var(--felt-deep, #062a21) 70%) !important; }
.sw.frame-sw .av { width: 40px !important; height: 40px !important; font-size: 17px !important; }
@media (prefers-reduced-motion: reduce) { .fx::after, .fx b, .av.fq3, .av.fq4, .pc-title.tq4 { animation: none !important; } }
/* ===== collection Prestige: illustrated and animated items ===== */
[class*="bn-"].sw { isolation: isolate; }
.item .sw[class*="bn-"] { justify-items: start; padding-left: 12px; }
.bn-vegas-skyline { background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 100%22 preserveAspectRatio=%22xMidYMax slice%22%3E%3Crect x=%220%22 y=%2212%22 width=%2224%22 height=%2288%22 fill=%22%230a0418%22/%3E%3Crect x=%223%22 y=%2217%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%229%22 y=%2217%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2215%22 y=%2217%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%223%22 y=%2224%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%229%22 y=%2224%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2215%22 y=%2224%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%223%22 y=%2231%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%229%22 y=%2231%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2215%22 y=%2231%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2215%22 y=%2238%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%223%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%229%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2215%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%229%22 y=%2259%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%223%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%223%22 y=%2287%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%223%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%229%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2226%22 y=%2268%22 width=%2233%22 height=%2232%22 fill=%22%230a0418%22/%3E%3Crect x=%2229%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2235%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2241%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2247%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2253%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2241%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2247%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2229%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2235%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2253%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2261%22 y=%2212%22 width=%2214%22 height=%2288%22 fill=%22%230a0418%22/%3E%3Crect x=%2270%22 y=%2217%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2270%22 y=%2224%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2264%22 y=%2231%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2270%22 y=%2231%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2264%22 y=%2238%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2270%22 y=%2238%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2270%22 y=%2252%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2264%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2270%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2264%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2270%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2270%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2264%22 y=%2287%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2270%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2275%22 y=%2215%22 width=%2228%22 height=%2285%22 fill=%22%230a0418%22/%3E%3Crect x=%2278%22 y=%2227%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2284%22 y=%2227%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2290%22 y=%2227%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2296%22 y=%2227%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2278%22 y=%2234%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2284%22 y=%2234%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2290%22 y=%2234%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2296%22 y=%2234%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2290%22 y=%2241%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2278%22 y=%2248%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2278%22 y=%2255%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2278%22 y=%2262%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2290%22 y=%2269%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2296%22 y=%2269%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2284%22 y=%2276%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2290%22 y=%2276%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%2284%22 y=%2283%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%2296%22 y=%2283%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%2290%22 y=%2290%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22104%22 y=%2220%22 width=%2221%22 height=%2280%22 fill=%22%230a0418%22/%3E%3Crect x=%22107%22 y=%2225%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22113%22 y=%2225%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22119%22 y=%2225%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22107%22 y=%2239%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22119%22 y=%2239%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22119%22 y=%2246%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22107%22 y=%2253%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22113%22 y=%2253%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22119%22 y=%2260%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22107%22 y=%2267%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22113%22 y=%2267%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22119%22 y=%2267%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22107%22 y=%2281%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22113%22 y=%2281%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22119%22 y=%2281%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22113%22 y=%2288%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22119%22 y=%2288%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22107%22 y=%2295%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22113.5%22 y=%2210%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22114.5%22 cy=%229%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3Crect x=%22128%22 y=%2263%22 width=%2225%22 height=%2237%22 fill=%22%230a0418%22/%3E%3Crect x=%22137%22 y=%2268%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22131%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22143%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22131%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22137%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22143%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22149%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22131%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22137%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22143%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22139.5%22 y=%2253%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22140.5%22 cy=%2252%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3Crect x=%22154%22 y=%2240%22 width=%2230%22 height=%2260%22 fill=%22%230a0418%22/%3E%3Crect x=%22157%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22157%22 y=%2252%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22157%22 y=%2259%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22163%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22169%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22175%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22169%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22169%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22168.0%22 y=%2230%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22169.0%22 cy=%2229%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3Crect x=%22187%22 y=%2246%22 width=%2218%22 height=%2254%22 fill=%22%230a0418%22/%3E%3Crect x=%22190%22 y=%2251%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22196%22 y=%2251%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22190%22 y=%2258%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22196%22 y=%2258%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22190%22 y=%2272%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22190%22 y=%2279%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22196%22 y=%2286%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22190%22 y=%2293%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22196%22 y=%2293%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22206%22 y=%2240%22 width=%2227%22 height=%2260%22 fill=%22%230a0418%22/%3E%3Crect x=%22209%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22215%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22221%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22227%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22221%22 y=%2252%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22215%22 y=%2259%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22227%22 y=%2259%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22209%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22215%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22221%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22221%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22209%22 y=%2287%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22215%22 y=%2287%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22209%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22215%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22227%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22235%22 y=%2264%22 width=%2233%22 height=%2236%22 fill=%22%230a0418%22/%3E%3Crect x=%22238%22 y=%2269%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22244%22 y=%2269%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22256%22 y=%2269%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22262%22 y=%2269%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22250%22 y=%2276%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22262%22 y=%2276%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22250%22 y=%2283%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22238%22 y=%2290%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22244%22 y=%2290%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22250%22 y=%2290%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22256%22 y=%2290%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22270%22 y=%2258%22 width=%2220%22 height=%2242%22 fill=%22%230a0418%22/%3E%3Crect x=%22273%22 y=%2263%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22285%22 y=%2263%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22285%22 y=%2270%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22279%22 y=%2277%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22285%22 y=%2277%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22273%22 y=%2291%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22285%22 y=%2291%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22279.0%22 y=%2248%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22280.0%22 cy=%2247%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3Crect x=%22293%22 y=%2256%22 width=%2214%22 height=%2244%22 fill=%22%230a0418%22/%3E%3Crect x=%22296%22 y=%2261%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22302%22 y=%2268%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22296%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22302%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22296%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22296%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22296%22 y=%2296%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22302%22 y=%2296%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22299.0%22 y=%2246%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22300.0%22 cy=%2245%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3Crect x=%22307%22 y=%2253%22 width=%2223%22 height=%2247%22 fill=%22%230a0418%22/%3E%3Crect x=%22316%22 y=%2258%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22310%22 y=%2265%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22310%22 y=%2279%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22322%22 y=%2279%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22316%22 y=%2293%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22330%22 y=%2221%22 width=%2232%22 height=%2279%22 fill=%22%230a0418%22/%3E%3Crect x=%22351%22 y=%2226%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22357%22 y=%2226%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22333%22 y=%2233%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22339%22 y=%2233%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22345%22 y=%2240%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22345%22 y=%2247%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22339%22 y=%2254%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22345%22 y=%2254%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22333%22 y=%2261%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22345%22 y=%2261%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22333%22 y=%2268%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22339%22 y=%2268%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22351%22 y=%2268%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22357%22 y=%2268%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22333%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22345%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22357%22 y=%2275%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22333%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22345%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22351%22 y=%2282%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22333%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22339%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22351%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22357%22 y=%2289%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22333%22 y=%2296%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22339%22 y=%2296%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22345%22 y=%2296%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22351%22 y=%2296%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22364%22 y=%2241%22 width=%2221%22 height=%2259%22 fill=%22%230a0418%22/%3E%3Crect x=%22379%22 y=%2246%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22379%22 y=%2253%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22367%22 y=%2260%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22373%22 y=%2260%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22367%22 y=%2267%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22379%22 y=%2267%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22379%22 y=%2274%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22367%22 y=%2281%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22367%22 y=%2288%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22367%22 y=%2295%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22379%22 y=%2295%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22373.5%22 y=%2231%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22374.5%22 cy=%2230%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3Crect x=%22387%22 y=%2240%22 width=%2227%22 height=%2260%22 fill=%22%230a0418%22/%3E%3Crect x=%22390%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22402%22 y=%2245%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22396%22 y=%2259%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22402%22 y=%2259%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22396%22 y=%2266%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22390%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22396%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22402%22 y=%2273%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22390%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22396%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22408%22 y=%2280%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22396%22 y=%2287%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.95%22/%3E%3Crect x=%22390%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.75%22/%3E%3Crect x=%22402%22 y=%2294%22 width=%222.6%22 height=%223.2%22 fill=%22%23ffd76a%22 opacity=%220.5%22/%3E%3Crect x=%22399.5%22 y=%2230%22 width=%222%22 height=%2210%22 fill=%22%230a0418%22/%3E%3Ccircle cx=%22400.5%22 cy=%2229%22 r=%221.6%22 fill=%22%23ff3d6e%22/%3E%3C/svg%3E") center bottom / 100% 100% no-repeat, radial-gradient(ellipse at 75% 105%, rgba(255,61,139,.75), transparent 55%), linear-gradient(180deg, #0c0124, #2a0a52 55%, #6a1466); }
.bn-vegas-skyline::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: radial-gradient(circle at 82% 30%, rgba(255,90,200,.55), transparent 30%), radial-gradient(circle at 60% 45%, rgba(90,210,255,.4), transparent 26%); animation: pv-neon 3.2s ease-in-out infinite; }
.bn-pluie-cartes { background: radial-gradient(ellipse at 50% 120%, rgba(216,178,106,.25), transparent 60%), linear-gradient(160deg, #0b3d30, #062a21); }
.bn-pluie-cartes::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 120 120%22 %3E%3Cg transform=%22translate(22 24) rotate(-18)%22%3E%3Crect x=%22-9%22 y=%22-12.5%22 width=%2218%22 height=%2225%22 rx=%222.5%22 fill=%22%23fbf8f1%22 stroke=%22%23d8b26a%22 stroke-width=%22.6%22/%3E%3Ctext x=%220%22 y=%224.5%22 font-size=%2213%22 text-anchor=%22middle%22 fill=%22%2317191d%22 font-family=%22Georgia%22%3E%E2%99%A0%3C/text%3E%3C/g%3E%3Cg transform=%22translate(80 40) rotate(22)%22%3E%3Crect x=%22-9%22 y=%22-12.5%22 width=%2218%22 height=%2225%22 rx=%222.5%22 fill=%22%23fbf8f1%22 stroke=%22%23d8b26a%22 stroke-width=%22.6%22/%3E%3Ctext x=%220%22 y=%224.5%22 font-size=%2213%22 text-anchor=%22middle%22 fill=%22%23c8283b%22 font-family=%22Georgia%22%3E%E2%99%A5%3C/text%3E%3C/g%3E%3Cg transform=%22translate(46 92) rotate(8)%22%3E%3Crect x=%22-9%22 y=%22-12.5%22 width=%2218%22 height=%2225%22 rx=%222.5%22 fill=%22%23fbf8f1%22 stroke=%22%23d8b26a%22 stroke-width=%22.6%22/%3E%3Ctext x=%220%22 y=%224.5%22 font-size=%2213%22 text-anchor=%22middle%22 fill=%22%23c8283b%22 font-family=%22Georgia%22%3E%E2%99%A6%3C/text%3E%3C/g%3E%3Cg transform=%22translate(104 100) rotate(-30)%22%3E%3Crect x=%22-9%22 y=%22-12.5%22 width=%2218%22 height=%2225%22 rx=%222.5%22 fill=%22%23fbf8f1%22 stroke=%22%23d8b26a%22 stroke-width=%22.6%22/%3E%3Ctext x=%220%22 y=%224.5%22 font-size=%2213%22 text-anchor=%22middle%22 fill=%22%2317191d%22 font-family=%22Georgia%22%3E%E2%99%A3%3C/text%3E%3C/g%3E%3C/svg%3E") 0 0 / 96px 96px; opacity: .9; animation: pv-fall 7s linear infinite; }
.bn-roulette-live { background: radial-gradient(ellipse at 85% 50%, rgba(216,178,106,.35), transparent 45%), linear-gradient(135deg, #0b0b10, #1d1408 60%, #2e1d08); }
.bn-roulette-live::before { content: ""; position: absolute; pointer-events: none; z-index: -1; height: 170%; aspect-ratio: 1; right: -12%; top: -35%; border-radius: 50%; background: radial-gradient(circle, #e9c46a 0 9%, #5a3a12 9.5% 16%, transparent 16.5%), radial-gradient(circle, transparent 0 62%, #8a5a2b 62.5% 70%, #e9c46a 70.5% 72%, transparent 72.5%), repeating-conic-gradient(#b3262f 0 9.73deg, #121212 9.73deg 19.46deg); box-shadow: 0 0 30px rgba(0,0,0,.6); animation: pv-spin 9s linear infinite; }
.bn-aurore-vivante { background: linear-gradient(180deg, #02101e, #05263c 70%, #0a3a4a); }
.bn-aurore-vivante::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: -20%; background: radial-gradient(ellipse 30% 70% at 30% 30%, rgba(60,255,170,.9), transparent 70%), radial-gradient(ellipse 25% 80% at 55% 20%, rgba(170,100,255,.85), transparent 70%), radial-gradient(ellipse 30% 70% at 82% 35%, rgba(60,220,255,.85), transparent 70%); background-size: 160% 160%; filter: blur(5px); animation: pv-drift 9s ease-in-out infinite alternate; }
.bn-dragon-imperial { background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 50%22 %3E%3Cpath d=%22M10 40a10 10 0 0 1 20 0a8 8 0 0 1 16 0%22 fill=%22none%22 stroke=%22%23e9c46a%22 stroke-width=%221.6%22 opacity=%22.35%22/%3E%3Cpath d=%22M50 15a8 8 0 0 1 16 0a6 6 0 0 1 12 0%22 fill=%22none%22 stroke=%22%23e9c46a%22 stroke-width=%221.4%22 opacity=%22.3%22/%3E%3C/svg%3E") 0 0 / 80px 50px, radial-gradient(ellipse at 85% 50%, rgba(255,190,60,.35), transparent 50%), linear-gradient(135deg, #3a0306, #8f0d16 55%, #5a0409); }
.bn-dragon-imperial::before { content: ""; position: absolute; pointer-events: none; z-index: -1; height: 120%; aspect-ratio: 1; right: 2%; top: -10%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Ctext x=%2250%22 y=%2276%22 text-anchor=%22middle%22 font-size=%2278%22 font-family=%22serif%22 fill=%22%23ffd76a%22 opacity=%221%22%3E%E9%BE%8D%3C/text%3E%3C/svg%3E") center / contain no-repeat; filter: drop-shadow(0 0 8px rgba(255,200,80,.8)); animation: pv-glow 3.5s ease-in-out infinite; }
.bn-monte-carlo { background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 100%22 preserveAspectRatio=%22xMidYMax slice%22%3E%3Crect x=%220%22 y=%2278%22 width=%22400%22 height=%2222%22 fill=%22%230b2a4a%22/%3E%3Cpath d=%22M150 78V52h100v26z%22 fill=%22%231a0f22%22/%3E%3Cpath d=%22M178 52a22 22 0 0 1 44 0z%22 fill=%22%231a0f22%22/%3E%3Crect x=%22198%22 y=%2222%22 width=%224%22 height=%2210%22 fill=%22%231a0f22%22/%3E%3Cpath d=%22M130 78V44h18v34zM252 78V44h18v34z%22 fill=%22%231a0f22%22/%3E%3Cpath d=%22M130 44l9-12 9 12zM252 44l9-12 9 12z%22 fill=%22%231a0f22%22/%3E%3Crect x=%22156%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22168%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22180%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22192%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22204%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22216%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22228%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22240%22 y=%2260%22 width=%226%22 height=%2210%22 rx=%223%22 fill=%22%23ffcf6a%22 opacity=%22.85%22/%3E%3Crect x=%22135%22 y=%2252%22 width=%228%22 height=%228%22 rx=%224%22 fill=%22%23ffcf6a%22 opacity=%22.8%22/%3E%3Crect x=%22257%22 y=%2252%22 width=%228%22 height=%228%22 rx=%224%22 fill=%22%23ffcf6a%22 opacity=%22.8%22/%3E%3Crect x=%22175%22 y=%2290%22 width=%227%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22163%22 y=%2285%22 width=%2211%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22132%22 y=%2294%22 width=%2215%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22103%22 y=%2296%22 width=%226%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22383%22 y=%2295%22 width=%2212%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22196%22 y=%2288%22 width=%2217%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22268%22 y=%2285%22 width=%2212%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22138%22 y=%2287%22 width=%2218%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%2231%22 y=%2289%22 width=%2210%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22294%22 y=%2287%22 width=%228%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22351%22 y=%2290%22 width=%2214%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22322%22 y=%2294%22 width=%229%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%2247%22 y=%2286%22 width=%229%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3Crect x=%22196%22 y=%2288%22 width=%2216%22 height=%221%22 fill=%22%23ffd9a0%22 opacity=%22.45%22/%3E%3C/svg%3E") center bottom / 100% 100% no-repeat, linear-gradient(180deg, #1a0b3a, #6a2a6a 45%, #ff8a4a 78%, #0b2a4a 79%); }
.bn-monte-carlo::before { content: ""; position: absolute; pointer-events: none; z-index: -1; left: 0; right: 0; bottom: 0; height: 22%; background: repeating-linear-gradient(90deg, transparent 0 22px, rgba(255,217,160,.35) 22px 34px, transparent 34px 60px); animation: pv-shimmer 4s linear infinite; }
.bn-orage-electrique { background: radial-gradient(ellipse at 30% 10%, rgba(140,150,180,.5), transparent 50%), radial-gradient(ellipse at 80% 0%, rgba(100,110,140,.45), transparent 45%), linear-gradient(180deg, #11131c, #262b3d); }
.bn-orage-electrique::before { content: ""; position: absolute; pointer-events: none; z-index: -1; height: 120%; aspect-ratio: .7; right: 14%; top: -10%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cpath d=%22M58 0 40 46h14L36 100 70 38H55L68 0z%22 fill=%22%23fff%22 stroke=%22%23bfe0ff%22 stroke-width=%222%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E") center / contain no-repeat; filter: drop-shadow(0 0 10px #8fc8ff) drop-shadow(0 0 22px #4a8cff); opacity: .3; animation: pv-flash 4.5s linear infinite; }
.bn-neon-777 { background: repeating-linear-gradient(0deg, transparent 0 13px, rgba(0,0,0,.35) 13px 15px), repeating-linear-gradient(90deg, transparent 0 28px, rgba(0,0,0,.25) 28px 30px), linear-gradient(135deg, #2a0f12, #40161a); }
.bn-neon-777::before { content: ""; position: absolute; pointer-events: none; z-index: -1; height: 90%; aspect-ratio: 2.5; right: 3%; top: 5%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 80%22 %3E%3Cdefs%3E%3Cfilter id=%22g%22 x=%22-30%25%22 y=%22-30%25%22 width=%22160%25%22 height=%22160%25%22%3E%3CfeGaussianBlur stdDeviation=%223%22 result=%22b%22/%3E%3CfeMerge%3E%3CfeMergeNode in=%22b%22/%3E%3CfeMergeNode in=%22b%22/%3E%3CfeMergeNode in=%22SourceGraphic%22/%3E%3C/feMerge%3E%3C/filter%3E%3C/defs%3E%3Ctext x=%22100%22 y=%2262%22 text-anchor=%22middle%22 font-family=%22Georgia%22 font-size=%2256%22 font-weight=%22bold%22 fill=%22none%22 stroke=%22%23ff3b5c%22 stroke-width=%223%22 filter=%22url(%23g)%22%3E777%3C/text%3E%3Ctext x=%22100%22 y=%2262%22 text-anchor=%22middle%22 font-family=%22Georgia%22 font-size=%2256%22 font-weight=%22bold%22 fill=%22none%22 stroke=%22%23ffd1da%22 stroke-width=%221%22%3E777%3C/text%3E%3C/svg%3E") center / contain no-repeat; animation: pv-flicker 5s linear infinite; }
.bn-tresor { background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 260 100%22 preserveAspectRatio=%22xMaxYMax meet%22%3E%3Cellipse cx=%22120%22 cy=%2292%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2290.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2287%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2285.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2282%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2280.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2277%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2275.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2272%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2270.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2267%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2265.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2262%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2260.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22120%22 cy=%2257%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22120%22 cy=%2255.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2292%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2290.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2287%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2285.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2282%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2280.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2277%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2275.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2272%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2270.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2267%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2265.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2262%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2260.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2257%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2255.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2252%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2250.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2247%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2245.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2242%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2240.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22150%22 cy=%2237%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22150%22 cy=%2235.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22180%22 cy=%2292%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22180%22 cy=%2290.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22180%22 cy=%2287%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22180%22 cy=%2285.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22180%22 cy=%2282%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22180%22 cy=%2280.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22180%22 cy=%2277%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22180%22 cy=%2275.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22180%22 cy=%2272%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22180%22 cy=%2270.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22180%22 cy=%2267%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22180%22 cy=%2265.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2292%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2290.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2287%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2285.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2282%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2280.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2277%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2275.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2272%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2270.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2267%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2265.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2262%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2260.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2257%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2255.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2252%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2250.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22205%22 cy=%2247%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22205%22 cy=%2245.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22232%22 cy=%2292%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22232%22 cy=%2290.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22232%22 cy=%2287%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22232%22 cy=%2285.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22232%22 cy=%2282%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22232%22 cy=%2280.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22232%22 cy=%2277%22 rx=%2213%22 ry=%224.4%22 fill=%22%238a6420%22/%3E%3Cellipse cx=%22232%22 cy=%2275.4%22 rx=%2213%22 ry=%224.4%22 fill=%22%23e9c46a%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22100%22 cy=%2294%22 rx=%2211%22 ry=%223.6%22 fill=%22%23d8a531%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22255%22 cy=%2295%22 rx=%2211%22 ry=%223.6%22 fill=%22%23d8a531%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3Cellipse cx=%22170%22 cy=%2296%22 rx=%2211%22 ry=%223.6%22 fill=%22%23d8a531%22 stroke=%22%23fff3c4%22 stroke-width=%22.5%22/%3E%3C/svg%3E") right bottom / auto 92% no-repeat, radial-gradient(ellipse at 80% 90%, rgba(255,200,80,.55), transparent 55%), linear-gradient(135deg, #1a0f05, #3a2408 60%, #4a2e0a); }
.bn-tresor::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: radial-gradient(circle at 78% 55%, rgba(255,236,170,.5), transparent 22%); animation: pv-glow 2.8s ease-in-out infinite; }
.bn-galaxie-spirale { background: radial-gradient(1.2px 1.2px at 12% 30%, #fff 50%, transparent), radial-gradient(1px 1px at 40% 70%, #fff 50%, transparent), radial-gradient(1px 1px at 30% 15%, #fff 50%, transparent), #05010f; }
.bn-galaxie-spirale::before { content: ""; position: absolute; pointer-events: none; z-index: -1; height: 220%; aspect-ratio: 1; right: -20%; top: -60%; border-radius: 50%; background: radial-gradient(circle, #fff 0 3%, rgba(255,220,255,.85) 7%, transparent 30%), repeating-conic-gradient(from 0deg, rgba(200,120,255,.9) 0 14deg, rgba(80,150,255,.5) 26deg, transparent 50deg 72deg); -webkit-mask: radial-gradient(circle, #000 25%, transparent 68%); mask: radial-gradient(circle, #000 25%, transparent 68%); filter: blur(1.5px); animation: pv-spin 30s linear infinite; }
.bn-feu-artifice { background: radial-gradient(1px 1px at 20% 40%, #fff 50%, transparent), linear-gradient(180deg, #050816, #121a3a 80%, #1e1a2e); }
.bn-feu-artifice::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cline x1=%2258.0%22 y1=%2250.0%22 x2=%2294.0%22 y2=%2250.0%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2257.4%22 y1=%2253.1%22 x2=%2290.7%22 y2=%2266.8%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2255.7%22 y1=%2255.7%22 x2=%2281.1%22 y2=%2281.1%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2253.1%22 y1=%2257.4%22 x2=%2266.8%22 y2=%2290.7%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2258.0%22 x2=%2250.0%22 y2=%2294.0%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2246.9%22 y1=%2257.4%22 x2=%2233.2%22 y2=%2290.7%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2244.3%22 y1=%2255.7%22 x2=%2218.9%22 y2=%2281.1%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.6%22 y1=%2253.1%22 x2=%229.3%22 y2=%2266.8%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.0%22 y1=%2250.0%22 x2=%226.0%22 y2=%2250.0%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.6%22 y1=%2246.9%22 x2=%229.3%22 y2=%2233.2%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2244.3%22 y1=%2244.3%22 x2=%2218.9%22 y2=%2218.9%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2246.9%22 y1=%2242.6%22 x2=%2233.2%22 y2=%229.3%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2242.0%22 x2=%2250.0%22 y2=%226.0%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2253.1%22 y1=%2242.6%22 x2=%2266.8%22 y2=%229.3%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2255.7%22 y1=%2244.3%22 x2=%2281.1%22 y2=%2218.9%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2257.4%22 y1=%2246.9%22 x2=%2290.7%22 y2=%2233.2%22 stroke=%22%23ffd76a%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%2296.0%22 cy=%2250.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2292.5%22 cy=%2267.6%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2282.5%22 cy=%2282.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2267.6%22 cy=%2292.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2250.0%22 cy=%2296.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2232.4%22 cy=%2292.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2217.5%22 cy=%2282.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%227.5%22 cy=%2267.6%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%224.0%22 cy=%2250.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%227.5%22 cy=%2232.4%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2217.5%22 cy=%2217.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2232.4%22 cy=%227.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2250.0%22 cy=%224.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2267.6%22 cy=%227.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2282.5%22 cy=%2217.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2292.5%22 cy=%2232.4%22 r=%222%22 fill=%22%23fff%22/%3E%3C/svg%3E") 82% 30% / auto 80% no-repeat, url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cline x1=%2258.0%22 y1=%2250.0%22 x2=%2294.0%22 y2=%2250.0%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2257.4%22 y1=%2253.1%22 x2=%2290.7%22 y2=%2266.8%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2255.7%22 y1=%2255.7%22 x2=%2281.1%22 y2=%2281.1%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2253.1%22 y1=%2257.4%22 x2=%2266.8%22 y2=%2290.7%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2258.0%22 x2=%2250.0%22 y2=%2294.0%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2246.9%22 y1=%2257.4%22 x2=%2233.2%22 y2=%2290.7%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2244.3%22 y1=%2255.7%22 x2=%2218.9%22 y2=%2281.1%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.6%22 y1=%2253.1%22 x2=%229.3%22 y2=%2266.8%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.0%22 y1=%2250.0%22 x2=%226.0%22 y2=%2250.0%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.6%22 y1=%2246.9%22 x2=%229.3%22 y2=%2233.2%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2244.3%22 y1=%2244.3%22 x2=%2218.9%22 y2=%2218.9%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2246.9%22 y1=%2242.6%22 x2=%2233.2%22 y2=%229.3%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2242.0%22 x2=%2250.0%22 y2=%226.0%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2253.1%22 y1=%2242.6%22 x2=%2266.8%22 y2=%229.3%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2255.7%22 y1=%2244.3%22 x2=%2281.1%22 y2=%2218.9%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2257.4%22 y1=%2246.9%22 x2=%2290.7%22 y2=%2233.2%22 stroke=%22%23ff5fd2%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%2296.0%22 cy=%2250.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2292.5%22 cy=%2267.6%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2282.5%22 cy=%2282.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2267.6%22 cy=%2292.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2250.0%22 cy=%2296.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2232.4%22 cy=%2292.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2217.5%22 cy=%2282.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%227.5%22 cy=%2267.6%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%224.0%22 cy=%2250.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%227.5%22 cy=%2232.4%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2217.5%22 cy=%2217.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2232.4%22 cy=%227.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2250.0%22 cy=%224.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2267.6%22 cy=%227.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2282.5%22 cy=%2217.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2292.5%22 cy=%2232.4%22 r=%222%22 fill=%22%23fff%22/%3E%3C/svg%3E") 58% 75% / auto 55% no-repeat, url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cline x1=%2258.0%22 y1=%2250.0%22 x2=%2294.0%22 y2=%2250.0%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2257.4%22 y1=%2253.1%22 x2=%2290.7%22 y2=%2266.8%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2255.7%22 y1=%2255.7%22 x2=%2281.1%22 y2=%2281.1%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2253.1%22 y1=%2257.4%22 x2=%2266.8%22 y2=%2290.7%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2258.0%22 x2=%2250.0%22 y2=%2294.0%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2246.9%22 y1=%2257.4%22 x2=%2233.2%22 y2=%2290.7%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2244.3%22 y1=%2255.7%22 x2=%2218.9%22 y2=%2281.1%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.6%22 y1=%2253.1%22 x2=%229.3%22 y2=%2266.8%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.0%22 y1=%2250.0%22 x2=%226.0%22 y2=%2250.0%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2242.6%22 y1=%2246.9%22 x2=%229.3%22 y2=%2233.2%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2244.3%22 y1=%2244.3%22 x2=%2218.9%22 y2=%2218.9%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2246.9%22 y1=%2242.6%22 x2=%2233.2%22 y2=%229.3%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2242.0%22 x2=%2250.0%22 y2=%226.0%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2253.1%22 y1=%2242.6%22 x2=%2266.8%22 y2=%229.3%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2255.7%22 y1=%2244.3%22 x2=%2281.1%22 y2=%2218.9%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2257.4%22 y1=%2246.9%22 x2=%2290.7%22 y2=%2233.2%22 stroke=%22%235fd3ff%22 stroke-width=%222.2%22 stroke-linecap=%22round%22/%3E%3Ccircle cx=%2296.0%22 cy=%2250.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2292.5%22 cy=%2267.6%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2282.5%22 cy=%2282.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2267.6%22 cy=%2292.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2250.0%22 cy=%2296.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2232.4%22 cy=%2292.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2217.5%22 cy=%2282.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%227.5%22 cy=%2267.6%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%224.0%22 cy=%2250.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%227.5%22 cy=%2232.4%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2217.5%22 cy=%2217.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2232.4%22 cy=%227.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2250.0%22 cy=%224.0%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2267.6%22 cy=%227.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2282.5%22 cy=%2217.5%22 r=%222%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2292.5%22 cy=%2232.4%22 r=%222%22 fill=%22%23fff%22/%3E%3C/svg%3E") 96% 90% / auto 45% no-repeat; animation: pv-burst 2.6s ease-out infinite; }
.bn-koi { background: radial-gradient(ellipse at 70% 40%, rgba(60,200,190,.35), transparent 55%), linear-gradient(160deg, #052a2c, #0a4a48 60%, #062e33); }
.bn-koi::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 100%22 preserveAspectRatio=%22xMidYMid slice%22%3E%3Ccircle cx=%22330%22 cy=%2220%22 r=%2214%22 fill=%22%231f7a4c%22 opacity=%22.85%22/%3E%3Cpath d=%22M330 20l14 -4.666666666666667%22 stroke=%22%230d3d26%22 stroke-width=%222%22/%3E%3Ccircle cx=%22360%22 cy=%2275%22 r=%2210%22 fill=%22%231f7a4c%22 opacity=%22.85%22/%3E%3Cpath d=%22M360 75l10 -3.3333333333333335%22 stroke=%22%230d3d26%22 stroke-width=%222%22/%3E%3Ccircle cx=%2260%22 cy=%2285%22 r=%229%22 fill=%22%231f7a4c%22 opacity=%22.85%22/%3E%3Cpath d=%22M60 85l9 -3.0%22 stroke=%22%230d3d26%22 stroke-width=%222%22/%3E%3Cg transform=%22translate(240 40) rotate(-12)%22%3E%3Cpath d=%22M-30 0c8-10 30-12 44-4 5 3 5 5 0 8-14 8-36 6-44-4z%22 fill=%22%23ff7a2a%22/%3E%3Cpath d=%22M-30 0l-14-10c3 6 3 14 0 20z%22 fill=%22%23ff7a2a%22 opacity=%22.9%22/%3E%3Ccircle cx=%22-6%22 cy=%22-3%22 r=%225%22 fill=%22%23fff%22/%3E%3Ccircle cx=%226%22 cy=%222%22 r=%223.5%22 fill=%22%23fff%22/%3E%3Ccircle cx=%2211%22 cy=%22-1.5%22 r=%221.2%22 fill=%22%23111%22/%3E%3Cpath d=%22M-4 5l-6 9 10-6z%22 fill=%22%23ff7a2a%22 opacity=%22.8%22/%3E%3C/g%3E%3Cg transform=%22translate(150 70) rotate(168)%22%3E%3Cpath d=%22M-30 0c8-10 30-12 44-4 5 3 5 5 0 8-14 8-36 6-44-4z%22 fill=%22%23fff6ea%22/%3E%3Cpath d=%22M-30 0l-14-10c3 6 3 14 0 20z%22 fill=%22%23fff6ea%22 opacity=%22.9%22/%3E%3Ccircle cx=%22-6%22 cy=%22-3%22 r=%225%22 fill=%22%23e8412a%22/%3E%3Ccircle cx=%226%22 cy=%222%22 r=%223.5%22 fill=%22%23e8412a%22/%3E%3Ccircle cx=%2211%22 cy=%22-1.5%22 r=%221.2%22 fill=%22%23111%22/%3E%3Cpath d=%22M-4 5l-6 9 10-6z%22 fill=%22%23fff6ea%22 opacity=%22.8%22/%3E%3C/g%3E%3C/svg%3E") center / cover no-repeat; animation: pv-swim 10s ease-in-out infinite alternate; }
.bn-pluie-diamants { background: radial-gradient(ellipse at 70% 30%, rgba(120,190,255,.35), transparent 55%), linear-gradient(160deg, #070a24, #1a1050 60%, #2a1060); }
.bn-pluie-diamants::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 120 120%22 %3E%3Cg transform=%22translate(20 20) scale(1.1)%22 opacity=%220.95%22%3E%3Cpath d=%22M-8 -3 -4 -8h8l4 5L0 9z%22 fill=%22%23bfe8ff%22/%3E%3Cpath d=%22M-8 -3h16L0 9z%22 fill=%22%237fc4ff%22/%3E%3Cpath d=%22M-4 -8 0 -3 4 -8%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%22.8%22/%3E%3Cpath d=%22M-8 -3 0 9 8 -3%22 fill=%22none%22 stroke=%22%23e8f8ff%22 stroke-width=%22.5%22/%3E%3C/g%3E%3Cg transform=%22translate(75 45) scale(0.8)%22 opacity=%220.8%22%3E%3Cpath d=%22M-8 -3 -4 -8h8l4 5L0 9z%22 fill=%22%23bfe8ff%22/%3E%3Cpath d=%22M-8 -3h16L0 9z%22 fill=%22%237fc4ff%22/%3E%3Cpath d=%22M-4 -8 0 -3 4 -8%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%22.8%22/%3E%3Cpath d=%22M-8 -3 0 9 8 -3%22 fill=%22none%22 stroke=%22%23e8f8ff%22 stroke-width=%22.5%22/%3E%3C/g%3E%3Cg transform=%22translate(40 80) scale(1.3)%22 opacity=%220.9%22%3E%3Cpath d=%22M-8 -3 -4 -8h8l4 5L0 9z%22 fill=%22%23bfe8ff%22/%3E%3Cpath d=%22M-8 -3h16L0 9z%22 fill=%22%237fc4ff%22/%3E%3Cpath d=%22M-4 -8 0 -3 4 -8%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%22.8%22/%3E%3Cpath d=%22M-8 -3 0 9 8 -3%22 fill=%22none%22 stroke=%22%23e8f8ff%22 stroke-width=%22.5%22/%3E%3C/g%3E%3Cg transform=%22translate(95 95) scale(0.7)%22 opacity=%220.7%22%3E%3Cpath d=%22M-8 -3 -4 -8h8l4 5L0 9z%22 fill=%22%23bfe8ff%22/%3E%3Cpath d=%22M-8 -3h16L0 9z%22 fill=%22%237fc4ff%22/%3E%3Cpath d=%22M-4 -8 0 -3 4 -8%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%22.8%22/%3E%3Cpath d=%22M-8 -3 0 9 8 -3%22 fill=%22none%22 stroke=%22%23e8f8ff%22 stroke-width=%22.5%22/%3E%3C/g%3E%3Cg transform=%22translate(10 110) scale(0.6)%22 opacity=%220.6%22%3E%3Cpath d=%22M-8 -3 -4 -8h8l4 5L0 9z%22 fill=%22%23bfe8ff%22/%3E%3Cpath d=%22M-8 -3h16L0 9z%22 fill=%22%237fc4ff%22/%3E%3Cpath d=%22M-4 -8 0 -3 4 -8%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%22.8%22/%3E%3Cpath d=%22M-8 -3 0 9 8 -3%22 fill=%22none%22 stroke=%22%23e8f8ff%22 stroke-width=%22.5%22/%3E%3C/g%3E%3C/svg%3E") 0 0 / 100px 100px; filter: drop-shadow(0 0 4px rgba(170,220,255,.8)); animation: pv-fall 9s linear infinite; }
.bn-rideau-velours { background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 100%22 preserveAspectRatio=%22none%22%3E%3CclipPath id=%22l%22%3E%3Cpath d=%22M0 0h112c-14 46-40 74-112 86z%22/%3E%3C/clipPath%3E%3CclipPath id=%22r%22%3E%3Cpath d=%22M400 0h-112c14 46 40 74 112 86z%22/%3E%3C/clipPath%3E%3Cg clip-path=%22url(%23l)%22%3E%3Crect x=%220%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%229%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%2218%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%2227%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%2236%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%2245%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%2254%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%2263%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%2272%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%2281%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%2290%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%2299%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3C/g%3E%3Cg clip-path=%22url(%23r)%22%3E%3Crect x=%22292%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%22301%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%22310%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%22319%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%22328%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%22337%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%22346%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%22355%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%22364%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%22373%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3Crect x=%22382%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%23c41e34%22/%3E%3Crect x=%22391%22 y=%220%22 width=%229%22 height=%22100%22 fill=%22%238a0c18%22/%3E%3C/g%3E%3Crect x=%220%22 y=%220%22 width=%22400%22 height=%2210%22 fill=%22%23d8b26a%22/%3E%3Cpath d=%22M0 10h400%22 stroke=%22%238a6420%22 stroke-width=%222%22/%3E%3Ccircle cx=%2270%22 cy=%2270%22 r=%225%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%22330%22 cy=%2270%22 r=%225%22 fill=%22%23e9c46a%22/%3E%3C/svg%3E") center / 100% 100% no-repeat, radial-gradient(ellipse at 50% 100%, #3a1a0a, #120604); }
.bn-rideau-velours::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: 0; background: radial-gradient(ellipse 22% 80% at 50% 30%, rgba(255,240,200,.45), transparent 70%); animation: pv-spot 6s ease-in-out infinite alternate; }
.bn-route-synthwave { background: radial-gradient(circle at 80% 58%, #ffe14d 0 13%, #ff5f8f 22%, transparent 23%), linear-gradient(180deg, #12002a 0, #3d0b6b 45%, #ff3d8b 56%, #12002a 57%); }
.bn-route-synthwave::before { content: ""; position: absolute; pointer-events: none; z-index: -1; left: -30%; right: -30%; bottom: -10%; height: 55%; background: repeating-linear-gradient(0deg, rgba(255,60,200,.85) 0 2px, transparent 2px 16px), repeating-linear-gradient(90deg, rgba(255,60,200,.75) 0 2px, transparent 2px 34px); transform: perspective(80px) rotateX(40deg); transform-origin: top; animation: pv-road 1.6s linear infinite; }
.bn-feu-sacre { background: linear-gradient(180deg, #0a0202, #3a0805 60%, #8a1a05); }
.bn-feu-sacre::before { content: ""; position: absolute; pointer-events: none; z-index: -1; inset: -30% 0 0; background: radial-gradient(ellipse 18% 85% at 65% 100%, #ffe36a, rgba(255,120,0,.8) 40%, transparent 70%), radial-gradient(ellipse 14% 95% at 80% 100%, #fff1a0, rgba(255,80,0,.75) 45%, transparent 70%), radial-gradient(ellipse 16% 80% at 92% 100%, #ffcf4a, rgba(255,60,0,.7) 45%, transparent 70%); filter: blur(2px); transform-origin: bottom; animation: pv-flame .9s ease-in-out infinite alternate; }
.fr-laurier::before { background: linear-gradient(135deg, #fff3c4, #c99a3a 50%, #8a6420); }
.fr-laurier::after { content: ""; position: absolute; inset: -11px; border-radius: 50%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2241%22 fill=%22none%22 stroke=%22%23a8823e%22 stroke-width=%221.2%22/%3E%3Cellipse cx=%2257.6%22 cy=%2293.3%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(135 57.6 93.3)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2270.0%22 cy=%2289.2%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(118 70.0 89.2)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2280.6%22 cy=%2281.7%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(101 80.6 81.7)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2288.5%22 cy=%2271.3%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(84 88.5 71.3)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2293.0%22 cy=%2259.1%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(67 93.0 59.1)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2293.8%22 cy=%2246.2%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(50 93.8 46.2)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2290.8%22 cy=%2233.5%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(33 90.8 33.5)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2284.2%22 cy=%2222.3%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(16 84.2 22.3)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2274.6%22 cy=%2213.5%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(-1 74.6 13.5)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2242.4%22 cy=%2293.3%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(225 42.4 93.3)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2230.0%22 cy=%2289.2%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(242 30.0 89.2)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2219.4%22 cy=%2281.7%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(259 19.4 81.7)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2211.5%22 cy=%2271.3%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(276 11.5 71.3)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%227.0%22 cy=%2259.1%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(293 7.0 59.1)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%226.2%22 cy=%2246.2%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(310 6.2 46.2)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%229.2%22 cy=%2233.5%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(327 9.2 33.5)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2215.8%22 cy=%2222.3%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(344 15.8 22.3)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Cellipse cx=%2225.4%22 cy=%2213.5%22 rx=%226%22 ry=%222.6%22 transform=%22rotate(361 25.4 13.5)%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3Ccircle cx=%2250%22 cy=%2294%22 r=%223%22 fill=%22%23e9c46a%22 stroke=%22%238a6420%22 stroke-width=%22.6%22/%3E%3C/svg%3E") center / contain no-repeat; pointer-events: none; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
.fr-orbite-as::before { background: linear-gradient(135deg, #e6e9ee, #6b7380 55%, #2a2f38); }
.fr-orbite-as::after { content: ""; position: absolute; inset: -12px; border-radius: 50%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Ctext x=%2250%22 y=%229%22 text-anchor=%22middle%22 font-size=%2216%22 font-family=%22Georgia%22 fill=%22%23f2eee3%22 stroke=%22%23000%22 stroke-width=%22.6%22%3E%E2%99%A0%3C/text%3E%3Ctext x=%2291%22 y=%2254%22 text-anchor=%22middle%22 font-size=%2216%22 font-family=%22Georgia%22 fill=%22%23ff4d6a%22 stroke=%22%23000%22 stroke-width=%22.6%22%3E%E2%99%A5%3C/text%3E%3Ctext x=%2250%22 y=%2297%22 text-anchor=%22middle%22 font-size=%2216%22 font-family=%22Georgia%22 fill=%22%23f2eee3%22 stroke=%22%23000%22 stroke-width=%22.6%22%3E%E2%99%A3%3C/text%3E%3Ctext x=%229%22 y=%2254%22 text-anchor=%22middle%22 font-size=%2216%22 font-family=%22Georgia%22 fill=%22%23ff4d6a%22 stroke=%22%23000%22 stroke-width=%22.6%22%3E%E2%99%A6%3C/text%3E%3C/svg%3E") center / contain no-repeat; pointer-events: none; animation: spin 9s linear infinite; }
.fr-anneau-feu::before { background: conic-gradient(#ff2a00, #ffb300, #ff5a00, #ffe36a, #ff2a00); animation: spin 1.2s linear infinite; }
.fr-anneau-feu::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; pointer-events: none; background: radial-gradient(circle, transparent 58%, rgba(255,120,0,.55) 64%, transparent 74%); animation: pv-flame .5s ease-in-out infinite alternate; }
.fr-givre::before { background: linear-gradient(135deg, #ffffff, #9fdcff 50%, #3a8ad8); }
.fr-givre::after { content: ""; position: absolute; inset: -10px; border-radius: 50%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cg transform=%22translate(50 6) scale(1)%22 stroke=%22%23e8fbff%22 stroke-width=%221.3%22 stroke-linecap=%22round%22%3E%3Cline x1=%220%22 y1=%220%22 x2=%226.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-6.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%22-5.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%22-5.2%22/%3E%3C/g%3E%3Cg transform=%22translate(88 34) scale(0.7)%22 stroke=%22%23e8fbff%22 stroke-width=%221.3%22 stroke-linecap=%22round%22%3E%3Cline x1=%220%22 y1=%220%22 x2=%226.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-6.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%22-5.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%22-5.2%22/%3E%3C/g%3E%3Cg transform=%22translate(80 84) scale(0.85)%22 stroke=%22%23e8fbff%22 stroke-width=%221.3%22 stroke-linecap=%22round%22%3E%3Cline x1=%220%22 y1=%220%22 x2=%226.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-6.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%22-5.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%22-5.2%22/%3E%3C/g%3E%3Cg transform=%22translate(18 80) scale(0.7)%22 stroke=%22%23e8fbff%22 stroke-width=%221.3%22 stroke-linecap=%22round%22%3E%3Cline x1=%220%22 y1=%220%22 x2=%226.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-6.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%22-5.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%22-5.2%22/%3E%3C/g%3E%3Cg transform=%22translate(10 30) scale(0.9)%22 stroke=%22%23e8fbff%22 stroke-width=%221.3%22 stroke-linecap=%22round%22%3E%3Cline x1=%220%22 y1=%220%22 x2=%226.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%225.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-6.0%22 y2=%220.0%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%22-3.0%22 y2=%22-5.2%22/%3E%3Cline x1=%220%22 y1=%220%22 x2=%223.0%22 y2=%22-5.2%22/%3E%3C/g%3E%3C/svg%3E") center / contain no-repeat; pointer-events: none; filter: drop-shadow(0 0 3px #bfe8ff); animation: pv-glow 3s ease-in-out infinite; }
.fr-neon-pulse::before { background: linear-gradient(135deg, #ff4fd8, #7a5cff); animation: pv-hue 5s linear infinite; filter: drop-shadow(0 0 4px #ff4fd8); }
.fr-serti-rubis::before { background: linear-gradient(135deg, #fff3c4, #d8a531 50%, #8a6420); }
.fr-serti-rubis::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Ccircle cx=%2250.0%22 cy=%225.0%22 r=%225.2%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%2250.0%22 cy=%225.0%22 r=%223.8%22 fill=%22%23c8102e%22/%3E%3Ccircle cx=%2248.8%22 cy=%223.7%22 r=%221.2%22 fill=%22%23ffd1da%22/%3E%3Ccircle cx=%2289.0%22 cy=%2227.5%22 r=%225.2%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%2289.0%22 cy=%2227.5%22 r=%223.8%22 fill=%22%23c8102e%22/%3E%3Ccircle cx=%2287.8%22 cy=%2226.2%22 r=%221.2%22 fill=%22%23ffd1da%22/%3E%3Ccircle cx=%2289.0%22 cy=%2272.5%22 r=%225.2%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%2289.0%22 cy=%2272.5%22 r=%223.8%22 fill=%22%23c8102e%22/%3E%3Ccircle cx=%2287.8%22 cy=%2271.2%22 r=%221.2%22 fill=%22%23ffd1da%22/%3E%3Ccircle cx=%2250.0%22 cy=%2295.0%22 r=%225.2%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%2250.0%22 cy=%2295.0%22 r=%223.8%22 fill=%22%23c8102e%22/%3E%3Ccircle cx=%2248.8%22 cy=%2293.7%22 r=%221.2%22 fill=%22%23ffd1da%22/%3E%3Ccircle cx=%2211.0%22 cy=%2272.5%22 r=%225.2%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%2211.0%22 cy=%2272.5%22 r=%223.8%22 fill=%22%23c8102e%22/%3E%3Ccircle cx=%229.8%22 cy=%2271.2%22 r=%221.2%22 fill=%22%23ffd1da%22/%3E%3Ccircle cx=%2211.0%22 cy=%2227.5%22 r=%225.2%22 fill=%22%23e9c46a%22/%3E%3Ccircle cx=%2211.0%22 cy=%2227.5%22 r=%223.8%22 fill=%22%23c8102e%22/%3E%3Ccircle cx=%229.8%22 cy=%2226.2%22 r=%221.2%22 fill=%22%23ffd1da%22/%3E%3C/svg%3E") center / contain no-repeat; pointer-events: none; }
.fr-halo-celeste::before { background: linear-gradient(135deg, #ffffff, #fff3c4 50%, #e9c46a); }
.fr-halo-celeste::after { content: ""; position: absolute; inset: -12px; border-radius: 50%; background: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cline x1=%2292.0%22 y1=%2250.0%22 x2=%2297.0%22 y2=%2250.0%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2290.6%22 y1=%2260.9%22 x2=%2297.3%22 y2=%2262.7%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2286.4%22 y1=%2271.0%22 x2=%2290.7%22 y2=%2273.5%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2279.7%22 y1=%2279.7%22 x2=%2284.6%22 y2=%2284.6%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2271.0%22 y1=%2286.4%22 x2=%2273.5%22 y2=%2290.7%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2260.9%22 y1=%2290.6%22 x2=%2262.7%22 y2=%2297.3%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%2292.0%22 x2=%2250.0%22 y2=%2297.0%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2239.1%22 y1=%2290.6%22 x2=%2237.3%22 y2=%2297.3%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2229.0%22 y1=%2286.4%22 x2=%2226.5%22 y2=%2290.7%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2220.3%22 y1=%2279.7%22 x2=%2215.4%22 y2=%2284.6%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2213.6%22 y1=%2271.0%22 x2=%229.3%22 y2=%2273.5%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%229.4%22 y1=%2260.9%22 x2=%222.7%22 y2=%2262.7%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%228.0%22 y1=%2250.0%22 x2=%223.0%22 y2=%2250.0%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%229.4%22 y1=%2239.1%22 x2=%222.7%22 y2=%2237.3%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2213.6%22 y1=%2229.0%22 x2=%229.3%22 y2=%2226.5%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2220.3%22 y1=%2220.3%22 x2=%2215.4%22 y2=%2215.4%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2229.0%22 y1=%2213.6%22 x2=%2226.5%22 y2=%229.3%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2239.1%22 y1=%229.4%22 x2=%2237.3%22 y2=%222.7%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2250.0%22 y1=%228.0%22 x2=%2250.0%22 y2=%223.0%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2260.9%22 y1=%229.4%22 x2=%2262.7%22 y2=%222.7%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2271.0%22 y1=%2213.6%22 x2=%2273.5%22 y2=%229.3%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2279.7%22 y1=%2220.3%22 x2=%2284.6%22 y2=%2215.4%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2286.4%22 y1=%2229.0%22 x2=%2290.7%22 y2=%2226.5%22 stroke=%22%23fff3c4%22 stroke-width=%221%22 stroke-linecap=%22round%22/%3E%3Cline x1=%2290.6%22 y1=%2239.1%22 x2=%2297.3%22 y2=%2237.3%22 stroke=%22%23fff3c4%22 stroke-width=%221.6%22 stroke-linecap=%22round%22/%3E%3C/svg%3E") center / contain no-repeat; pointer-events: none; filter: drop-shadow(0 0 4px #ffe9a6); animation: spin 14s linear infinite; }
.fr-anneau-jetons::before { background: repeating-conic-gradient(#b3262f 0 15deg, #f7f3ea 15deg 30deg); animation: spin 6s linear infinite; }
.av.fr-anneau-feu { --glow: rgba(255,120,0,.9); } .av.fr-givre { --glow: rgba(170,225,255,.9); } .av.fr-neon-pulse { --glow: rgba(255,80,220,.9); }
.pc-title.tt-jackpot { background: linear-gradient(90deg, #ff3b5c, #ffd76a 30%, #fff8dc 50%, #ffd76a 70%, #ff3b5c); background-size: 200% 100%; animation: tq-shine 1.8s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-jackpot::before { content: "★ "; } .pc-title.tt-jackpot::after { content: " ★"; }
.pc-title.tt-main-du-diable { background: linear-gradient(0deg, #ff2a00, #ffb300 40%, #fff1a0 55%, #ff5a00 75%, #ff2a00); background-size: 100% 200%; animation: pv-firetext 1.4s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-main-du-diable::before { content: "✶ "; } .pc-title.tt-main-du-diable::after { content: " ✶"; }
.pc-title.tt-coeur-de-glace { background: linear-gradient(90deg, #7fd3ff, #ffffff 30%, #bfe8ff 50%, #ffffff 70%, #7fd3ff); background-size: 200% 100%; animation: tq-shine 3s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-coeur-de-glace::before { content: "❄ "; } .pc-title.tt-coeur-de-glace::after { content: " ❄"; }
.pc-title.tt-oiseau-de-nuit { background: none; color: #ffe0f6; -webkit-text-fill-color: #ffe0f6; filter: none; text-shadow: 0 0 3px #ff5fd2, 0 0 8px #ff2fb9, 0 0 14px #ff2fb9; animation: pv-neontext 4s linear infinite; }
.pc-title.tt-oiseau-de-nuit::before { content: ""; } .pc-title.tt-oiseau-de-nuit::after { content: ""; }
.pc-title.tt-le-magnat { background: linear-gradient(90deg, #ff6ad5, #c774e8, #ad8cff, #8795e8, #94d0ff, #7cffcb, #fff38c, #ff6ad5); background-size: 300% 100%; animation: tq-shine 4s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-le-magnat::before { content: "◈ "; } .pc-title.tt-le-magnat::after { content: " ◈"; }
.pc-title.tt-hors-systeme { background: none; color: #ffffff; -webkit-text-fill-color: #ffffff; filter: none; text-shadow: -1.5px 0 #ff2a6d, 1.5px 0 #05d9e8; animation: pv-glitch 2.4s steps(1) infinite; }
.pc-title.tt-hors-systeme::before { content: ""; } .pc-title.tt-hors-systeme::after { content: ""; }
.pc-title.tt-empereur { background: linear-gradient(90deg, #8a6420, #fff3c4 20%, #e9c46a 40%, #fffaf0 55%, #d8a531 75%, #8a6420); background-size: 250% 100%; animation: tq-shine 2.6s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-empereur::before { content: "♛ "; } .pc-title.tt-empereur::after { content: " ♛"; }
.pc-title.tt-intouchable { background: none; color: #e6f3ff; -webkit-text-fill-color: #e6f3ff; filter: none; text-shadow: 0 0 4px #5fb4ff, 0 0 10px #2f7bff; animation: pv-electric 1.8s ease-in-out infinite; }
.pc-title.tt-intouchable::before { content: ""; } .pc-title.tt-intouchable::after { content: ""; }
.pc-title.tt-maitre-du-temps { background: linear-gradient(90deg, #9aa3ad, #ffffff 40%, #c9cfd6 60%, #9aa3ad); background-size: 200% 100%; animation: tq-shine 5s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-maitre-du-temps::before { content: "◷ "; } .pc-title.tt-maitre-du-temps::after { content: ""; }
.pc-title.tt-ame-de-dragon { background: linear-gradient(90deg, #c8102e, #ffb300 35%, #fff1a0 50%, #ffb300 65%, #c8102e); background-size: 200% 100%; animation: tq-shine 2.2s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-ame-de-dragon::before { content: "龍 "; } .pc-title.tt-ame-de-dragon::after { content: ""; }
.pc-title.tt-etoile-filante { background: linear-gradient(90deg, #fff, #fff3c4 40%, #ffffff 55%, #e9c46a 80%, #fff); background-size: 200% 100%; animation: tq-shine 2s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-etoile-filante::before { content: "★ "; } .pc-title.tt-etoile-filante::after { content: ""; }
.pc-title.tt-millionnaire { background: linear-gradient(90deg, #1f8a4c, #b8f5a0 30%, #ffd76a 50%, #b8f5a0 70%, #1f8a4c); background-size: 200% 100%; animation: tq-shine 2.8s linear infinite; -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; }
.pc-title.tt-millionnaire::before { content: "€ "; } .pc-title.tt-millionnaire::after { content: " €"; }
.ft-royal { --ft: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cpath d=%22M20 70 14 34l20 16 16-26 16 26 20-16-6 36z%22 fill=%22none%22 stroke=%22%23e9c46a%22 stroke-width=%222.4%22 stroke-linejoin=%22round%22 opacity=%22.55%22/%3E%3Cpath d=%22M20 78h60%22 stroke=%22%23e9c46a%22 stroke-width=%222.4%22 opacity=%22.55%22/%3E%3C/svg%3E") center / 30% auto no-repeat, repeating-linear-gradient(45deg, rgba(216,178,106,.08) 0 1px, transparent 1px 14px), repeating-linear-gradient(-45deg, rgba(216,178,106,.08) 0 1px, transparent 1px 14px), radial-gradient(ellipse at 50% 40%, #13805f, #0a5440 55%, #04301f); }
.ft-cyber { --ft: radial-gradient(ellipse at 50% 50%, rgba(255,60,200,.35), transparent 60%), url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22 %3E%3Cpath d=%22M0 0h40v40%22 fill=%22none%22 stroke=%22%232de2ff%22 stroke-width=%22.8%22 opacity=%22.55%22/%3E%3C/svg%3E") 0 0 / 26px 26px, radial-gradient(ellipse at 50% 40%, #121a3a, #0a0e24 60%, #04050f); }
.ft-dragon { --ft: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Ctext x=%2250%22 y=%2276%22 text-anchor=%22middle%22 font-size=%2278%22 font-family=%22serif%22 fill=%22%23ffd76a%22 opacity=%220.16%22%3E%E9%BE%8D%3C/text%3E%3C/svg%3E") center / 42% auto no-repeat, radial-gradient(ellipse at 50% 40%, #b0141f, #7a0a12 55%, #3e0408); }
.ft-monte-carlo { --ft: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22 %3E%3Cpath d=%22M20 6c4 6 4 12 0 18-4-6-4-12 0-18zM20 24c-6-6-14-4-14 2 6 0 10 2 14-2zM20 24c6-6 14-4 14 2-6 0-10 2-14-2zM14 28h12%22 fill=%22none%22 stroke=%22%23e9c46a%22 stroke-width=%221.3%22 opacity=%22.35%22/%3E%3C/svg%3E") 0 0 / 34px 34px, radial-gradient(ellipse at 50% 40%, #1f4fa8, #133274 55%, #081a42); }
.ft-lave { --ft: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 %3E%3Cpath d=%22M62 60L57 73L69 86L55 76L42 75%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M95 65L99 66L85 54L83 66L85 79%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M64 62L57 73L46 66L36 56L38 63%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M18 94L24 107L34 121L34 109L37 119%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M10 5L21 -5L14 -1L1 5L9 0%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M21 85L15 87L21 86L29 96L18 85%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M14 43L16 47L8 45L2 38L13 43%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M5 6L8 1L8 -5L4 1L16 15%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3Cpath d=%22M36 65L38 58L41 51L27 50L35 56%22 fill=%22none%22 stroke=%22%23ff8a1e%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 opacity=%22.85%22/%3E%3C/svg%3E") center / 70% auto, radial-gradient(ellipse at 50% 45%, rgba(255,110,0,.45), transparent 60%), radial-gradient(ellipse at 50% 40%, #2a0a04, #160402 60%, #080100); }
.ptable .oval.ft-lave, .mini-felt.ft-lave { animation: pv-lavapulse 3s ease-in-out infinite; }
.ft-aurore { --ft: radial-gradient(ellipse at 20% 40%, rgba(60,255,170,.55), transparent 45%), radial-gradient(ellipse at 60% 30%, rgba(150,90,255,.5), transparent 45%), radial-gradient(ellipse at 85% 60%, rgba(60,200,255,.5), transparent 45%), radial-gradient(ellipse at 50% 40%, #052a3a, #031a26 60%, #010a10); }
.ptable .oval.ft-aurore, .mini-felt.ft-aurore { background-size: 220% 220% !important; animation: pv-drift 10s ease-in-out infinite alternate; }
@keyframes pv-neon { 0%, 100% { opacity: .55; } 50% { opacity: 1; } 52% { opacity: .4; } 54% { opacity: 1; } }
@keyframes pv-fall { to { background-position: 0 96px; } }
@keyframes pv-spin { to { transform: rotate(360deg); } }
@keyframes pv-drift { 0% { background-position: 0% 40%; } 100% { background-position: 100% 60%; } }
@keyframes pv-glow { 0%, 100% { opacity: .7; } 50% { opacity: 1; } }
@keyframes pv-shimmer { to { background-position: 60px 0; } }
@keyframes pv-flash { 0%, 88% { opacity: .3; } 89% { opacity: 1; } 91% { opacity: .4; } 93% { opacity: 1; } 97%, 100% { opacity: .3; } }
@keyframes pv-flicker { 0%, 18%, 22%, 62%, 64%, 100% { opacity: 1; } 20%, 63% { opacity: .35; } }
@keyframes pv-burst { 0% { transform: scale(.6); opacity: 0; } 25% { opacity: 1; } 100% { transform: scale(1.1); opacity: 0; } }
@keyframes pv-swim { from { background-position: 45% 50%; } to { background-position: 55% 45%; } }
@keyframes pv-spot { from { transform: translateX(-28%); } to { transform: translateX(28%); } }
@keyframes pv-road { to { background-position: 0 16px, 0 0; } }
@keyframes pv-flame { from { transform: scaleY(.92); opacity: .85; } to { transform: scaleY(1.06); opacity: 1; } }
@keyframes pv-hue { to { filter: hue-rotate(360deg) drop-shadow(0 0 4px #ff4fd8); } }
@keyframes pv-firetext { to { background-position: 0 -200%; } }
@keyframes pv-neontext { 0%, 40%, 44%, 100% { opacity: 1; } 42% { opacity: .45; } }
@keyframes pv-glitch { 0% { text-shadow: -1.5px 0 #ff2a6d, 1.5px 0 #05d9e8; } 30% { text-shadow: 2px 0 #ff2a6d, -2px 0 #05d9e8; transform: translateX(.5px); } 60% { text-shadow: -1px 1px #ff2a6d, 1px -1px #05d9e8; transform: none; } }
@keyframes pv-electric { 0%, 100% { text-shadow: 0 0 4px #5fb4ff, 0 0 10px #2f7bff; } 50% { text-shadow: 0 0 6px #9fd4ff, 0 0 18px #2f7bff, 0 0 28px #2f7bff; } }
@keyframes pv-lavapulse { 0%, 100% { filter: brightness(.9); } 50% { filter: brightness(1.25); } }
@media (prefers-reduced-motion: reduce) { [class*="bn-"]::before, [class*="fr-"]::before, [class*="fr-"]::after, .pc-title[class*="tt-"] { animation: none !important; } }
/* performance: decorations stay still on modest phones; off-screen shop cards are not drawn */
.lowfx .fx::after, .lowfx .fx b, .lowfx .av.fq3, .lowfx .av.fq4, .lowfx .pc-title, .lowfx .mini-felt, .lowfx .ptable .oval,
.lowfx [class*="bn-"]::before, .lowfx [class*="fr-"]::before, .lowfx [class*="fr-"]::after, .lowfx .tabbar a.wheel-ready::after { animation: none !important; }
.lowfx .fx b { display: none; }
.item { content-visibility: auto; contain-intrinsic-size: auto 210px; }
/* exclusive banner from the daily wheel */
.bn-roue-fortune { background: radial-gradient(circle at 88% 50%, #ffd76a 0 7%, transparent 7.5%), repeating-conic-gradient(from 0deg at 88% 50%, #b3262f 0 15deg, #f2eee3 15deg 30deg, #1f7a4c 30deg 45deg, #f2eee3 45deg 60deg), #3a0a12; }
.bn-roue-fortune::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(5,10,8,.85) 0, rgba(5,10,8,.6) 45%, transparent 75%); z-index: 0; }
.bn-roue-fortune > * { position: relative; z-index: 1; }
/* a dot on the Défis tab while the daily wheel is waiting */
.tabbar a.wheel-ready::after { content: ""; position: absolute; top: 4px; right: calc(50% - 16px); width: 9px; height: 9px; border-radius: 50%; background: #e8414f; box-shadow: 0 0 0 2px rgba(var(--deep-rgb, 3, 18, 14),.9); animation: wheel-dot 1.4s infinite; }
@keyframes wheel-dot { 50% { opacity: .35; } }
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
.rar-commun { color: #b9c2bf; } .rar-rare { color: #6cc4ff; } .rar-epique { color: #c07ae8; } .rar-legendaire { color: #ffcf5a; } .rar-inedit { color: #8fe3c0; }

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
        ["Le sabot et la défausse", `<p>Les cartes viennent d'un sabot de 6 jeux (312 cartes), posé à droite du croupier comme au casino : on voit chaque carte en sortir. Sous le sabot : le nombre de cartes restantes, et l'étiquette <b>Sabot neuf</b> ou <b>Entamé</b>.</p>
          <p>À gauche, la défausse montre combien de cartes sont déjà sorties. Elles ne reviennent pas avant le mélange : si tu comptes les cartes, c'est ce qui te permet de savoir ce qu'il reste.</p>
          <p>Le trait rouge sur le sabot marque le mélange : quand il ne reste plus qu'un quart des cartes, le sabot est remélangé et la première carte est brûlée. Le sabot est gardé quand tu changes de page ou fermes l'app.</p>`],
        ["Astuces de base", `<ul>
          <li>Reste toujours à 17 ou plus.</li>
          <li>Tire toujours à 11 ou moins : tu ne peux pas sauter.</li>
          <li>Double sur 10 ou 11 quand le croupier montre une petite carte (2 à 9).</li>
          <li>Sépare toujours les As et les 8. Ne sépare jamais les 10 ni les 5.</li>
          <li>De 12 à 16, reste si le croupier montre 2 à 6 : c'est lui qui risque de sauter.</li></ul>`]
      ]
    },
    slots: {
      title: "Machine à sous 777",
      intro: "Trois rouleaux et une ligne de gain, celle du milieu. Aligne les bons symboles pour gagner.",
      sections: [
        ["Comment jouer", `<ol>
          <li>Choisis ta mise avec <b>−</b> et <b>+</b> (de 5 à 500 jetons).</li>
          <li>Touche <b>Lancer</b> : les rouleaux tournent puis s'arrêtent un par un.</li>
          <li><b>Mise max</b> met la plus grosse mise que ton solde permet et lance aussitôt.</li></ol>`],
        ["Les gains", `<p>Seule la ligne du milieu, marquée en rouge, compte. Les gains sont en nombre de fois ta mise, mise comprise.</p>
          <table class="hpay"><tr><th>Sur la ligne</th><th>Paie</th></tr>
          <tr><td><b>7 7 7</b> (jackpot)</td><td>×500</td></tr><tr><td>BAR BAR BAR</td><td>×50</td></tr>
          <tr><td>🍒🍒🍒 trois cerises</td><td>×30</td></tr><tr><td>🔔🔔🔔 trois cloches</td><td>×20</td></tr>
          <tr><td>🍉🍉🍉 trois pastèques</td><td>×12</td></tr><tr><td>🍇🍇🍇 trois raisins</td><td>×8</td></tr>
          <tr><td>🍋🍋🍋 trois citrons</td><td>×6</td></tr><tr><td>7 et BAR mélangés (ex. 7 BAR 7)</td><td>×5</td></tr>
          <tr><td>🍒🍒 deux cerises, n'importe où</td><td>×3</td></tr><tr><td>🍒 une cerise : mise rendue</td><td>×1</td></tr></table>
          <p>Exemple : 10 jetons misés et trois cloches, tu reçois 200 jetons (190 de gain).</p>`],
        ["Le hasard", `<ul>
          <li>Chaque rouleau a 50 positions : les 7 sont les plus rares, les citrons les plus fréquents.</li>
          <li>Chaque lancer est indépendant : une série de pertes ne rend pas le jackpot plus proche.</li>
          <li>Sur le long terme, la machine rend environ 95 % des mises, comme une vraie machine de casino.</li></ul>`]
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
    guide: {
      title: "Comment ça marche",
      intro: "Quatre choses à connaître : ton solde pour jouer, le classement, les points de saison et les couronnes.",
      sections: [
        ["Le solde de jetons", `<ul>
          <li>C'est l'argent pour jouer au blackjack, à la roulette, au poker contre les bots, au vidéo poker et à la machine à sous. Tu commences à 1 000.</li>
          <li>Il est gardé <b>sur ton compte</b> : le même sur tous tes appareils. Sans compte, il reste sur ce téléphone.</li>
          <li><b>+500 jetons offerts chaque jour</b> à ta première connexion.</li>
          <li>Quand il te reste moins de 5 jetons : <b>une recharge gratuite de 1 000 toutes les 4 heures</b>, 3 fois par jour au plus.</li>
          <li>Tu peux aussi <b>échanger des couronnes contre des jetons</b> dans la Boutique : 100 couronnes = 1 000 jetons.</li>
          <li>La roue du jour (onglet Défis) peut aussi te donner des jetons.</li>
          <li>Le poker en ligne utilise ses propres jetons de table (1 000 par joueur), séparés de ton solde.</li></ul>`],
        ["Le classement", `<dl>
          <dt>Semaine</dt><dd>Tes gains nets du lundi au dimanche (ce que tu as gagné moins ce que tu as misé). Classé à partir de 10 parties. Chaque lundi, les mieux placés reçoivent des couronnes.</dd>
          <dt>Depuis toujours</dt><dd>Tes gains nets depuis la création du compte.</dd></dl>
          <p>Les recharges et les jetons de la roue ne comptent jamais dans le classement : seules tes parties comptent.</p>`],
        ["Les points de saison et les rangs", `<p>Une saison dure un mois. Chaque jour (heure de Paris) :</p>
          <ul><li><b>1 point par partie</b>, 30 au plus par jour ;</li>
          <li><b>+1 point par tranche de 50 jetons de gain net de la journée</b> (gains moins pertes du jour).</li></ul>
          <p>Exemple : 40 parties dans la journée et 500 jetons de gain net, ça fait 30 + 10 = 40 points. Une journée perdante ne rapporte que les points de participation.</p>
          <p>Rangs : Bronze (50 pts), Fer (250), Argent (600), Or (1 000), Platine (1 600), Diamant (2 500), Alexandrite (4 000), Top 100 (les 100 meilleurs dès 4 000). En fin de mois, tu reçois les récompenses de ton rang <b>et de tous les rangs en dessous</b>, puis les rangs repartent à zéro.</p>`],
        ["Les couronnes", `<ul>
          <li>Elles servent à acheter bannières, cadres, titres et tapis de poker dans la Boutique.</li>
          <li>Tu en gagnes avec le classement de la semaine, ton rang de saison, les défis du jour, la connexion quotidienne et la roue du jour.</li>
          <li>Elles ne s'achètent pas et ne se transforment pas en jetons.</li></ul>`]
      ]
    },
    classement: {
      title: "Classement, semaines et saisons",
      intro: "Tout ce que tu joues compte pour trois classements, et rapporte des couronnes à dépenser en boutique.",
      sections: [
        ["Les trois classements", `<dl>
          <dt>Semaine</dt><dd>Gains nets du lundi au dimanche. Classé à partir de 10 parties. Récompenses chaque lundi.</dd>
          <dt>Saison</dt><dd>Un mois. Chaque jour : 1 point par partie (30 au plus), plus 1 point par tranche de 50 jetons de gain net de la journée.</dd>
          <dt>Depuis toujours</dt><dd>Total gagné moins total misé. Les recharges de solde ne comptent pas.</dd></dl>
          <p>Tout est résumé dans <b>Comment ça marche</b>, depuis les pages Rangs et Classement.</p>`],
        ["Récompenses de la semaine", `<ul>
          <li>1ᵉʳ : 1 000 couronnes, plus le cadre Couronne et le titre Champion de la semaine, gardés tant que tu restes 1ᵉʳ.</li>
          <li>2ᵉ : 600, 3ᵉ : 400, 4ᵉ à 10ᵉ : 200, tous les autres classés : 50.</li></ul>`],
        ["Rangs de saison", `<p>Bronze (50 pts), Fer (250), Argent (600), Or (1 000), Platine (1 600), Diamant (2 500), Alexandrite (4 000), Top 100 (les 100 meilleurs dès 4 000 points).</p>
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
          <li>Chaque jour : 3 défis (bonus de 50 si tu fais les 3) et la connexion quotidienne (5, 5, 5, 20, 20, 20 puis 50 couronnes le 7ᵉ jour d'affilée).</li>
          <li>Tes couronnes peuvent aussi s'échanger contre des jetons dans la Boutique : 100 couronnes = 1 000 jetons.</li>
          <li>Chaque jour aussi : un tour gratuit de la <b>roue du jour</b> dans l'onglet Défis (couronnes, jetons, ou la bannière exclusive Roue de la fortune).</li></ul>`],
        ["La boutique", `<ul>
          <li>Une sélection différente chaque lundi : 10 bannières, 7 cadres, 9 titres et 4 tapis de poker.</li>
          <li>Touche un objet pour l'essayer en aperçu, puis Acheter. Il rejoint ton casier.</li>
          <li>Chaque objet a un niveau de prestige selon son prix : Classique, Rare, Épique ou Légendaire. Plus il est élevé, plus l'objet brille. Sous chaque objet, tu vois combien de joueurs l'ont déjà.</li></ul>`],
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
/* Infos sheet, gift message and update notice */
.info-btn { position: relative; }
.info-btn svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.info-btn.has-news::after { content: ""; position: absolute; top: 4px; right: 4px; width: 9px; height: 9px; border-radius: 50%; background: #e8414f; box-shadow: 0 0 0 2px var(--felt-deep, #062a21); }
.info-tabs { display: grid; grid-template-columns: repeat(3, 1fr); padding: 3px; border-radius: 12px; background: rgba(0,0,0,.25); border: 1px solid var(--felt-line); }
.info-tabs button { height: 36px; border-radius: 9px; font-weight: 600; font-size: 13.5px; color: var(--muted); border: 0; background: none; font-family: inherit; cursor: pointer; }
.info-tabs button[aria-selected="true"] { background: var(--brass); color: var(--brass-ink, #2a1f0c); }
.news { padding: 12px 14px; border-radius: 14px; background: rgba(0,0,0,.22); border: 1px solid var(--felt-line); }
.news-d { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--brass); font-weight: 700; margin-bottom: 4px; }
.news b { font-size: 15.5px; }
.news ul, .gift-news ul { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 13.5px; line-height: 1.5; display: flex; flex-direction: column; gap: 3px; }
.fb-form textarea, .fb-form select { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--felt-line); background: rgba(0,0,0,.25); color: var(--ink); font: inherit; font-size: 15px; resize: vertical; }
.fb-form select { height: 44px; }
.fb-note { margin: 0; font-size: 12px; color: var(--muted); }
.fb-list { display: flex; flex-direction: column; gap: 8px; }
.fb-item { padding: 10px 12px; border-radius: 12px; background: rgba(0,0,0,.2); }
.fb-item p { margin: 6px 0 0; font-size: 13.5px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
.fb-item .fb-reply { color: var(--ink); }
.fb-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 13.5px; }
.fb-st { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 8px; background: rgba(255,255,255,.08); }
.fb-st.st-résolu { color: var(--win, #7fd99a); } .fb-st.st-en-cours { color: var(--brass); }
.gift-box h2 { margin: 0; font-family: var(--f-display, Georgia, serif); font-weight: 400; font-size: 25px; }
.gift-box p { margin: 0; color: var(--muted); line-height: 1.45; font-size: 14.5px; }
button.refill-wait { font-variant-numeric: tabular-nums; font-size: 14.5px; opacity: .85 !important; }
.login-chips { margin: 0; font-weight: 700; color: var(--win, #7fd99a); }
.gift-boost { font-size: 13.5px; font-weight: 700; color: var(--win, #7fd99a); }
.gift-news { text-align: left; padding: 10px 12px; border-radius: 12px; background: rgba(0,0,0,.22); }
.gift-news b { font-size: 13.5px; }
.upd-note { position: fixed; z-index: 45; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 10px); width: min(440px, calc(100% - 24px)); box-sizing: border-box;
  display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 10px 12px; border-radius: 14px; background: var(--sheet-bg, #0a3328); border: 1px solid var(--brass); box-shadow: 0 10px 30px rgba(0,0,0,.5); color: var(--ink); font-size: 13px; animation: tr-in .3s both; }
.upd-note b { grid-column: 1; } .upd-note span { grid-column: 1; color: var(--muted); } .upd-note .x { grid-row: 1 / 3; grid-column: 2; align-self: center; }
@media (max-width: 360px) { .bar-right { gap: 5px !important; } .bar-right .search-btn { width: 34px; height: 34px; } }

.theme-pick { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.theme-opt { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 6px 10px; border-radius: 14px; border: 1.5px solid var(--felt-line); background: rgba(0,0,0,.2); color: var(--ink); font: inherit; text-align: center; cursor: pointer; min-width: 0; }
.theme-opt[aria-checked="true"] { border-color: var(--brass); background: rgba(216,178,106,.12); box-shadow: 0 0 0 2px rgba(216,178,106,.3); }
.theme-opt .tp-sw { position: relative; width: 100%; height: 44px; border-radius: 10px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); overflow: hidden; }
.theme-opt .tp-sw i { position: absolute; left: 50%; top: 50%; width: 18px; height: 25px; margin: -12.5px 0 0 -9px; border-radius: 3px; background: #fbf8f1; box-shadow: 0 2px 5px rgba(0,0,0,.4); }
.theme-opt b { font-size: 13.5px; }
.theme-opt small { font-size: 11px; color: var(--muted); line-height: 1.25; }
.ps-lab { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
@media (max-width: 360px) { .theme-opt small { display: none; } }
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
          <details class="help-sec"><summary>Apparence : thème de l'application</summary><div class="help-body">${themeHTML()}</div></details>
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
    if (!seen && ["blackjack", "roulette", "holdem", "videopoker", "online", "slots"].includes(t)) {
      setTimeout(() => { if (!document.querySelector(".psheet-scrim, .reward-scrim")) openHelp(t); }, document.documentElement.classList.contains("booting") ? 2200 : 700);
    }
  }

  Object.assign(window.CasinoUI, { openSearch, rarity, openHelp });
  // « Comment ça marche » buttons on the Rangs and Classement pages
  document.addEventListener("click", e => { if (e.target.closest("[data-guide]")) openHelp("guide"); });
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
      ${st.login_chips ? `<p class="login-chips">+${fmtN(st.login_chips)} jetons pour jouer aujourd'hui</p>` : ""}
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
        if (st.login_chips > 0) setChips(st.chips != null ? +st.chips + pendingNet() : localChips() + st.login_chips);
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

  // ---------- what's new, technical support, ideas and bugs ----------
  // Each update stays in the list for a week, then disappears on its own.
  const CHANGELOG = [
    { date: "2026-11-17", title: "Plus de jetons pour rejouer", items: [
      "+500 jetons offerts chaque jour à ta première connexion.",
      "Recharge gratuite de 1 000 jetons toutes les 4 heures (3 fois par jour) quand ton solde est vide.",
      "Échange tes couronnes contre des jetons dans la Boutique : 100 couronnes = 1 000 jetons."] },
    { date: "2026-11-17", title: "Thèmes, Infos et mises à jour en douceur", items: [
      "Trois thèmes pour l'app : Classique, Sombre et Bleu nuit (Mon compte, ou en bas de l'aide ?).",
      "Nouveau bouton Infos : les nouveautés de la semaine, le support technique et la boîte à idées.",
      "Quand une mise à jour sort, ta partie n'est plus coupée : on te propose de redémarrer à la fin.",
      "Chargement plus rapide et animations plus légères sur les anciens téléphones.",
      "Affichage vérifié sur tous les écrans, du petit iPhone SE à l'ordinateur."] },
    { date: "2026-11-16", title: "Collection Prestige et nouveau système de points", items: [
      "42 objets Prestige illustrés et animés, et une boutique plus grande chaque semaine.",
      "Les objets brillent selon leur prestige : Classique, Rare, Épique, Légendaire.",
      "Points de saison par jour : 1 par partie (30 max), plus 1 par tranche de 50 jetons gagnés dans la journée.",
      "Solde gardé sur ton compte et une recharge gratuite par jour.",
      "Roue du jour dans l'onglet Défis, machine à sous 777, rangs plus durs à atteindre."] },
    { date: "2026-11-15", title: "Tapis de poker et vrai sabot de blackjack", items: [
      "Tapis de poker à personnaliser, pour le Hold'em contre les bots et le poker en ligne.",
      "Blackjack : un sabot posé sur la table, les cartes en sortent en direct."] },
    { date: "2026-11-14", title: "Blackjack plus réaliste", items: [
      "Le sabot est gardé quand tu changes de page, et une main commencée reprend où elle s'était arrêtée."] }
  ];
  const DAY = 864e5;
  const recentNews = () => CHANGELOG.filter(n => Date.now() - new Date(n.date + "T12:00:00").getTime() < 7 * DAY);
  const newsKey = n => n.date + "|" + n.title;
  const unseenNews = () => { const r = recentNews(); return r.length && newsKey(r[0]) !== read("casino.news.seen", ""); };
  const FEEDBACK_KINDS = { support: "Support technique", bug: "Signaler un bug", idee: "Proposer une idée", autre: "Autre" };
  const FEEDBACK_STATUS = { nouveau: "Envoyé", "en cours": "En cours", "résolu": "Résolu", "refusé": "Non retenu" };
  async function sendFeedback(kind, message, contact) {
    try {
      return await api("/rest/v1/rpc/send_feedback", { method: "POST", auth: !!session, body: { kind, message, contact: contact || null,
        page: (document.body.dataset.page || "").slice(0, 60), device: navigator.userAgent.slice(0, 200) } });
    } catch (e) {
      throw new Error(e.raw === "trop_de_messages" ? "Tu as envoyé beaucoup de messages : réessaie dans une heure."
        : /send_feedback|function/.test(e.raw || "") ? "Le support arrive avec la mise à jour du serveur."
        : e.code === "network" ? "Il faut internet pour envoyer ton message." : e.message);
    }
  }
  const myFeedback = () => api("/rest/v1/rpc/my_feedback", { method: "POST", body: {} });
  function openInfo(tab) {
    openSheet((sheet, close) => {
      const paint = t => {
        tab = t;
        const news = recentNews();
        if (t === "news" && news.length) { write("casino.news.seen", newsKey(news[0])); document.querySelectorAll(".info-btn").forEach(b => b.classList.remove("has-news")); }
        const fmtDay = d => new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        let body;
        if (t === "news") {
          body = news.length ? news.map((n, i) => `<div class="news rise" style="--i:${i}"><div class="news-d">${fmtDay(n.date)}</div><b>${escHTML(n.title)}</b><ul>${n.items.map(x => `<li>${escHTML(x)}</li>`).join("")}</ul></div>`).join("")
            : `<p class="loading">Pas de nouveauté cette semaine. Les mises à jour apparaissent ici pendant 7 jours.</p>`;
        } else {
          const isIdea = t === "idea";
          body = `<form class="ps-box fb-form" novalidate>
            <div class="ps-field"><label for="fbKind">Sujet</label><select id="fbKind">${(isIdea ? ["idee", "bug", "autre"] : ["support", "bug", "autre"]).map(k => `<option value="${k}">${FEEDBACK_KINDS[k]}</option>`).join("")}</select></div>
            <div class="ps-field"><label for="fbMsg">${isIdea ? "Ton idée ou le bug que tu as vu" : "Explique ton problème"}</label><textarea id="fbMsg" rows="5" maxlength="2000" placeholder="${isIdea ? "Ex. : ajouter un jeu de dés, un classement entre collègues…" : "Ex. : je ne peux pas me connecter, la page reste blanche…"}"></textarea></div>
            ${session ? "" : `<div class="ps-field"><label for="fbContact">Pour te répondre (facultatif)</label><input id="fbContact" maxlength="120" placeholder="Pseudo, e-mail ou numéro"></div>`}
            <button class="btn primary" type="submit">Envoyer</button>
            <div class="ps-msg" role="status"></div>
            <p class="fb-note">Ton téléphone et la page où tu es sont joints automatiquement pour nous aider à comprendre.</p>
          </form>
          ${session ? `<div class="ps-box"><b class="ps-lab">Mes demandes</b><div class="fb-list"><p class="loading">Chargement…</p></div></div>` : ""}`;
        }
        sheet.innerHTML = `<div class="grab" aria-hidden="true"></div>
          <div class="ph"><h2>Infos</h2><button class="x" data-close aria-label="Fermer">×</button></div>
          <div class="info-tabs" role="tablist">${[["news", "Nouveautés"], ["support", "Support"], ["idea", "Idées et bugs"]].map(([k, l]) => `<button role="tab" data-info="${k}" aria-selected="${k === t}">${l}</button>`).join("")}</div>
          ${body}`;
        const form = sheet.querySelector(".fb-form");
        if (form) {
          form.addEventListener("submit", async e => {
            e.preventDefault();
            const msg = form.querySelector("#fbMsg").value.trim(), out = form.querySelector(".ps-msg"), btn = form.querySelector("button");
            if (msg.length < 5) { out.className = "ps-msg"; out.textContent = "Écris quelques mots de plus."; return; }
            btn.disabled = true; out.textContent = "";
            try {
              await sendFeedback(form.querySelector("#fbKind").value, msg, form.querySelector("#fbContact") && form.querySelector("#fbContact").value.trim());
              form.querySelector("#fbMsg").value = "";
              out.className = "ps-msg ok"; out.textContent = "Merci ! Ton message est bien arrivé.";
              loadList();
            } catch (err) { out.className = "ps-msg"; out.textContent = err.message; }
            btn.disabled = false;
          });
          loadList();
        }
      };
      async function loadList() {
        const box = sheet.querySelector(".fb-list"); if (!box) return;
        try {
          const list = await myFeedback();
          box.innerHTML = list && list.length ? list.map(f => `<div class="fb-item"><div class="fb-top"><b>${FEEDBACK_KINDS[f.kind] || f.kind}</b><span class="fb-st st-${escHTML(f.status).replace(/\s/g, "-")}">${FEEDBACK_STATUS[f.status] || f.status}</span></div>
            <p>${escHTML(f.message)}</p>${f.reply ? `<p class="fb-reply"><b>Réponse :</b> ${escHTML(f.reply)}</p>` : ""}</div>`).join("") : `<p class="loading">Aucune demande pour l'instant.</p>`;
        } catch (e) { box.innerHTML = `<p class="loading">${escHTML(e.code === "network" ? "Il faut internet pour voir tes demandes." : "Tes demandes s'afficheront après la mise à jour du serveur.")}</p>`; }
      }
      sheet.addEventListener("click", e => { const b = e.target.closest("[data-info]"); if (b && b.dataset.info !== tab) paint(b.dataset.info); });
      paint(tab || "news");
    });
  }
  function mountInfo() {
    const right = document.querySelector(".app .bar .bar-right");
    if (!right || right.querySelector(".info-btn")) return;
    const b = document.createElement("button");
    b.className = "search-btn info-btn" + (unseenNews() ? " has-news" : "");
    b.type = "button";
    b.setAttribute("aria-label", "Infos : nouveautés, support et idées");
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
    b.onclick = () => openInfo(unseenNews() ? "news" : "news");
    const help = right.querySelector(".help-btn");
    if (help) help.after(b); else right.prepend(b);
  }
  // one-off messages from the casino (for example a gift), shown once
  function showGift(g) {
    if (!g || document.querySelector(".reward-scrim")) return;
    const news = recentNews().slice(0, 2);
    const box = document.createElement("div");
    box.className = "reward-scrim";
    box.innerHTML = `<div class="reward-box gift-box" role="dialog" aria-modal="true" aria-labelledby="giftTitle">
      <h2 id="giftTitle">${escHTML(g.title)}</h2>
      <p>${escHTML(g.message)}</p>
      <div class="gift-gains">${g.crowns ? `<div class="rw-crowns">${CROWN}+${fmtN(g.crowns)}</div>` : ""}${+g.net_boost ? `<div class="gift-boost">+${fmtN(g.net_boost)} jetons ajoutés à ton total « Depuis toujours » au classement</div>` : ""}</div>
      ${news.length ? `<div class="gift-news"><b>Les dernières nouveautés</b><ul>${news.flatMap(n => n.items.slice(0, 3)).map(x => `<li>${escHTML(x)}</li>`).join("")}</ul></div>` : ""}
      <button class="btn primary">Merci !</button></div>`;
    document.body.appendChild(box);
    if (typeof confetti === "function") confetti();
    box.querySelector("button").onclick = () => {
      box.remove();
      api("/rest/v1/rpc/mark_gift_seen", { method: "POST", body: { gift: g.id } }).catch(() => {});
      if (profile) keepProfile({ ...profile, gifts: (profile.gifts || []).filter(x => x.id !== g.id) });
    };
  }

  // ---------- updates without breaking a game ----------
  // When a new version is online, a game page finishes the current hand first, then asks to restart.
  const APP_VERSION = "30";
  let updateReady = false, updateWarned = false;
  const inGame = () => { try { return typeof window.CasinoBusy === "function" && !!window.CasinoBusy(); } catch (e) { return false; } };
  async function checkUpdate() {
    if (updateReady || navigator.onLine === false) return;
    try {
      const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const v = await r.json();
      if (v && v.v && String(v.v) !== APP_VERSION) { updateReady = true; offerUpdate(); }
    } catch (e) {}
  }
  function restartApp() {
    const go = () => location.reload();
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
        navigator.serviceWorker.getRegistration().then(reg => {
          if (!reg) return go();
          navigator.serviceWorker.addEventListener("controllerchange", go);
          reg.update().catch(() => {}).then(() => setTimeout(go, 2500));
        }).catch(go);
        return;
      }
    } catch (e) {}
    go();
  }
  function offerUpdate() {
    if (inGame()) {
      if (!updateWarned) {
        updateWarned = true;
        const n = document.createElement("div");
        n.className = "upd-note";
        n.setAttribute("role", "status");
        n.innerHTML = `<b>Mise à jour disponible</b><span>Termine ta partie tranquillement : on te proposera de redémarrer juste après.</span><button class="x" aria-label="Fermer">×</button>`;
        n.querySelector("button").onclick = () => n.remove();
        document.body.appendChild(n);
      }
      setTimeout(offerUpdate, 1500);
      return;
    }
    document.querySelectorAll(".upd-note").forEach(x => x.remove());
    if (document.querySelector(".upd-scrim")) return;
    const box = document.createElement("div");
    box.className = "reward-scrim upd-scrim";
    box.innerHTML = `<div class="reward-box" role="alertdialog" aria-modal="true" aria-labelledby="updTitle">
      <h2 id="updTitle">Mise à jour prête</h2>
      <p>Une nouvelle version du casino est disponible. Redémarre l'app pour en profiter : ton solde et tes objets sont gardés.</p>
      <button class="btn primary">Redémarrer maintenant</button></div>`;
    document.body.appendChild(box);
    box.querySelector("button").onclick = e => { e.target.disabled = true; e.target.textContent = "Redémarrage…"; restartApp(); };
  }
  setTimeout(checkUpdate, 4000);
  setInterval(checkUpdate, 120000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });
  Object.assign(window.CasinoUI, { openInfo });

  const boot = () => { mountNav(); mountSearch(); mountHelp(); mountInfo(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  setTimeout(checkRewards, 1200);
  setTimeout(() => runDaily(true), 1900);
})();
