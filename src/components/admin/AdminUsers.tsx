'use client';

import { useState, useEffect, Fragment } from 'react';
import { db } from '@/lib/firebase';
import { firebaseConfig } from '@/lib/firebase';
import {
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  deleteField,
  query,
  orderBy,
} from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import type { UserSubscription } from '@/lib/authContext';
import {
  Users,
  Plus,
  Trash2,
  CheckCircle,
  AlertTriangle,
  X,
  Shield,
  User,
  Building,
  Mail,
  Crown,
  ChevronDown,
} from 'lucide-react';

export interface SystemUser {
  id: string; // The firebase Auth UID
  name: string;
  email: string;
  role: 'admin' | 'user';
  /** Individual subscription (company seats inherit the company's instead). */
  subscription?: UserSubscription;
  createdAt: number;
}

export interface CompanyAccount {
  id: string;
  name: string;
  ownerEmail: string;
  /** Every email allowed to sign in under this company (lowercased, includes ownerEmail). */
  employees: string[];
  /** Company-wide subscription inherited by every employee seat. */
  subscription?: UserSubscription;
  createdAt: number;
}

type AccountMode = 'individual' | 'company';

function parseEmailList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /.+@.+\..+/.test(e))
    )
  );
}

const SUBSCRIPTION_PLANS = ['Basic', 'Pro', 'Enterprise'] as const;
const SUBSCRIPTION_STATUSES: NonNullable<UserSubscription['status']>[] = ['active', 'trial', 'expired'];

