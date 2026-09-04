'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, LogIn, ShieldCheck, Map, Mail } from 'lucide-react';
import { useAuth } from '@/lib/authContext';

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSplash />}>
      <LoginContent />
    </Suspense>
  );
}

function LoginSplash() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0c10] text-white">
      <div className="flex items-center gap-3 text-gray-300">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    </div>
  );
}

function LoginContent() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/map';
  const { user, profile, loading, profileError, isAuthorized, signInWithGoogle, signInWithEmail } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (loading) return;
    if (user && isAuthorized) {
      router.replace(next);
    }
  }, [loading, user, isAuthorized, next, router]);

  const handleSignIn = async () => {
    setError(null);
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      console.error('[Login] Google sign-in failed:', err);
      setError(err?.message || 'Could not sign in with Google.');
    } finally {
      setSigningIn(false);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSigningIn(true);
    try {
      await signInWithEmail(email, password);
      // onAuthStateChanged in AuthContext takes over from here.
    } catch (err: any) {
      console.error('[Login] Email sign-in failed:', err);
      const code = err?.code || '';
      if (code === 'auth/operation-not-allowed') {
        setError('Email/password sign-in is not enabled for this Firebase project.');
      } else if (code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') {
        setError('Invalid email or password.');
      } else {
        setError(err?.message || 'Could not sign in.');
      }
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-gradient-to-br from-[#0a0c10] via-[#11151c] to-[#0a0c10] text-white">
      <div className="w-full max-w-md bg-white/[0.03] border border-white/10 rounded-3xl p-8 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-1">Kwizi Access</h1>
        <p className="text-sm text-gray-400 text-center mb-6">
          Sign in with your Google account to continue.
        </p>

        {loading || (user && !profile && !profileError) ? (
          <div className="flex items-center justify-center py-6 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Checking your account…</span>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={handleSignIn}
              disabled={signingIn}
              className="w-full flex items-center justify-center gap-3 px-5 py-3 rounded-xl bg-white text-[#0a0c10] font-semibold hover:bg-gray-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {signingIn ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <svg viewBox="0 0 24 24" className="w-5 h-5">
                <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.28 1.4-1.07 2.59-2.27 3.4v2.81h3.66c2.16-1.99 3.43-4.91 3.43-8.45z"/>
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.66-2.81c-1.07.72-2.45 1.15-4.27 1.15-3.27 0-6.04-2.21-7.03-5.18H1.18v3.25C3.16 21.43 7.27 24 12 24z"/>
                <path fill="#FBBC05" d="M4.97 14.18c-.25-.72-.39-1.49-.39-2.18s.14-1.46.39-2.18V6.57H1.18C.43 8.16 0 9.97 0 12s.43 3.84 1.18 5.43l3.79-3.25z"/>
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.81l3.42-3.42C17.95 1.16 15.24 0 12 0 7.27 0 3.16 2.57 1.18 6.57l3.79 3.25C5.96 6.96 8.73 4.75 12 4.75z"/>
              </svg>
            )}
            <span>{signingIn ? 'Signing in…' : 'Continue with Google'}</span>
            </button>

            {showEmail ? (
              <form onSubmit={handleEmailSignIn} className="space-y-2">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email"
                  autoComplete="email"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500"
                />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500"
                />
                <button
                  type="submit"
                  disabled={signingIn || !email || !password}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
                >
                  {signingIn ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  <span>{signingIn ? 'Signing in…' : 'Sign in with email'}</span>
                </button>
              </form>
            ) : (
              <button
                onClick={() => setShowEmail(true)}
                className="w-full px-5 py-2 rounded-xl border border-white/10 text-gray-300 hover:bg-white/5 transition-colors text-xs"
              >
                Sign in with email &amp; password instead
              </button>
            )}
          </div>
        )}

        {profileError && (
          <p className="mt-4 text-sm text-amber-400 text-center" title={profileError}>
            {profileError}
          </p>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-400 text-center">{error}</p>
        )}

        <div className="mt-8 pt-6 border-t border-white/10">
          <div className="flex items-start gap-3 text-xs text-gray-400">
            <Map className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
            <p>
              New users will be marked as <strong>pending</strong>. An administrator must approve your account before you can view the map.
            </p>
          </div>
          <div className="flex items-start gap-3 text-xs text-gray-400 mt-3">
            <LogIn className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" />
            <p>
              Already approved? After signing in, you will be redirected to the map automatically.
            </p>
          </div>
        </div>

        <p className="mt-8 text-[11px] text-center text-gray-500">
          <Link href="/" className="hover:text-gray-300 underline underline-offset-2">
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}