'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';

/**
 * Remote admin-login switch, managed from the admin panel (Users →
 * Access control) and stored in Firestore (cms_config/auth) so it applies
 * live to every tab (onSnapshot).
 *
 * POLICY (owner directive, 2026-10-08):
 *  - /map NEVER requires login. mapLoginRequired is kept in the interface
 *    and in the Firestore doc for history/compat, but it is FORCED to false
 *    in readAuthGate — no switch value can ever close the map.
 *  - /admin ALWAYS requires admin sign-in by default. The owner can turn
 *    this off from the admin panel at any time; if they do, /admin opens
 *    for everyone — that is their explicit decision, not a default.
 *
 * Default when the config doc can't be read (rules, offline, first run):
 * admin login REQUIRED, map open — never wider than the policy above.
 */
export interface AuthGateConfig {
  /** Legacy: forced to false — the map never requires login. */
  mapLoginRequired: boolean;
  /** Require admin sign-in to open /admin. */
  adminLoginRequired: boolean;
}

export const DEFAULT_AUTH_GATE: AuthGateConfig = {
  mapLoginRequired: false,
  adminLoginRequired: true,
};

const AUTH_GATE_PATH = 'cms_config/auth';

export function useAuthGate(): { config: AuthGateConfig; loading: boolean } {
  const [config, setConfig] = useState<AuthGateConfig>(DEFAULT_AUTH_GATE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, AUTH_GATE_PATH),
      (snap) => {
        const data = (snap.data() || {}) as Partial<AuthGateConfig>;
        // OWNER POLICY: the map is ALWAYS open — any stored/stale/missing
        // mapLoginRequired value is coerced to false. Only adminLoginRequired
        // is actually switch-controlled.
        setConfig({
          mapLoginRequired: false,
          adminLoginRequired: data.adminLoginRequired ?? DEFAULT_AUTH_GATE.adminLoginRequired,
        });
        setLoading(false);
      },
      (err) => {
        // Usually Firestore rules blocking the read for anonymous visitors —
        // the safe default (login required) applies until the rule is added.
        console.warn('[AuthGate] Config unavailable, keeping defaults:', err.message);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  return { config, loading };
}

export async function saveAuthGateConfig(config: AuthGateConfig): Promise<void> {
  await setDoc(doc(db, AUTH_GATE_PATH), config);
}