/** Inline editor for the subscription stored on a `users` or `companies` doc. */
function SubscriptionEditor({
  initial,
  onSave,
}: {
  initial?: UserSubscription;
  onSave: (sub: UserSubscription | null) => Promise<void>;
}) {
  const [plan, setPlan] = useState<string>(initial?.plan || '');
  const [status, setStatus] = useState<NonNullable<UserSubscription['status']>>(
    initial?.status || 'active'
  );
  const [expires, setExpires] = useState<string>(
    initial?.expiresAt ? new Date(initial.expiresAt).toISOString().slice(0, 10) : ''
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (!plan) {
        await onSave(null);
      } else {
        await onSave({
          plan,
          status,
          startedAt: initial?.startedAt,
          expiresAt: expires ? new Date(`${expires}T23:59:59`).getTime() : undefined,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
        <Crown className="w-3.5 h-3.5 text-amber-400" /> Subscription
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          <option value="">No subscription</option>
          {SUBSCRIPTION_PLANS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as NonNullable<UserSubscription['status']>)}
          className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          {SUBSCRIPTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          className="bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        />
      </div>
      <button
        onClick={handleSave}
        disabled={saving}
        className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors"
      >
        {saving ? 'Saving…' : 'Save subscription'}
      </button>
    </div>
  );
}

export function AdminUsers() {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [companies, setCompanies] = useState<CompanyAccount[]>([]);
  const [loading, setLoading] = useState(true);

  // Form State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [mode, setMode] = useState<AccountMode>('individual');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  // Company fields
  const [companyName, setCompanyName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [employeesText, setEmployeesText] = useState('');

  // Expanded company row (employee management)
  const [expandedCompanyId, setExpandedCompanyId] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [newEmployeeEmail, setNewEmployeeEmail] = useState('');

  const saveCompanySubscription = async (companyId: string, sub: UserSubscription | null) => {
    try {
      await updateDoc(doc(db, 'companies', companyId), {
        subscription: sub ?? deleteField(),
      });
      setToast({
        type: 'success',
        message: sub ? `Subscription saved (${sub.plan})` : 'Subscription removed',
      });
      fetchCompanies();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error saving subscription' });
    }
  };

  const saveUserSubscription = async (uid: string, sub: UserSubscription | null) => {
    try {
      await updateDoc(doc(db, 'users', uid), {
        subscription: sub ?? deleteField(),
      });
      setToast({
        type: 'success',
        message: sub ? `Subscription saved (${sub.plan})` : 'Subscription removed',
      });
      fetchUsers();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error saving subscription' });
    }
  };

  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchUsers = async () => {
    try {
      const q = query(collection(db, 'users'), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const fetchedUsers = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      })) as SystemUser[];
      setUsers(fetchedUsers);
    } catch (err) {
      console.error('Error fetching users', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCompanies = async () => {
    try {
      const snapshot = await getDocs(collection(db, 'companies'));
      const fetched = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as CompanyAccount[];
      setCompanies(fetched.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    } catch (err) {
      console.error('Error fetching companies', err);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchCompanies();
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password) return;

    try {
      // TRICK: Initialize a secondary app to create a user without logging out the admin
      const secondaryAppName = `SecondaryApp-${Date.now()}`;
      const secondaryApp = initializeApp(firebaseConfig, secondaryAppName);
      const secondaryAuth = getAuth(secondaryApp);

      // Create the user in Firebase Auth
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      const newUid = userCredential.user.uid;

      // Sign out the secondary app and delete it to clean up
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      // Save the user's role and name to Firestore 'users' collection
      const newUser: SystemUser = {
        id: newUid,
        name,
        email,
        role,
        createdAt: Date.now(),
      };

      await setDoc(doc(db, 'users', newUid), newUser);

      setToast({ type: 'success', message: 'User created successfully!' });
      resetForm();
      fetchUsers();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error creating user' });
    }
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() || !ownerEmail.trim()) return;

    const owner = ownerEmail.trim().toLowerCase();
    const employees = Array.from(new Set([owner, ...parseEmailList(employeesText)]));

    try {
      const newCompany: CompanyAccount = {
        id: crypto.randomUUID(),
        name: companyName.trim(),
        ownerEmail: owner,
        employees,
        createdAt: Date.now(),
      };
      await setDoc(doc(db, 'companies', newCompany.id), newCompany);

      setToast({
        type: 'success',
        message: `Company created. ${employees.length} email${employees.length !== 1 ? 's' : ''} can now sign in with Gmail.`,
      });
      resetForm();
      fetchCompanies();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error creating company' });
    }
  };

  const resetForm = () => {
    setIsFormOpen(false);
    setMode('individual');
    setName('');
    setEmail('');
    setPassword('');
    setRole('user');
    setCompanyName('');
    setOwnerEmail('');
    setEmployeesText('');
  };

  const addEmployee = async (company: CompanyAccount) => {
    const parsed = parseEmailList(newEmployeeEmail);
    if (parsed.length === 0) {
      setToast({ type: 'error', message: 'Enter a valid email address' });
      return;
    }
    try {
      await updateDoc(doc(db, 'companies', company.id), {
        employees: arrayUnion(...parsed),
      });
      setNewEmployeeEmail('');
      setToast({
        type: 'success',
        message: `${parsed.length} employee(s) added — they can sign in with Gmail now.`,
      });
      fetchCompanies();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error adding employee' });
    }
  };

  const removeEmployee = async (companyId: string, employeeEmail: string) => {
    try {
      await updateDoc(doc(db, 'companies', companyId), {
        employees: arrayRemove(employeeEmail),
      });
      setToast({ type: 'success', message: `${employeeEmail} removed from the company` });
      fetchCompanies();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error removing employee' });
    }
  };

  const deleteCompanyWithConfirm = (id: string) => {
    if (!confirm('Delete this company account? All its employees will lose access on their next sign-in check.')) return;
    deleteCompany(id);
  };

  const deleteCompany = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'companies', id));
      fetchCompanies();
      setToast({ type: 'success', message: 'Company deleted' });
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error deleting company' });
    }
  };

  const deleteUser = async (id: string) => {
    if (!confirm('Are you sure you want to delete this user record? (This only deletes their profile, not their Auth credential)')) return;
    try {
      await deleteDoc(doc(db, 'users', id));
      fetchUsers();
      setToast({ type: 'success', message: 'User record deleted' });
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: 'Failed to delete user' });
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-400">Loading Users...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-400" /> System Users
          </h3>
          <p className="text-sm text-gray-400">Manage who can access the system</p>
        </div>
        <button
          onClick={() => (isFormOpen ? resetForm() : setIsFormOpen(true))}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-all flex items-center gap-2"
        >
          {isFormOpen ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {isFormOpen ? 'Cancel' : 'New User'}
        </button>
      </div>

      {isFormOpen && (
        <form
          onSubmit={mode === 'individual' ? handleCreateUser : handleCreateCompany}
          className="bg-surface border border-border-subtle rounded-2xl p-6 space-y-4"
        >
          <h4 className="font-semibold text-white">
            {mode === 'individual' ? 'Register New User' : 'Create Company (Multi-Access)'}
          </h4>

          {/* Mode selector */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode('individual')}
              className={`rounded-xl border p-4 text-left transition-colors ${
                mode === 'individual'
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-border-subtle bg-background hover:border-white/30'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <User className="w-4 h-4" /> Individual
              </div>
              <p className="text-xs text-gray-400 mt-1">One person, created with email + password.</p>
            </button>
            <button
              type="button"
              onClick={() => setMode('company')}
              className={`rounded-xl border p-4 text-left transition-colors ${
                mode === 'company'
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-border-subtle bg-background hover:border-white/30'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Building className="w-4 h-4" /> Company
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Multi-access: every employee signs in with their own Gmail.
              </p>
            </button>
          </div>

          {mode === 'individual' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Full Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Email Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="john@example.com"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                >
                  <option value="user">Standard User</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Company Name</label>
                <input
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Realty"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Owner Email</label>
                <input
                  type="email"
                  required
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  placeholder="owner@acmerealty.com"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="text-xs font-medium text-gray-400 block mb-1.5">
                  Employee Emails (one per line — they sign in with their own Gmail)
                </label>
                <textarea
                  value={employeesText}
                  onChange={(e) => setEmployeesText(e.target.value)}
                  rows={4}
                  placeholder={'agent1@acmerealty.com\nagent2@acmerealty.com'}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
                <p className="text-[11px] text-gray-500 mt-1.5">
                  {parseEmailList(employeesText).length + (ownerEmail.trim() ? 1 : 0)} email(s) will get
                  access, including the owner. You can add or remove employees later.
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-4 border-t border-border-subtle">
            <button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded-lg font-semibold text-sm transition-all"
            >
              {mode === 'individual' ? 'Create User' : 'Create Company'}
            </button>
          </div>
        </form>
      )}

      {/* Company accounts (multi-access) */}
      <div>
        <h4 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
          <Building className="w-4 h-4 text-blue-400" /> Company Accounts
          <span className="text-xs font-medium text-gray-500">
            (multi-access — employees sign in with Gmail)
          </span>
        </h4>
        {companies.length === 0 ? (
          <div className="bg-surface border border-border-subtle rounded-2xl text-center py-8 text-gray-500 text-sm">
            No company accounts yet. Create one to give a whole team access.
          </div>
        ) : (
          <div className="space-y-3">
            {companies.map((company) => (
              <div
                key={company.id}
                className="bg-surface border border-border-subtle rounded-2xl overflow-hidden"
              >
                <div className="flex items-center justify-between gap-4 p-4">
                  <button
                    onClick={() =>
                      setExpandedCompanyId(expandedCompanyId === company.id ? null : company.id)
                    }
                    className="flex items-center gap-3 text-left flex-1 min-w-0"
                  >
                    <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center shrink-0">
                      <Building className="w-4 h-4 text-blue-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-white font-semibold truncate">{company.name}</div>
                      <div className="text-xs text-gray-400 flex items-center gap-1.5">
                        <Mail className="w-3 h-3" /> {company.ownerEmail}
                        <span className="text-gray-600">·</span>
                        {company.employees.length} seat{company.employees.length !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </button>
                  <button
                    onClick={() => deleteCompanyWithConfirm(company.id)}
                    className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors shrink-0"
                    title="Delete Company"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {expandedCompanyId === company.id && (
                  <div className="border-t border-border-subtle bg-background/60 p-4 space-y-3">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                      Authorized emails
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {company.employees.map((emp) => (
                        <span
                          key={emp}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                            emp === company.ownerEmail
                              ? 'bg-purple-500/20 text-purple-300'
                              : 'bg-blue-500/15 text-blue-300'
                          }`}
                        >
                          {emp}
                          {emp === company.ownerEmail && <Shield className="w-3 h-3" />}
                          <button
                            onClick={() => removeEmployee(company.id, emp)}
                            className="hover:text-white"
                            title="Remove access"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="email"
                        value={newEmployeeEmail}
                        onChange={(e) => setNewEmployeeEmail(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addEmployee(company);
                          }
                        }}
                        placeholder="new.employee@company.com"
                        className="flex-1 bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                      />
                      <button
                        onClick={() => addEmployee(company)}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add
                      </button>
                    </div>

                    <div className="border-t border-border-subtle pt-3">
                      <SubscriptionEditor
                        initial={company.subscription as UserSubscription | undefined}
                        onSave={(sub) => saveCompanySubscription(company.id, sub)}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Individual users */}
      <div>
        <h4 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
          <User className="w-4 h-4 text-purple-400" /> Individual Users
        </h4>
        <div className="bg-surface border border-border-subtle rounded-2xl overflow-hidden">
          {users.length === 0 ? (
            <div className="text-center py-12 text-gray-500">No users created yet.</div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-background border-b border-border-subtle">
                <tr>
                  <th className="px-6 py-3 text-gray-400 font-medium">Name</th>
                  <th className="px-6 py-3 text-gray-400 font-medium">Email</th>
                  <th className="px-6 py-3 text-gray-400 font-medium">Role</th>
                  <th className="px-6 py-3 text-right text-gray-400 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {users.map((user) => (
                  <Fragment key={user.id}>
                    <tr className="hover:bg-white/5">
                      <td className="px-6 py-4 text-white font-medium">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setExpandedUserId(expandedUserId === user.id ? null : user.id)}
                            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                            title="Manage subscription"
                          >
                            <ChevronDown
                              className={`w-4 h-4 transition-transform ${
                                expandedUserId === user.id ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                          {user.name}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-gray-300">
                        <div className="flex items-center gap-2">
                          {user.email}
                          {user.subscription?.plan && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/15 text-amber-300">
                              <Crown className="w-3 h-3" /> {user.subscription.plan}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                            user.role === 'admin'
                              ? 'bg-purple-500/20 text-purple-400'
                              : 'bg-blue-500/20 text-blue-400'
                          }`}
                        >
                          {user.role === 'admin' ? <Shield className="w-3 h-3" /> : <User className="w-3 h-3" />}
                          {user.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => deleteUser(user.id)}
                          className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                          title="Delete User Record"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                    {expandedUserId === user.id && (
                      <tr>
                        <td colSpan={4} className="px-6 py-4 bg-background/60">
                          <SubscriptionEditor
                            initial={user.subscription as UserSubscription | undefined}
                            onSave={(sub) => saveUserSubscription(user.id, sub)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2 transition-all ${
            toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertTriangle className="w-4 h-4" />
          )}
          {toast.message}
        </div>
      )}
    </div>
  );
}