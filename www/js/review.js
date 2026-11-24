var Review = (function () {
  const LAST = 'amerikano.reviewAsked';
  const GAP = 120 * 86400000;
  const GAMES = 5;

  const plug = () => window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins.AppReview;

  function due() {
    try { return Date.now() - Number(localStorage.getItem(LAST) || 0) > GAP; } catch (e) { return false; }
  }

  // after a won online match; the games count comes from the account as the server has it now
  async function won() {
    const p = plug();
    if (!p || !due()) return;
    const me = await Account.refresh().catch(() => Account.me());
    if (!me || me.games < GAMES) return;
    try { localStorage.setItem(LAST, String(Date.now())); } catch (e) { return; }
    p.requestReview().catch(() => {});
  }

  return { won: won };
})();
