// App themes (Classique green, Sombre, Bleu nuit), applied before the page is painted.
(() => {
  const THEMES = { vert: "#072a22", sombre: "#0c0d10", nuit: "#091a3a" };
  const st = document.createElement("style");
  st.id = "casino-themes";
  st.textContent = `
html[data-theme="sombre"] { --felt: #1d1f25; --felt-mid: #131519; --felt-deep: #08090c; --felt-hi: #2c3038; --glass-rgb: 16, 17, 21; --deep-rgb: 9, 10, 13; --sheet-bg: #15171c; --felt-line: rgba(216, 178, 106, .26); }
html[data-theme="nuit"] { --felt: #183c80; --felt-mid: #102b60; --felt-deep: #061533; --felt-hi: #2453a6; --glass-rgb: 6, 16, 42; --deep-rgb: 4, 11, 30; --sheet-bg: #0d2149; --felt-line: rgba(216, 178, 106, .3); }
html[data-theme="sombre"].booting, html[data-theme="sombre"] body { background-color: #08090c; }
html[data-theme="nuit"].booting, html[data-theme="nuit"] body { background-color: #061533; }
html[data-theme="sombre"] #splash { background: radial-gradient(120% 70% at 50% 42%, #2c3038 0%, #15171c 50%, #060608 100%) !important; }
html[data-theme="nuit"] #splash { background: radial-gradient(120% 70% at 50% 42%, #2453a6 0%, #102b60 50%, #040d22 100%) !important; }`;
  document.head.appendChild(st);
  // the theme follows the player from page to page
  window.casinoSetTheme = t => {
    if (!THEMES[t]) t = "vert";
    if (t === "vert") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", THEMES[t]));
    try { localStorage.setItem("casino.theme", t); } catch (e) {}
  };
  let t = "vert";
  try { t = localStorage.getItem("casino.theme") || "vert"; } catch (e) {}
  if (t !== "vert" && THEMES[t]) {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", THEMES[t]));
  }
  // phones from before 2022 do not know the "dvh" screen unit: use "vh" instead
  try {
    if (window.CSS && CSS.supports && !CSS.supports("height", "1dvh")) {
      const fix = () => {
        document.querySelectorAll("style").forEach(el => { if (el.textContent.indexOf("dvh") >= 0) el.textContent = el.textContent.replace(/dvh/g, "vh"); });
        document.querySelectorAll('[style*="dvh"]').forEach(el => el.setAttribute("style", el.getAttribute("style").replace(/dvh/g, "vh")));
      };
      fix();
      document.addEventListener("DOMContentLoaded", fix);
      window.addEventListener("load", fix);
      // later additions (styles from app.js, cards drawn with an inline size) are fixed as they arrive
      const one = el => {
        if (el.nodeType !== 1) return;
        if (el.tagName === "STYLE") { if (el.textContent.indexOf("dvh") >= 0) el.textContent = el.textContent.replace(/dvh/g, "vh"); return; }
        const st = el.getAttribute("style"); if (st && st.indexOf("dvh") >= 0) el.setAttribute("style", st.replace(/dvh/g, "vh"));
        if (el.firstElementChild && el.innerHTML.indexOf("dvh") >= 0) el.querySelectorAll('[style*="dvh"]').forEach(one);
      };
      new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(one))).observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) {}
})();

