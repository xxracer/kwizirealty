'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';

/**
 * Remote access-control switches, managed from the admin panel (Users →
 * Access control) and stored in Firestore so they apply to every visitor
 * live (onSnapshot pushes the change to all open tabs immediately).
 *
 * Defaults are BOTH REQUIRED: if the config doc can't be read (rules,
 * offline, first run), the app behaves exactly as before — never wider.
 */
export interface AuthGateConfig {
  /** Require sign-in (and account approval) to open /map. */
  mapLoginRequired: boolean;
  /** Require admin sign-in to open /admin. */
  adminLoginRequired: boolean;
}

export const DEFAULT_AUTH_GATE: AuthGateConfig = {
  mapLoginRequired: true,
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
        // A missing field falls back to "required" rather than open.
        setConfig({
          mapLoginRequired: data.mapLoginRequired ?? DEFAULT_AUTH_GATE.mapLoginRequired,
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