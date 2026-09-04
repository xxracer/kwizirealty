'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Cookie } from 'lucide-react';

const CONSENT_KEY = 'kwizi-cookie-consent';

/**
 * First-visit consent/notice banner. The app stores no tracking or marketing
 * cookies — it only uses browser-local storage (localStorage / IndexedDB) to
 * cache the market dataset so repeat visits load faster, which qualifies as
 * strictly necessary technical storage. We still surface this notice so
 * visitors know data is saved on their device, per GDPR/ePrivacy best practice.
 */
export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(CONSENT_KEY)) setVisible(true);
    } catch {
      // Storage unavailable (private mode) — just don't show the banner.
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:left-6 sm:right-auto sm:max-w-sm z-[9000] bg-[#121620] border border-white/[0.08] rounded-2xl shadow-2xl p-4 text-white animate-[fadeIn_0.3s_ease-out]">
      <div className="flex items-start gap-3">
        <Cookie className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-xs text-gray-300 leading-relaxed">
            We store a copy of the market data on your device (browser storage) so
            the map loads faster the next time you visit. No tracking or
            advertising cookies are used. See our{' '}
            <Link href="/privacy" className="underline hover:text-white">
              Privacy Policy
            </Link>
            .
          </p>
          <button
            onClick={accept}
            className="mt-3 w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );

  function accept() {
    try {
      localStorage.setItem(CONSENT_KEY, 'accepted');
    } catch {
      // Ignore — banner just reappears next visit.
    }
    setVisible(false);
  }
}