// Launch screen: shown once per app session while the page and its fonts load.
(() => {
  let first = true;
  try { first = !sessionStorage.getItem("casino.booted"); sessionStorage.setItem("casino.booted", "1"); } catch (e) {}
  if (!first) return;
  const root = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.classList.add("booting");
  const st = document.createElement("style");
  st.textContent = `
html.booting { background: #062a21; }
html.booting body > *:not(#splash) { opacity: 0; }
body > * { transition: opacity .45s ease; }
#splash { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
  background: radial-gradient(120% 70% at 50% 42%, #14624c 0%, #0b3d30 50%, #041d17 100%); color: #f2eee3;
  font-family: "Outfit", -apple-system, "Helvetica Neue", Arial, sans-serif; transition: opacity .5s ease, transform .6s cubic-bezier(.5,0,.2,1); }
#splash.out { opacity: 0; transform: scale(1.06); pointer-events: none; }
#splash .sp-cards { position: relative; width: 150px; height: 120px; }
#splash .sp-card { position: absolute; left: 50%; bottom: 0; width: 70px; height: 98px; margin-left: -35px; border-radius: 9px; background: #fbf8f1;
  box-shadow: 0 10px 24px rgba(0,0,0,.45); transform-origin: 50% 110%; display: grid; place-items: center;
  font: 700 34px "DM Serif Display", Georgia, serif; color: #1b1e24; animation: sp-fan .9s cubic-bezier(.3,1.4,.5,1) both; }
#splash .sp-card small { position: absolute; top: 6px; left: 8px; font: 700 13px "Outfit", Arial, sans-serif; line-height: 1; text-align: center; }
#splash .sp-card.red { color: #c22f3a; }
#splash .c1 { --r: -20deg; animation-delay: .1s; }
#splash .c2 { --r: 0deg; animation-delay: .22s; z-index: 2; }
#splash .c3 { --r: 20deg; animation-delay: .34s; z-index: 3; }
@keyframes sp-fan { from { transform: translateY(40px) rotate(0) scale(.7); opacity: 0; } to { transform: rotate(var(--r)); opacity: 1; } }
#splash .sp-word { font: 400 46px "DM Serif Display", Georgia, serif; letter-spacing: .3em; margin-right: -.3em; color: #f2eee3;
  animation: sp-word .9s .35s cubic-bezier(.2,.8,.25,1) both; }
@keyframes sp-word { from { letter-spacing: .7em; opacity: 0; } }
#splash .sp-sub { font-size: 12px; letter-spacing: .32em; text-transform: uppercase; color: #d8b26a; animation: sp-in .6s .6s both; }
@keyframes sp-in { from { opacity: 0; transform: translateY(6px); } }
#splash .sp-bar { width: 140px; height: 3px; border-radius: 2px; background: rgba(216,178,106,.2); overflow: hidden; margin-top: 8px; animation: sp-in .4s .7s both; }
#splash .sp-bar i { display: block; height: 100%; width: 40%; border-radius: 2px; background: linear-gradient(90deg, transparent, #d8b26a, transparent); animation: sp-load 1.1s ease-in-out infinite; }
@keyframes sp-load { from { transform: translateX(-110%); } to { transform: translateX(260%); } }
@media (prefers-reduced-motion: reduce) { #splash *, #splash { animation: none !important; transition: opacity .2s !important; } }`;
  document.head.appendChild(st);

  let splash = null;
  const show = () => {
    splash = document.createElement("div");
    splash.id = "splash";
    splash.setAttribute("role", "status");
    splash.setAttribute("aria-label", "Chargement du Casino");
    splash.innerHTML = `<div class="sp-cards" aria-hidden="true">
        <span class="sp-card c1"><small>A<br>♠&#xFE0E;</small>♠&#xFE0E;</span>
        <span class="sp-card red c2"><small>R<br>♥&#xFE0E;</small>R</span>
        <span class="sp-card red c3"><small>D<br>♦&#xFE0E;</small>D</span>
      </div>
      <div class="sp-word">CASINO</div>
      <div class="sp-sub">Blackjack · Roulette · Poker</div>
      <div class="sp-bar" aria-hidden="true"><i></i></div>`;
    document.body.prepend(splash);
  };
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);

  const t0 = performance.now();
  const loaded = new Promise(r => (document.readyState === "complete" ? r() : addEventListener("load", r)));
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
  const cap = new Promise(r => setTimeout(r, 3500));
  Promise.race([Promise.all([loaded, fonts]), cap]).then(() => {
    const wait = Math.max(0, (still ? 300 : 1300) - (performance.now() - t0));
    setTimeout(() => {
      root.classList.remove("booting");
      if (!splash) return;
      splash.classList.add("out");
      setTimeout(() => splash && splash.remove(), 650);
    }, wait);
  });
})();
