'use client';

import { useState, useEffect } from 'react';
import { db } from '@/lib/firebase';
import { firebaseConfig } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, deleteDoc, query, orderBy } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { Users, Plus, Trash2, CheckCircle, AlertTriangle, X, Shield, User } from 'lucide-react';

export interface SystemUser {
  id: string; // The firebase Auth UID
  name: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: number;
}

export function AdminUsers() {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Form State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  
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

  useEffect(() => {
    fetchUsers();
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
      setIsFormOpen(false);
      setName('');
      setEmail('');
      setPassword('');
      setRole('user');
      fetchUsers();
    } catch (err: any) {
      console.error(err);
      setToast({ type: 'error', message: err.message || 'Error creating user' });
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
          onClick={() => setIsFormOpen(!isFormOpen)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-all flex items-center gap-2"
        >
          {isFormOpen ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {isFormOpen ? 'Cancel' : 'New User'}
        </button>
      </div>

      {isFormOpen && (
        <form onSubmit={handleCreateUser} className="bg-surface border border-border-subtle rounded-2xl p-6 space-y-4">
          <h4 className="font-semibold text-white">Register New User</h4>
          
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

          <div className="flex justify-end pt-4 border-t border-border-subtle">
            <button
              type="submit"
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded-lg font-semibold text-sm transition-all"
            >
              Create User
            </button>
          </div>
        </form>
      )}

      <div className="bg-surface border border-border-subtle rounded-2xl overflow-hidden">
        {users.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No users created yet.
          </div>
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
                <tr key={user.id} className="hover:bg-white/5">
                  <td className="px-6 py-4 text-white font-medium">{user.name}</td>
                  <td className="px-6 py-4 text-gray-300">{user.email}</td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                      user.role === 'admin' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                    }`}>
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
              ))}
            </tbody>
          </table>
        )}
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2 transition-all ${
            toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
