'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { Loader2, LogOut, ShieldAlert, MailQuestion } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { db } from '@/lib/firebase';

interface Props {
  children: ReactNode;
  /** Where to send the user when they need to sign in. Defaults to /login. */
  loginPath?: string;
  /** Where to redirect after login. Defaults to current pathname. */
  redirectTo?: string;
}

export function RequireAuth({ children, loginPath = '/login', redirectTo }: Props) {
  const router = useRouter();
  const { user, profile, loading, isAuthorized, signOut } = useAuth();
  const [requestSent, setRequestSent] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      const target = redirectTo
        ? `${loginPath}?next=${encodeURIComponent(redirectTo)}`
        : loginPath;
      router.replace(target);
    }
  }, [loading, user, redirectTo, loginPath, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0c10] text-white">
        <div className="flex items-center gap-3 text-gray-300">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Verifying access…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0c10] text-white">
        <div className="flex items-center gap-3 text-gray-300">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Redirecting to login…</span>
        </div>
      </div>
    );
  }

  if (!profile || !isAuthorized) {
    const handleRequestAccess = async () => {
      if (!user) return;
      setRequesting(true);
      setRequestError(null);
      try {
        await addDoc(collection(db, 'accessRequests'), {
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          requestedAt: serverTimestamp(),
          status: 'pending',
        });
        setRequestSent(true);
      } catch (err: any) {
        console.error('[RequireAuth] Failed to submit access request:', err);
        setRequestError(err?.message || 'Could not send the request.');
      } finally {
        setRequesting(false);
      }
    };

    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-[#0a0c10] via-[#11151c] to-[#0a0c10] text-white">
        <div className="w-full max-w-md bg-white/[0.03] border border-white/10 rounded-3xl p-8 shadow-2xl">
          <div className="flex items-center justify-center mb-5">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center">
              <ShieldAlert className="w-6 h-6 text-amber-400" />
            </div>
          </div>
          <h1 className="text-xl font-bold text-center">Access pending</h1>
          <p className="text-sm text-gray-400 text-center mt-2">
            Hi <span className="text-white">{user.displayName || user.email}</span>, an administrator still needs to approve your account before you can use the map.
          </p>

          <div className="mt-6 flex flex-col gap-3">
            {requestSent ? (
              <div className="flex items-center gap-2 text-sm text-emerald-400 justify-center bg-emerald-500/10 border border-emerald-500/30 rounded-xl py-3">
                <MailQuestion className="w-4 h-4" />
                Request sent. We'll email you when you're approved.
              </div>
            ) : (
              <button
                onClick={handleRequestAccess}
                disabled={requesting}
                className="w-full px-4 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {requesting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending request…
                  </>
                ) : (
                  <>
                    <MailQuestion className="w-4 h-4" />
                    Request access
                  </>
                )}
              </button>
            )}
            {requestError && (
              <p className="text-xs text-red-400 text-center">{requestError}</p>
            )}
            <button
              onClick={() => signOut()}
              className="w-full px-4 py-2 rounded-xl border border-white/10 text-gray-300 hover:bg-white/5 transition-colors flex items-center justify-center gap-2 text-sm"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, profile, loading, isAdmin } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login?next=/admin');
    } else if (!isAdmin) {
      router.replace('/map');
    }
  }, [loading, user, isAdmin, router]);

  if (loading || !user || !profile || !isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0c10] text-white">
        <div className="flex items-center gap-3 text-gray-300">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Checking admin access…</span>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}