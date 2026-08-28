'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import {
  X,
  LogOut,
  ShieldCheck,
  ShieldAlert,
  Crown,
  Building,
  CalendarClock,
  Loader2,
  Save,
} from 'lucide-react';
import { useAuth } from '@/lib/authContext';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  mode?: 'account' | 'save';
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function AccountModal({ open, onClose, mode = 'account' }: AccountModalProps) {
  const { user, profile, loading, isAdmin, signInWithGoogle, signOut } = useAuth();

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const subscription = profile?.subscription;
  const expiresAt = subscription?.expiresAt;
  const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / 86_400_000) : null;
  const isExpired = daysLeft !== null && daysLeft < 0;
  const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#121620] border border-white/[0.08] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/[0.06] bg-white/[0.04]">
          <h2 className="text-lg font-bold text-white">
            {mode === 'save' && !user ? 'Save Report' : 'My Account'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Not signed in → sign-in prompt */}
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Checking your account…</span>
            </div>
          ) : !user ? (
            <>
              {mode === 'save' && (
                <div className="bg-blue-900/20 border border-blue-500/30 p-3 rounded-lg text-sm text-blue-200 flex items-start gap-2">
                  <Save className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                  <p>You need to be logged in to save reports and retain your search history.</p>
                </div>
              )}
              <p className="text-sm text-gray-400">
                Sign in with your Google account to see your subscription and account details.
              </p>
              <button
                onClick={() => signInWithGoogle()}
                className="w-full flex items-center justify-center gap-3 px-5 py-3 rounded-xl bg-white text-[#0a0c10] font-semibold hover:bg-gray-100 transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5">
                  <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.28 1.4-1.07 2.59-2.27 3.4v2.81h3.66c2.16-1.99 3.43-4.91 3.43-8.45z"/>
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.66-2.81c-1.07.72-2.45 1.15-4.27 1.15-3.27 0-6.04-2.21-7.03-5.18H1.18v3.25C3.16 21.43 7.27 24 12 24z"/>
                  <path fill="#FBBC05" d="M4.97 14.18c-.25-.72-.39-1.49-.39-2.18s.14-1.46.39-2.18V6.57H1.18C.43 8.16 0 9.97 0 12s.43 3.84 1.18 5.43l3.79-3.25z"/>
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.81l3.42-3.42C17.95 1.16 15.24 0 12 0 7.27 0 3.16 2.57 1.18 6.57l3.79 3.25C5.96 6.96 8.73 4.75 12 4.75z"/>
                </svg>
                Continue with Google
              </button>
            </>
          ) : (
            <>
              {/* Profile */}
              <div className="flex items-center gap-4">
                {user.photoURL ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'User'}
                    className="w-14 h-14 rounded-2xl border border-white/10 object-cover"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-xl font-bold text-emerald-300">
                    {(user.displayName || user.email || '?').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-white font-bold truncate">
                    {profile?.displayName || user.displayName || 'User'}
                  </div>
                  <div className="text-sm text-gray-400 truncate">{user.email}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        isAdmin
                          ? 'bg-purple-500/20 text-purple-300'
                          : 'bg-blue-500/15 text-blue-300'
                      }`}
                    >
                      {isAdmin ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
                      {isAdmin ? 'Administrator' : profile?.authorized ? 'Approved' : 'Pending'}
                    </span>
                    {profile?.companyName && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/15 text-emerald-300">
                        <Building className="w-3 h-3" /> {profile.companyName}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Subscription */}
              <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Crown className="w-4 h-4 text-amber-400" /> Subscription
                  </h3>
                  {subscription?.plan ? (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        isExpired
                          ? 'bg-red-500/15 text-red-300'
                          : isExpiringSoon
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      {isExpired ? 'Expired' : isExpiringSoon ? 'Expiring soon' : subscription.status || 'Active'}
                    </span>
                  ) : null}
                </div>

                {subscription?.plan ? (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="text-2xl font-bold text-white">{subscription.plan}</span>
                      {daysLeft !== null && (
                        <span
                          className={`text-xs font-semibold ${
                            isExpired ? 'text-red-400' : isExpiringSoon ? 'text-amber-300' : 'text-gray-400'
                          }`}
                        >
                          {isExpired
                            ? `Expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? 's' : ''} ago`
                            : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <CalendarClock className="w-3.5 h-3.5" />
                      Renews / expires on{' '}
                      <span className="text-gray-200 font-medium">{formatDate(expiresAt)}</span>
                    </div>
                    {/* Progress bar for the current period */}
                    {subscription.startedAt && expiresAt && expiresAt > subscription.startedAt && (
                      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            isExpired ? 'bg-red-500' : isExpiringSoon ? 'bg-amber-400' : 'bg-emerald-400'
                          }`}
                          style={{
                            width: `${Math.min(
                              100,
                              Math.max(
                                0,
                                ((Date.now() - subscription.startedAt) / (expiresAt - subscription.startedAt)) * 100
                              )
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-gray-400">
                    No active subscription on this account. Upgrade to unlock more reports and areas.
                  </p>
                )}

                <Link
                  href="/pricing"
                  className="block text-center text-sm font-semibold px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                >
                  {subscription?.plan ? 'Manage subscription' : 'View plans'}
                </Link>
              </div>

              {/* Account meta */}
              <div className="text-[11px] text-gray-500 grid grid-cols-2 gap-2">
                <div>
                  <span className="uppercase tracking-wider font-bold">Member since</span>
                  <div className="text-gray-300 text-xs mt-0.5">{formatDate(profile?.createdAt)}</div>
                </div>
                <div>
                  <span className="uppercase tracking-wider font-bold">Last sign-in</span>
                  <div className="text-gray-300 text-xs mt-0.5">{formatDate(profile?.lastLogin)}</div>
                </div>
              </div>

              <button
                onClick={() => {
                  signOut();
                  onClose();
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-white/10 text-gray-300 hover:bg-white/5 transition-colors text-sm font-semibold"
              >
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}