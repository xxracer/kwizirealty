'use client';

import { createContext, useContext, useEffect, useState, useMemo, ReactNode, useCallback } from 'react';
import {
  GoogleAuthProvider,
  User,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { collection, doc, getDoc, getDocs, query, setDoc, serverTimestamp, where } from 'firebase/firestore';
import { auth, db } from './firebase';

export type UserRole = 'admin' | 'user';

/** Subscription info stored on a `users` or `companies` doc (managed by admins). */
export interface UserSubscription {
  plan?: string;
  status?: 'active' | 'trial' | 'expired';
  startedAt?: number;
  /** Epoch ms when the subscription expires. */
  expiresAt?: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
  authorized: boolean;
  /** Set when the user belongs to a company account (multi-access seat). */
  companyName?: string;
  companyId?: string;
  subscription?: UserSubscription;
  createdAt?: number;
  lastLogin?: number;
}

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  /** Set when loading the Firestore profile failed (e.g. security rules). */
  profileError: string | null;
  isAdmin: boolean;
  isAuthorized: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  cmsAllowedEmails: string[];
}

const AuthContext = createContext<AuthContextValue | null>(null);

function getCmsAllowedEmails(): string[] {
  const raw = process.env.NEXT_PUBLIC_CMS_ALLOWED_EMAILS || '';
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function loadProfile(uid: string): Promise<UserProfile | null> {
  const ref = doc(db, 'users', uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const profile = snap.data() as UserProfile;
  // Users created by an admin (AdminUsers -> createUserWithEmailAndPassword)
  // store { id, name, email, role, createdAt } without an `authorized` flag.
  // They were explicitly created with a role, so treat them as authorized;
  // otherwise they'd be stuck on "Access pending" forever.
  if (profile.authorized === undefined) profile.authorized = true;
  return profile;
}

async function ensureUserProfile(user: User, isAdminEmail: boolean): Promise<UserProfile> {
  const ref = doc(db, 'users', user.uid);
  const existing = await loadProfile(user.uid);

  if (existing) {
    const patch: Partial<UserProfile> = {
      lastLogin: Date.now(),
      email: user.email || existing.email,
      displayName: user.displayName || existing.displayName,
      photoURL: user.photoURL || existing.photoURL,
    };
    // If the email is in the CMS allowlist, force-authorize and elevate role.
    if (isAdminEmail && (!existing.authorized || existing.role !== 'admin')) {
      patch.authorized = true;
      patch.role = 'admin';
    }
    await setDoc(ref, patch, { merge: true });
    return { ...existing, ...patch } as UserProfile;
  }

  const profile: UserProfile = {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || user.email?.split('@')[0] || 'User',
    photoURL: user.photoURL || undefined,
    role: isAdminEmail ? 'admin' : 'user',
    authorized: isAdminEmail,
    createdAt: Date.now(),
    lastLogin: Date.now(),
  };
  await setDoc(ref, { ...profile, _serverTimestamp: serverTimestamp() });
  return profile;
}

/**
 * Company (multi-access) lookup: a company account doc lives in the
 * `companies` collection and lists every authorized employee email. Any
 * Gmail/Google account on that list gets access to the platform without
 * needing individual approval. Returns the full company doc (id, name and
 * subscription) so the seat can inherit the company's subscription.
 */
async function findCompanyMembership(
  emailLower: string
): Promise<{ id: string; name: string; subscription?: UserSubscription } | null> {
  if (!emailLower) return null;
  try {
    const q = query(collection(db, 'companies'), where('employees', 'array-contains', emailLower));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const data = snap.docs[0].data() as { name?: string; subscription?: UserSubscription };
    return { id: snap.docs[0].id, name: data.name || snap.docs[0].id, subscription: data.subscription };
  } catch (err) {
    console.warn('[AuthContext] Company membership lookup failed:', err);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const cmsAllowedEmails = useMemo(() => getCmsAllowedEmails(), []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (!firebaseUser) {
        setProfile(null);
        setProfileError(null);
        setLoading(false);
        return;
      }
      try {
        const emailLower = (firebaseUser.email || '').toLowerCase();
        const isAdminEmail = cmsAllowedEmails.includes(emailLower);
        let prof = await ensureUserProfile(firebaseUser, isAdminEmail);

        // Company multi-access: if this email is an employee/owner of a
        // company account, authorize the profile automatically and mirror the
        // company's subscription onto the seat.
        const membership = await findCompanyMembership(emailLower);
        if (membership) {
          const patch: Partial<UserProfile> = {
            authorized: true,
            companyName: membership.name,
            companyId: membership.id,
            lastLogin: Date.now(),
          };
          if (membership.subscription?.expiresAt) {
            patch.subscription = membership.subscription;
          }
          await setDoc(doc(db, 'users', firebaseUser.uid), patch, { merge: true });
          prof = { ...prof, ...patch };
        }

        setProfile(prof);
        setProfileError(null);
      } catch (err) {
        // Surface the real reason (usually Firestore security rules) instead of
        // spinning forever on the login page.
        console.error('[AuthContext] Failed to load profile:', err);
        const message = err instanceof Error ? err.message : String(err);
        setProfileError(`Could not load your account: ${message}`);
        setProfile(null);
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, [cmsAllowedEmails]);

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    // Users created by an admin authenticate with email + password; the login
    // page must offer this or those accounts have no way to sign in.
    await signInWithEmailAndPassword(auth, email.trim(), password);
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
    setUser(null);
    setProfile(null);
    setProfileError(null);
  }, []);

  const isAdmin = !!profile && profile.role === 'admin' && profile.authorized;
  const isAuthorized = !!profile && profile.authorized;

  const value = useMemo<AuthContextValue>(
    () => ({ user, profile, loading, profileError, isAdmin, isAuthorized, signInWithGoogle, signInWithEmail, signOut, cmsAllowedEmails }),
    [user, profile, loading, profileError, isAdmin, isAuthorized, signInWithGoogle, signInWithEmail, signOut, cmsAllowedEmails]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}