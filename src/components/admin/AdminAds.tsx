'use client';

import { useState, useEffect, useRef } from 'react';
import { db, storage } from '@/lib/firebase';
import { collection, getDocs, doc, setDoc, deleteDoc, updateDoc, query, orderBy } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { Megaphone, Plus, Image as ImageIcon, Link as LinkIcon, Trash2, CheckCircle, AlertTriangle, Upload, X } from 'lucide-react';

export interface AdCampaign {
  id: string;
  title: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  targetUrl: string;
  beneficiaryName?: string;
  status: 'active' | 'inactive';
  createdAt: number;
}

export function AdminAds() {
  const [ads, setAds] = useState<AdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Form State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAds = async () => {
    try {
      const q = query(collection(db, 'ads'), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const fetchedAds = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      })) as AdCampaign[];
      setAds(fetchedAds);
    } catch (err) {
      console.error('Error fetching ads', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAds();
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleCreateAd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !mediaFile) return;

    try {
      const isVideo = mediaFile.type.startsWith('video/');
      const fileExt = mediaFile.name.split('.').pop();
      const fileName = `ads/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const storageRef = ref(storage, fileName);

      const uploadTask = uploadBytesResumable(storageRef, mediaFile);

      uploadTask.on(
        'state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          setUploadProgress(progress);
        },
        (error) => {
          console.error(error);
          setToast({ type: 'error', message: 'Failed to upload media' });
          setUploadProgress(null);
        },
        async () => {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          
          const newAd: AdCampaign = {
            id: crypto.randomUUID(),
            title,
            mediaUrl: downloadURL,
            mediaType: isVideo ? 'video' : 'image',
            targetUrl,
            beneficiaryName,
            status: 'inactive', // Default to inactive when created
            createdAt: Date.now(),
          };

          await setDoc(doc(db, 'ads', newAd.id), newAd);
          setToast({ type: 'success', message: 'Ad campaign created!' });
          setIsFormOpen(false);
          setUploadProgress(null);
          setTitle('');
          setBeneficiaryName('');
          setTargetUrl('');
          setMediaFile(null);
          fetchAds();
        }
      );
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: 'Error creating ad' });
    }
  };

  const toggleStatus = async (ad: AdCampaign) => {
    try {
      const newStatus = ad.status === 'active' ? 'inactive' : 'active';
      // Usually, if there's only one slot, we deactivate the rest. Let's deactivate all others if we set this to active.
      if (newStatus === 'active') {
        const batchUpdates = ads.map(async (a) => {
          if (a.id !== ad.id && a.status === 'active') {
            await updateDoc(doc(db, 'ads', a.id), { status: 'inactive' });
          }
        });
        await Promise.all(batchUpdates);
      }
      
      await updateDoc(doc(db, 'ads', ad.id), { status: newStatus });
      fetchAds();
      setToast({ type: 'success', message: `Ad is now ${newStatus}` });
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: 'Failed to update status' });
    }
  };

  const deleteAd = async (id: string) => {
    if (!confirm('Are you sure you want to delete this ad?')) return;
    try {
      await deleteDoc(doc(db, 'ads', id));
      fetchAds();
      setToast({ type: 'success', message: 'Ad deleted' });
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: 'Failed to delete ad' });
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-400">Loading Ads...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-purple-400" /> Advertising Campaigns
          </h3>
          <p className="text-sm text-gray-400">Manage banner and video ads shown on the map</p>
        </div>
        <button
          onClick={() => setIsFormOpen(!isFormOpen)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-all flex items-center gap-2"
        >
          {isFormOpen ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {isFormOpen ? 'Cancel' : 'New Campaign'}
        </button>
      </div>

      {isFormOpen && (
        <form onSubmit={handleCreateAd} className="bg-surface border border-border-subtle rounded-2xl p-6 space-y-4">
          <h4 className="font-semibold text-white">Create New Ad Campaign</h4>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Campaign Title</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Summer Sale 2026"
                className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
              />
            </div>
            
            <div>
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Name of Beneficiary</label>
              <input
                type="text"
                value={beneficiaryName}
                onChange={(e) => setBeneficiaryName(e.target.value)}
                placeholder="e.g. Susy"
                className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
              />
            </div>
            
            <div className="md:col-span-2">
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Link or Phone Number (Where they go when clicked)</label>
              <div className="relative">
                <LinkIcon className="w-4 h-4 absolute left-3 top-2.5 text-gray-500" />
                <input
                  type="text"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://example.com or +1 555-0123"
                  className="w-full bg-background border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="text-xs font-medium text-gray-400 block mb-1.5">Media Upload (Image, GIF, MP4)</label>
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-border-subtle hover:border-purple-500 rounded-xl p-8 text-center cursor-pointer transition-colors bg-background"
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => setMediaFile(e.target.files?.[0] || null)}
                  accept="image/*,video/mp4"
                  className="hidden"
                />
                {mediaFile ? (
                  <div className="flex flex-col items-center gap-2 text-purple-400">
                    <CheckCircle className="w-8 h-8" />
                    <span className="text-sm font-medium">{mediaFile.name}</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-gray-400">
                    <Upload className="w-8 h-8" />
                    <span className="text-sm">Click to browse or drag file here</span>
                    <span className="text-xs text-gray-500">Recommended ratio 16:9. Max size 20MB.</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-border-subtle">
            <button
              type="submit"
              disabled={uploadProgress !== null}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-semibold text-sm transition-all"
            >
              {uploadProgress !== null ? `Uploading ${Math.round(uploadProgress)}%` : 'Create Campaign'}
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {ads.length === 0 && !isFormOpen && (
          <div className="col-span-full text-center py-12 text-gray-500 border border-border-subtle rounded-2xl bg-surface">
            No advertising campaigns yet. Click "New Campaign" to create one.
          </div>
        )}
        
        {ads.map((ad) => (
          <div key={ad.id} className="bg-surface border border-border-subtle rounded-2xl overflow-hidden flex flex-col group relative">
            <div className="aspect-video bg-black relative flex items-center justify-center border-b border-border-subtle overflow-hidden">
              {ad.mediaType === 'video' ? (
                <video src={ad.mediaUrl} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" muted loop autoPlay playsInline />
              ) : (
                <img src={ad.mediaUrl} alt={ad.title} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
              )}
              
              <div className="absolute top-3 right-3 flex items-center gap-2">
                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                  ad.status === 'active' ? 'bg-emerald-500 text-white shadow-lg' : 'bg-gray-800 text-gray-400'
                }`}>
                  {ad.status}
                </span>
              </div>
            </div>
            
            <div className="p-4 flex-1 flex flex-col space-y-3">
              <div>
                <h5 className="font-bold text-white truncate" title={ad.title}>{ad.title}</h5>
                {ad.beneficiaryName && (
                  <p className="text-sm text-gray-400">Beneficiary: {ad.beneficiaryName}</p>
                )}
              </div>
              <a 
                href={ad.targetUrl.startsWith('+') || /^\d/.test(ad.targetUrl) ? `tel:${ad.targetUrl}` : ad.targetUrl} 
                target="_blank" 
                rel="noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300 truncate flex items-center gap-1"
              >
                <LinkIcon className="w-3 h-3" /> {ad.targetUrl || 'No link provided'}
              </a>
              
              <div className="mt-auto flex items-center justify-between pt-4 border-t border-white/5">
                <button
                  onClick={() => toggleStatus(ad)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                    ad.status === 'active' 
                      ? 'bg-gray-700 hover:bg-gray-600 text-white' 
                      : 'bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30'
                  }`}
                >
                  {ad.status === 'active' ? 'Deactivate' : 'Set Active'}
                </button>
                
                <button
                  onClick={() => deleteAd(ad.id)}
                  className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                  title="Delete Campaign"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
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
