import { useState } from 'react';
import { X, Save, Search, Users, Lock } from 'lucide-react';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  mode?: 'account' | 'save';
}

export default function AccountModal({ open, onClose, mode = 'account' }: AccountModalProps) {
  const [isLogin, setIsLogin] = useState(false);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in">
      <div className="bg-[#121620] border border-white/[0.06] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95">
        <div className="flex items-center justify-between p-4 border-b border-white/[0.06] bg-white/5">
          <h2 className="text-lg font-bold text-white">
            {mode === 'save' ? 'Save Report' : isLogin ? 'Welcome Back' : 'Create an Account'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {mode === 'save' && (
            <div className="bg-blue-900/20 border border-blue-500/30 p-3 rounded-lg text-sm text-blue-200 flex items-start gap-2">
              <Save className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
              <p>You need to be logged in to save reports and retain your search history.</p>
            </div>
          )}

          <div className="space-y-4">
            {!isLogin && (
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1">Full Name</label>
                <input
                  type="text"
                  placeholder="John Doe"
                  className="w-full bg-[#1a1f2e] border border-white/[0.06] text-white rounded-lg px-3 py-2 outline-none focus:border-blue-500"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1">Email</label>
              <input
                type="email"
                placeholder="you@example.com"
                className="w-full bg-[#1a1f2e] border border-white/[0.06] text-white rounded-lg px-3 py-2 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1">Password</label>
              <input
                type="password"
                placeholder="••••••••"
                className="w-full bg-[#1a1f2e] border border-white/[0.06] text-white rounded-lg px-3 py-2 outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg shadow-lg transition-transform hover:scale-[1.02]">
            {isLogin ? 'Sign In' : 'Create Account'}
          </button>

          {!isLogin && (
            <div className="bg-[#1a1f2e] border border-white/[0.06] rounded-xl p-4 space-y-3">
              <h3 className="text-sm font-semibold text-white mb-2 border-b border-white/[0.06] pb-2">Account Features</h3>
              
              <div className="flex gap-3 text-sm text-gray-400">
                <Search className="w-4 h-4 text-emerald-400 shrink-0" />
                <p>Log and access your recent searches.</p>
              </div>
              
              <div className="flex gap-3 text-sm text-gray-400">
                <Save className="w-4 h-4 text-emerald-400 shrink-0" />
                <p>Save reports and forecast comparisons securely.</p>
              </div>

              <div className="flex gap-3 text-sm text-amber-200/80 bg-amber-900/20 p-2 rounded-lg border border-amber-500/20">
                <Users className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-amber-400 flex items-center gap-2">
                    Give Access <span className="text-[10px] bg-amber-500 text-amber-950 px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-bold">Coming Soon</span>
                  </p>
                  <p className="text-xs mt-1 leading-relaxed text-amber-200/70">
                    Prompt a client to create their own account. The person who grants access can view what they see AND decide to revoke access at any time.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="text-center text-sm text-gray-400 pt-2 border-t border-white/[0.06]">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button
              onClick={() => setIsLogin(!isLogin)}
              className="text-blue-400 hover:text-white font-semibold underline"
            >
              {isLogin ? 'Sign Up' : 'Log In'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
