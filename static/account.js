/* account.js — resolves the visitor's plan and tells map.js about it.
 *
 * Free (not signed in)      → view only
 * Basic / Premium / Enterprise → unlocked (map.js gates premium features)
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

async function publish(account) {
  window.RESDOGS_ACCOUNT = account;
  window.dispatchEvent(new CustomEvent('resdogs:account', { detail: account }));
}

try {
  const cfg = await (await fetch('/api/admin/config')).json();
  if (!cfg.apiKey || !cfg.projectId) {
    await publish({ signedIn: false, plan: 'free', email: null });
  } else {
    const app = initializeApp({
      apiKey: cfg.apiKey,
      authDomain: cfg.authDomain,
      projectId: cfg.projectId,
      appId: cfg.appId,
    });
    const auth = getAuth(app);

    onAuthStateChanged(auth, async (user) => {
      try {
        const token = user ? await user.getIdToken() : null;
        const res = await fetch('/api/me', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const account = await res.json();
        await publish(account);
      } catch (err) {
        console.warn('[account]', err);
        await publish({ signedIn: false, plan: 'free', email: null });
      }
    });
  }
} catch (err) {
  console.warn('[account] init failed', err);
  await publish({ signedIn: false, plan: 'free', email: null });
}
