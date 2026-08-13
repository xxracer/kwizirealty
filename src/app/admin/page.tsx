'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import {
  cmsStore,
  type CMSFileRecord,
  type CMSMetricOverride,
  type CMSPropertyOverride,
  type CMSStoreSummary,
  type CMSFileCategory,
} from '@/lib/cmsStore';
import { engine, type BoundaryKey, type MetricKey, type PropertyData } from '@/lib/engine';
import {
  Upload,
  FileSpreadsheet,
  Database,
  Trash2,
  ArrowLeft,
  RefreshCw,
  Download,
  AlertTriangle,
  CheckCircle,
  Eye,
  X,
  Search,
  BarChart3,
  Map,
  SlidersHorizontal,
  Save,
  Home,
  TrendingUp,
  DollarSign,
  Building,
  School,
  FileText,
  Layers,
  Pencil,
  ChevronRight,
  Plus,
  ChevronDown,
} from 'lucide-react';

type AdminSection = 'dashboard' | 'sales' | 'rent' | 'current' | 'tax' | 'schools' | 'boundaries' | 'areas';
type DataTab = 'upload' | 'edit';
type PropertyEditMode = 'edit' | 'create';

const REQUIRED_PROPERTY_HEADERS = [
  'MLS Number',
  'Address',
  'City/Location',
  'State Or Province',
  'Zip',
  'Close Price',
  'Latitude',
  'Longitude',
];
const REQUIRED_SCHOOL_HEADERS = ['school_name_clean', 'Overall Score'];
const REQUIRED_TAX_HEADERS = ['MLS #', 'Parcel ID', 'Address'];

const BOUNDARY_OPTIONS: { value: BoundaryKey; label: string }[] = [
  { value: 'zipcodes', label: 'ZIP Code' },
  { value: 'subdivisions', label: 'Subdivision' },
  { value: 'highschools', label: 'High School District' },
  { value: 'elementary', label: 'Elementary School' },
  { value: 'middle', label: 'Middle School' },
  { value: 'neighborhoods', label: 'Neighborhood' },
];

const METRIC_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: 'Close Price', label: 'Median Close Price' },
  { value: 'Price per Sqft', label: 'Median Price per Sqft' },
  { value: 'List-to-Sale Ratio', label: 'List-to-Sale Ratio %' },
  { value: 'Days on Market', label: 'Median Days on Market' },
  { value: 'Est. Rental Price', label: 'Estimated Rental Price' },
  { value: 'Rent-to-Sale Ratio', label: 'Rent-to-Sale Ratio' },
  { value: 'Lot Size', label: 'Median Lot Size' },
  { value: 'Annual HOA Fee', label: 'Annual HOA Fee' },
  { value: 'Appreciation Rate', label: 'Appreciation Rate %' },
  { value: 'Investor Index', label: 'Investor Index' },
  { value: 'Elem ETA Score', label: 'Elementary School Score' },
  { value: 'Middle ETA Score', label: 'Middle School Score' },
  { value: 'High ETA Score', label: 'High School Score' },
];

const SECTIONS: { id: AdminSection; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <Home className="w-4 h-4" />, desc: 'Overview of all data' },
  { id: 'sales', label: 'Sales Data', icon: <TrendingUp className="w-4 h-4" />, desc: 'Sold prices & history' },
  { id: 'rent', label: 'Rent Data', icon: <DollarSign className="w-4 h-4" />, desc: 'Rental prices & history' },
  { id: 'current', label: 'Current Listings', icon: <Building className="w-4 h-4" />, desc: 'Active for sale / for rent' },
  { id: 'tax', label: 'Tax Records', icon: <FileText className="w-4 h-4" />, desc: 'Assessed values & taxes' },
  { id: 'schools', label: 'School Ratings', icon: <School className="w-4 h-4" />, desc: 'TEA scores' },
  { id: 'areas', label: 'Area Metrics', icon: <Layers className="w-4 h-4" />, desc: 'Manual overrides' },
];

interface SectionConfig {
  title: string;
  subtitle: string;
  whatItModifies: string[];
  requiredColumns: string[];
  category: CMSFileCategory | CMSFileCategory[];
  fileHint: string;
}

const SECTION_CONFIG: Record<Exclude<AdminSection, 'dashboard' | 'areas'>, SectionConfig> = {
  sales: {
    title: 'Sales Data',
    subtitle: 'Manage sold property records.',
    whatItModifies: [
      'Median sold price per ZIP / subdivision',
      'Price per square foot trends',
      'Days on market',
      'List-to-sale ratio',
    ],
    requiredColumns: REQUIRED_PROPERTY_HEADERS,
    category: ['sales', 'property'],
    fileHint: 'Sale 2021 … Sale 2026 CSVs',
  },
  rent: {
    title: 'Rent Data',
    subtitle: 'Manage rental property records.',
    whatItModifies: [
      'Estimated rental price per area',
      'Rent-to-sale ratio',
      'Rental price per square foot',
    ],
    requiredColumns: REQUIRED_PROPERTY_HEADERS,
    category: ['rent', 'property'],
    fileHint: 'Rent 2021 … Rent 2026 CSVs',
  },
  current: {
    title: 'Current Listings',
    subtitle: 'Manage active for-sale and for-rent listings.',
    whatItModifies: [
      'Active listings on the map',
      'Current list prices',
      'HOA fees shown on property cards',
    ],
    requiredColumns: REQUIRED_PROPERTY_HEADERS,
    category: ['current-sale', 'current-rent', 'property'],
    fileHint: 'Current for Sale / Current for Rent CSVs',
  },
  tax: {
    title: 'Tax Records',
    subtitle: 'Manage tax records.',
    whatItModifies: [
      'Tax amount per property',
      'Tax rate per area',
      'Assessed values on property cards',
    ],
    requiredColumns: REQUIRED_TAX_HEADERS,
    category: 'tax',
    fileHint: 'Tax Data/2025 CSVs',
  },
  schools: {
    title: 'School Ratings',
    subtitle: 'Manage TEA school ratings.',
    whatItModifies: [
      'Elementary, middle and high school ETA scores',
      'School boundary colors on the map',
      'School filter options',
    ],
    requiredColumns: REQUIRED_SCHOOL_HEADERS,
    category: ['school-elementary', 'school-middle', 'school-high'],
    fileHint: 'TEA_Elem_School_Ratings.csv, TEA_Middle_School_Ratings.csv, TEA_High_School_Ratings.csv',
  },
  boundaries: {
    title: 'Map Boundaries',
    subtitle: 'Manage GeoJSON boundary files.',
    whatItModifies: [
      'Zip codes, subdivisions, and school zones drawn on the map',
      'Area boundary overlays',
    ],
    requiredColumns: [],
    category: 'boundary',
    fileHint: 'Zip.geojson, Houston_ISD.geojson, etc.',
  },
};

interface StagedFile {
  id: string;
  file: File;
  record: CMSFileRecord;
  stats: {
    total: number;
    new: number;
    existing: number;
  };
}

const FIELD_LABELS: Record<string, string> = {
  'Close Price': 'Close Price',
  'DOM': 'Days on Market (DOM)',
  'CDOM': 'Cumulative Days on Market (CDOM)',
  'Close Date': 'Close Date',
  'Est. Rental Price': 'Estimated Rental Price',
  'Rent-to-Sale Ratio': 'Rent-to-Sale Ratio',
  'Status': 'Listing Status',
  'Original List Price': 'Original List Price',
  'List Price': 'Current List Price',
  'Tax Year': 'Tax Year',
  'Tax Amount': 'Tax Amount',
  'Tax Rate': 'Tax Rate',
};

const SALES_QUICK_FIELDS = ['Close Price', 'DOM', 'CDOM', 'Close Date'];
const RENT_QUICK_FIELDS = ['Close Price', 'Est. Rental Price', 'Rent-to-Sale Ratio'];
const CURRENT_QUICK_FIELDS = ['Status', 'Original List Price', 'List Price'];
const TAX_QUICK_FIELDS = ['Tax Year', 'Tax Amount', 'Tax Rate'];

const getEngine = (): typeof engine =>
  (typeof window !== 'undefined' ? (window as any).__kwiziEngine : undefined) || engine;

const FIELD_TO_PROPERTY_KEY: Record<string, keyof PropertyData | undefined> = {
  'Close Price': 'closePrice',
  'DOM': 'dom',
  'CDOM': 'cdom',
  'Close Date': 'closeDate',
  'Est. Rental Price': 'closePrice',
  'Rent-to-Sale Ratio': undefined,
  'Status': undefined,
  'Original List Price': 'listPrice',
  'List Price': 'listPrice',
  'Tax Year': 'taxYear',
  'Tax Amount': 'taxAmount',
  'Tax Rate': 'taxRate',
};

function formatNumber(num: number): string {
  if (!isFinite(num)) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v && v.toUpperCase() !== 'NA' && v.toUpperCase() !== 'N/A'))).sort();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function validateHeaders(headers: string[] | undefined, required: string[]): { valid: boolean; missing: string[] } {
  const normalized = (headers || []).map((h) => h.trim().toLowerCase());
  const missing = required.filter((h) => !normalized.includes(h.toLowerCase()));
  return { valid: missing.length === 0, missing };
}

function detectCategory(fileName: string, section: AdminSection): CMSFileCategory {
  const parts = fileName.toLowerCase().split('/');
  
  // Evaluate from the innermost file/folder upwards
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (section === 'boundaries' || part.endsWith('.geojson') || part.endsWith('.json')) return 'boundary';
    if (section === 'tax' || part.includes('tax')) return 'tax';
    if (section === 'schools' || part.includes('school')) {
      if (part.includes('elem')) return 'school-elementary';
      if (part.includes('middle')) return 'school-middle';
      if (part.includes('high')) return 'school-high';
      if (section === 'schools') return 'school-elementary';
    }
    if (part.includes('current')) {
      if (part.includes('rent')) return 'current-rent';
      if (part.includes('sale')) return 'current-sale';
    }
    if (part.includes('rent')) return 'rent';
    if (part.includes('sale')) return 'sales';
  }
  
  return 'property';
}

type TreeNode = {
  name: string;
  files: Omit<CMSFileRecord, 'rows'>[];
  folders: { [key: string]: TreeNode };
};

function buildTree(files: Omit<CMSFileRecord, 'rows'>[]): TreeNode {
  const root: TreeNode = { name: 'Root', files: [], folders: {} };
  
  files.forEach(file => {
    const parts = file.name.split('/');
    if (parts.length === 1) {
      root.files.push(file);
      return;
    }
    
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      if (!current.folders[folderName]) {
        current.folders[folderName] = { name: folderName, files: [], folders: {} };
      }
      current = current.folders[folderName];
    }
    current.files.push(file);
  });
  
  return root;
}

function FolderNode({ node, path, onPreview, onDelete }: { node: TreeNode, path: string, onPreview: (f: any) => void, onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  
  const hasChildren = node.files.length > 0 || Object.keys(node.folders).length > 0;
  if (!hasChildren) return null;

  return (
    <div className="ml-4 first:ml-0">
      {path !== '' && (
        <div 
          className="flex items-center gap-2 py-2 cursor-pointer text-gray-300 hover:text-white transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-gray-500 w-4">{expanded ? '▼' : '▶'}</span>
          <span className="text-blue-400">📁</span>
          <span className="font-semibold text-sm">{node.name}</span>
          <span className="text-xs text-gray-500">
            ({node.files.length} files, {Object.keys(node.folders).length} folders)
          </span>
        </div>
      )}
      
      {expanded && (
        <div className={path !== '' ? 'border-l border-border-subtle ml-2 pl-4 mt-1 space-y-2' : 'space-y-2'}>
          {Object.values(node.folders).map(folder => (
            <FolderNode key={folder.name} node={folder} path={`${path}/${folder.name}`} onPreview={onPreview} onDelete={onDelete} />
          ))}
          
          {node.files.map((file) => (
            <div key={file.id} className="bg-background border border-border-subtle rounded-xl p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">{file.name.split('/').pop()}</div>
                <div className="text-[10px] text-gray-400">
                  {formatBytes(file.size)} · {new Date(file.uploadedAt).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => onPreview(file)} className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white" title="Preview">
                  <Eye className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { if (file.storageUrl) window.open(file.storageUrl, '_blank'); }}
                  className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white"
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button onClick={() => onDelete(file.id)} className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [section, setSection] = useState<AdminSection>('dashboard');
  const [dataTab, setDataTab] = useState<DataTab>('upload');

  const [files, setFiles] = useState<Omit<CMSFileRecord, 'rows'>[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [overrides, setOverrides] = useState<CMSMetricOverride[]>([]);
  const [propertyOverrides, setPropertyOverrides] = useState<CMSPropertyOverride[]>([]);
  const [summary, setSummary] = useState<CMSStoreSummary>({ files: 0, rows: 0, overrides: 0, propertyOverrides: 0, lastUploadAt: null });
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [previewFile, setPreviewFile] = useState<CMSFileRecord | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [engineLoaded, setEngineLoaded] = useState(getEngine().isLoaded);
  const [engineTick, setEngineTick] = useState(0);

  const [overrideBoundary, setOverrideBoundary] = useState<BoundaryKey>('zipcodes');
  const [overrideBoundaryId, setOverrideBoundaryId] = useState('');
  const [overrideMetric, setOverrideMetric] = useState<MetricKey>('Close Price');
  const [overrideValue, setOverrideValue] = useState('');
  const [overrideNote, setOverrideNote] = useState('');

  const [propFilters, setPropFilters] = useState({ area: '', subdivision: '', marketArea: '' });
  const [selectedPropertyKey, setSelectedPropertyKey] = useState('');
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [propertyEditMode, setPropertyEditMode] = useState<PropertyEditMode>('edit');
  const [createFields, setCreateFields] = useState<Record<string, string>>({});

  const [selectedZip, setSelectedZip] = useState('');
  const [selectedTaxPropertyKey, setSelectedTaxPropertyKey] = useState('');
  const [taxFields, setTaxFields] = useState<Record<string, string>>({});

  const [schoolLevel, setSchoolLevel] = useState<'elementary' | 'middle' | 'high'>('elementary');
  const [schoolName, setSchoolName] = useState('');
  const [schoolScore, setSchoolScore] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reloadEngine = useCallback(async () => {
    await getEngine().loadAllCSV(true);
    setEngineLoaded(true);
    setEngineTick((t) => t + 1);
  }, []);

  const loadData = useCallback(async () => {
    await cmsStore.init();
    const [list, ovr, propOvr, s] = await Promise.all([
      cmsStore.listFilesMetadata(),
      cmsStore.listOverrides(),
      cmsStore.listPropertyOverrides(),
      cmsStore.summary(),
    ]);
    setFiles(list);
    setOverrides(ovr);
    setPropertyOverrides(propOvr);
    setSummary(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const unsubscribe = cmsStore.subscribe(() => loadData());
    return () => unsubscribe();
  }, [loadData]);

  useEffect(() => {
    if (!getEngine().isLoaded || getEngine().data.length === 0) {
      reloadEngine().catch((err) => console.error('Engine preload error', err));
    }
  }, [reloadEngine]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    setDataTab('upload');
    setPropFilters({ area: '', subdivision: '', marketArea: '' });
    setSelectedPropertyKey('');
    setEditFields({});
    setPropertyEditMode('edit');
    setCreateFields({});
    setSelectedZip('');
    setSelectedTaxPropertyKey('');
    setTaxFields({});
    setSchoolName('');
    setSchoolScore('');
  }, [section]);

  const handleFiles = async (fileList: FileList | null, section: Exclude<AdminSection, 'dashboard' | 'areas'>) => {
    if (!fileList?.length) return;
    setProcessing(true);

    const config = SECTION_CONFIG[section];
    const categories = Array.isArray(config.category) ? config.category : [config.category];

    const newStaged: StagedFile[] = [];

    for (const file of Array.from(fileList)) {
      if (section === 'boundaries') {
        if (!file.name.toLowerCase().endsWith('.geojson') && !file.name.toLowerCase().endsWith('.json')) {
          setToast({ type: 'error', message: `${file.name} is not a GeoJSON file.` });
          continue;
        }
        
        try {
          const text = await file.text();
          const geo = JSON.parse(text);
          const featureCount = geo.features ? geo.features.length : 0;
          
          const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const record: CMSFileRecord = {
            id,
            name: file.name,
            size: file.size,
            category: 'boundary',
            rows: [],
            headers: [],
            uploadedAt: Date.now(),
            source: 'upload',
          };
          
          newStaged.push({
            id,
            file,
            record,
            stats: {
              total: featureCount,
              new: featureCount,
              existing: 0
            }
          });
        } catch (err) {
          console.error('GeoJSON parse error', err);
          setToast({ type: 'error', message: `Error processing ${file.name}` });
        }
        continue;
      }

      if (!file.name.toLowerCase().endsWith('.csv')) {
        setToast({ type: 'error', message: `${file.name} is not a CSV file.` });
        continue;
      }

      try {
        const parsed = await new Promise<Papa.ParseResult<Record<string, string>>>((resolve, reject) => {
          Papa.parse<Record<string, string>>(file, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: false,
            worker: true,
            complete: (results) => resolve(results),
            error: (error) => reject(error)
          });
        });

        const validation = validateHeaders(parsed.meta.fields || [], config.requiredColumns);
        if (!validation.valid) {
          setToast({ type: 'error', message: `${file.name} is missing columns: ${validation.missing.join(', ')}` });
          continue;
        }

        const category = detectCategory(file.name, section);
        const actualCategory = categories.includes(category) ? category : categories[0];
        
        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const record: CMSFileRecord = {
          id,
          name: file.name,
          size: file.size,
          category: actualCategory,
          rows: parsed.data,
          headers: parsed.meta.fields || [],
          uploadedAt: Date.now(),
          source: 'upload',
        };

        newStaged.push({
          id,
          file,
          record,
          stats: {
            total: parsed.data.length,
            new: parsed.data.length,
            existing: 0
          }
        });

      } catch (err) {
        console.error('File read error', err);
        setToast({ type: 'error', message: `Error processing ${file.name}` });
      }
    }

    if (newStaged.length > 0) {
      setStagedFiles(prev => [...prev, ...newStaged]);
      setToast({ type: 'success', message: `${newStaged.length} file(s) staged for review.` });
    }
    
    setProcessing(false);
  };

  const handleConfirmUpload = async (stagedId: string) => {
    const staged = stagedFiles.find(s => s.id === stagedId);
    if (!staged) return;

    setProcessing(true);
    
    const existingFile = files.find((f) => f.name === staged.record.name);
    if (existingFile) {
      await cmsStore.removeFile(existingFile.id);
    }

    try {
      await cmsStore.saveFile(staged.record);
      setStagedFiles(prev => prev.filter(s => s.id !== stagedId));
      await loadData();
      await reloadEngine();
      setToast({ type: 'success', message: `${staged.record.name} uploaded successfully.` });
    } catch (err) {
      console.error('Upload error', err);
      setToast({ type: 'error', message: `Error uploading ${staged.record.name}` });
    }
    setProcessing(false);
  };

  const handleDiscardStaged = (stagedId: string) => {
    setStagedFiles(prev => prev.filter(s => s.id !== stagedId));
  };

  const handleDelete = async (id: string) => {
    await cmsStore.removeFile(id);
    await reloadEngine();
    setToast({ type: 'success', message: 'File removed and map updated.' });
  };

  const handleClearAll = async () => {
    if (confirm('Are you sure you want to delete ALL uploaded files? This cannot be undone.')) {
      setProcessing(true);
      await cmsStore.clearFiles();
      await reloadEngine();
      setToast({ type: 'success', message: 'All files have been deleted.' });
      setProcessing(false);
    }
  };

  const handleSaveOverride = async () => {
    if (!overrideBoundaryId.trim() || overrideValue === '') {
      setToast({ type: 'error', message: 'Select a boundary ID and enter a value.' });
      return;
    }
    const value = Number(overrideValue);
    if (!isFinite(value)) {
      setToast({ type: 'error', message: 'Value must be a number.' });
      return;
    }
    const id = `override-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const override: CMSMetricOverride = {
      id,
      boundary: overrideBoundary,
      boundaryId: overrideBoundaryId.trim().toUpperCase(),
      metric: overrideMetric,
      value,
      note: overrideNote.trim(),
      updatedAt: Date.now(),
    };
    await cmsStore.saveOverride(override);
    await reloadEngine();
    setOverrideBoundaryId('');
    setOverrideValue('');
    setOverrideNote('');
    setToast({ type: 'success', message: 'Override saved and map updated.' });
  };

  const handleDeleteOverride = async (id: string) => {
    await cmsStore.removeOverride(id);
    await reloadEngine();
    setToast({ type: 'success', message: 'Override removed and map updated.' });
  };

  const getQuickFields = useCallback(
    (key: AdminSection): string[] => {
      if (key === 'rent') return RENT_QUICK_FIELDS;
      if (key === 'current') return CURRENT_QUICK_FIELDS;
      if (key === 'tax') return TAX_QUICK_FIELDS;
      return SALES_QUICK_FIELDS;
    },
    []
  );

  const fillQuickFields = useCallback(
    (property: PropertyData | null, targetSection: AdminSection) => {
      if (!property) return {};
      const raw = property as unknown as Record<string, unknown>;
      const fields = getQuickFields(targetSection);
      const map: Record<string, string> = {};
      fields.forEach((h) => {
        const key = FIELD_TO_PROPERTY_KEY[h] ?? (h as keyof typeof raw);
        if (!key) {
          map[h] = '';
          return;
        }
        const val = raw[key as string];
        map[h] = val != null && val !== '' ? String(val) : '';
      });
      return map;
    },
    [getQuickFields]
  );

  const handleSavePropertyEdit = async (
    fields: Record<string, string>,
    property: PropertyData | null,
    mode: PropertyEditMode = 'edit'
  ) => {
    const mlsNumber = fields['MLS Number']?.trim() || property?.mlsNumber || '';
    const address = fields['Address']?.trim() || property?.address || '';
    const zip = fields['Zip']?.trim() || property?.zip || '';

    if (!address || !zip) {
      setToast({ type: 'error', message: 'Address and Zip are required.' });
      return;
    }

    if (mode === 'create') {
      const required = ['City/Location', 'State Or Province', 'Latitude', 'Longitude'];
      const missing = required.filter((k) => !fields[k]?.trim());
      if (missing.length) {
        setToast({ type: 'error', message: `New record needs: ${missing.join(', ')}` });
        return;
      }
      if (!mlsNumber) {
        setToast({ type: 'error', message: 'MLS Number is required for a new record.' });
        return;
      }
    }

    const existing = property
      ? propertyOverrides.find(
          (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
        )
      : propertyOverrides.find((o) => o.mlsNumber === mlsNumber && o.address === address && o.zip === zip);
    const id = existing ? existing.id : `prop-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const record: CMSPropertyOverride = {
      id,
      mlsNumber,
      address,
      zip,
      fields,
      updatedAt: Date.now(),
      source: 'manual',
      mode,
    };
    await cmsStore.savePropertyOverride(record);
    await reloadEngine();
    setToast({ type: 'success', message: mode === 'create' ? 'New record created and map updated.' : 'Change saved and map updated.' });
  };

  const handleDeletePropertyEdit = async (id: string) => {
    await cmsStore.removePropertyOverride(id);
    await reloadEngine();
    setToast({ type: 'success', message: 'Edit removed and map updated.' });
  };

  const handleSaveSchoolEdit = async () => {
    if (!schoolName.trim() || schoolScore === '') {
      setToast({ type: 'error', message: 'Enter school name and score.' });
      return;
    }
    const value = Number(schoolScore);
    if (!isFinite(value)) {
      setToast({ type: 'error', message: 'Score must be a number.' });
      return;
    }
    const boundary: BoundaryKey = schoolLevel === 'elementary' ? 'elementary' : schoolLevel === 'middle' ? 'middle' : 'highschools';
    const metric: MetricKey =
      schoolLevel === 'elementary' ? 'Elem ETA Score' : schoolLevel === 'middle' ? 'Middle ETA Score' : 'High ETA Score';
    const id = `override-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const override: CMSMetricOverride = {
      id,
      boundary,
      boundaryId: schoolName.trim().toUpperCase(),
      metric,
      value,
      updatedAt: Date.now(),
    };
    await cmsStore.saveOverride(override);
    await reloadEngine();
    setSchoolName('');
    setSchoolScore('');
    setToast({ type: 'success', message: 'School rating saved and map updated.' });
  };

  const sectionFiles = useMemo(() => {
    if (section === 'dashboard' || section === 'areas') return [];
    const config = SECTION_CONFIG[section];
    const cats = Array.isArray(config.category) ? config.category : [config.category];
    return files.filter((f) => cats.includes(f.category));
  }, [files, section]);

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return sectionFiles;
    const q = searchQuery.toLowerCase();
    return sectionFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [sectionFiles, searchQuery]);

  const boundaryValueOptions = useMemo(() => {
    const key: keyof PropertyData =
      overrideBoundary === 'zipcodes'
        ? 'zip'
        : overrideBoundary === 'subdivisions'
        ? 'subdivisions'
        : overrideBoundary === 'highschools'
        ? 'highschools'
        : overrideBoundary === 'elementary'
        ? 'elementary'
        : overrideBoundary === 'middle'
        ? 'middle'
        : 'subdivisions';
    const values = getEngine().getUniqueValues(key);
    return values.slice(0, 500);
  }, [overrideBoundary, engineLoaded]);

  const areaOptions = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return uniqueSorted(getEngine().data.map((d) => d.area));
  }, [getEngine().isLoaded, getEngine().data.length, engineTick]);

  const zipOptions = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return uniqueSorted(getEngine().data.map((d) => d.zip));
  }, [getEngine().isLoaded, getEngine().data.length, engineTick]);

  const subdivisionOptions = useMemo(() => {
    if (!getEngine().isLoaded || !propFilters.area) return [];
    return uniqueSorted(
      getEngine().data.filter((d) => (d.area || '').trim() === propFilters.area).map((d) => d.subdivisions)
    );
  }, [getEngine().isLoaded, propFilters.area, getEngine().data.length, engineTick]);

  const marketAreaOptions = useMemo(() => {
    if (!getEngine().isLoaded || !propFilters.area) return [];
    return uniqueSorted(
      getEngine().data
        .filter((d) => {
          const areaMatch = (d.area || '').trim() === propFilters.area;
          const subMatch = !propFilters.subdivision || (d.subdivisions || '').trim() === propFilters.subdivision;
          return areaMatch && subMatch;
        })
        .map((d) => d.marketArea)
    );
  }, [getEngine().isLoaded, propFilters.area, propFilters.subdivision, getEngine().data.length, engineTick]);

  const filteredProperties = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return getEngine().data.filter((d) => {
      const areaMatch = !propFilters.area || (d.area || '').trim() === propFilters.area;
      const subMatch = !propFilters.subdivision || (d.subdivisions || '').trim() === propFilters.subdivision;
      const marketMatch = !propFilters.marketArea || (d.marketArea || '').trim() === propFilters.marketArea;
      return areaMatch && subMatch && marketMatch;
    });
  }, [getEngine().isLoaded, propFilters, getEngine().data.length, engineTick]);

  const propertiesInZip = useMemo(() => {
    if (!getEngine().isLoaded || !selectedZip) return [];
    return getEngine().data.filter((d) => (d.zip || '').trim() === selectedZip);
  }, [getEngine().isLoaded, selectedZip, getEngine().data.length, engineTick]);

  const selectedProperty = useMemo(() => {
    if (!selectedPropertyKey) return null;
    return getEngine().data.find((p) => `${p.mlsNumber}|${p.address}|${p.zip}` === selectedPropertyKey) || null;
  }, [selectedPropertyKey, getEngine().data.length, engineTick]);

  const selectedTaxProperty = useMemo(() => {
    if (!selectedTaxPropertyKey) return null;
    return propertiesInZip.find((p) => `${p.mlsNumber}|${p.address}|${p.zip}` === selectedTaxPropertyKey) || null;
  }, [selectedTaxPropertyKey, propertiesInZip]);

  useEffect(() => {
    if (!selectedProperty) {
      setEditFields({});
      return;
    }
    const existing = propertyOverrides.find(
      (o) => o.mlsNumber === selectedProperty.mlsNumber && o.address === selectedProperty.address && o.zip === selectedProperty.zip
    );
    if (existing) {
      setEditFields(existing.fields);
    } else {
      setEditFields(fillQuickFields(selectedProperty, section));
    }
  }, [selectedProperty, propertyOverrides, section, fillQuickFields]);

  useEffect(() => {
    if (!selectedTaxProperty) {
      setTaxFields({});
      return;
    }
    const existing = propertyOverrides.find(
      (o) => o.mlsNumber === selectedTaxProperty.mlsNumber && o.address === selectedTaxProperty.address && o.zip === selectedTaxProperty.zip
    );
    if (existing) {
      const fields: Record<string, string> = {};
      TAX_QUICK_FIELDS.forEach((f) => (fields[f] = existing.fields[f] ?? ''));
      setTaxFields(fields);
    } else {
      setTaxFields(fillQuickFields(selectedTaxProperty, 'tax'));
    }
  }, [selectedTaxProperty, propertyOverrides, fillQuickFields]);

  const onDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (section !== 'dashboard' && section !== 'areas') {
      handleFiles(e.dataTransfer.files, section);
    }
  };

  const renderDashboard = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { icon: <FileSpreadsheet className="w-5 h-5 text-blue-500" />, label: 'Uploaded files', value: summary.files },
          { icon: <Database className="w-5 h-5 text-emerald-500" />, label: 'Uploaded rows', value: formatNumber(summary.rows) },
          { icon: <BarChart3 className="w-5 h-5 text-amber-500" />, label: 'Rows in engine', value: getEngine().isLoaded ? formatNumber(getEngine().data.length) : '—' },
          { icon: <SlidersHorizontal className="w-5 h-5 text-purple-500" />, label: 'Area overrides', value: summary.overrides },
          { icon: <Pencil className="w-5 h-5 text-pink-500" />, label: 'Property edits', value: summary.propertyOverrides },
        ].map((stat, i) => (
          <div key={i} className="bg-surface border border-border-subtle rounded-2xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-background flex items-center justify-center">{stat.icon}</div>
            <div>
              <div className="text-2xl font-bold text-white">{stat.value}</div>
              <div className="text-xs text-gray-400">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {SECTIONS.filter((s) => s.id !== 'dashboard').map((s) => {
          const config = s.id === 'areas' ? null : SECTION_CONFIG[s.id as Exclude<AdminSection, 'dashboard' | 'areas'>];
          const count = config
            ? files.filter((f) => (Array.isArray(config.category) ? config.category.includes(f.category) : f.category === config.category)).length
            : overrides.length;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className="text-left bg-surface border border-border-subtle hover:border-blue-500/50 rounded-2xl p-5 transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl bg-background group-hover:bg-blue-500/20 flex items-center justify-center text-gray-300 group-hover:text-blue-400 transition-colors">
                  {s.icon}
                </div>
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-background text-gray-400">{count} files</span>
              </div>
              <h3 className="text-base font-bold text-white mb-1">{s.label}</h3>
              <p className="text-xs text-gray-400">{s.desc}</p>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderQuickFieldInputs = (
    fields: string[],
    values: Record<string, string>,
    onChange: (key: string, value: string) => void
  ) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fields.map((h) => (
        <div key={h}>
          <label className="text-xs font-medium text-gray-400 block mb-1">{FIELD_LABELS[h] || h}</label>
          <input
            value={values[h] ?? ''}
            placeholder={`Enter ${FIELD_LABELS[h] || h}`}
            onChange={(e) => onChange(h, e.target.value)}
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      ))}
    </div>
  );

  const SearchableSelect = ({
    options,
    value,
    onChange,
    placeholder = 'Choose…',
    disabled = false,
    optionLabel = (opt: { value: string; label: string; raw?: PropertyData }) => opt.label,
  }: {
    options: { value: string; label: string; raw?: PropertyData }[];
    value: string;
    onChange: (val: string) => void;
    placeholder?: string;
    disabled?: boolean;
    optionLabel?: (opt: { value: string; label: string; raw?: PropertyData }) => string;
  }) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    useEffect(() => {
      if (open) {
        setSearch('');
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    }, [open]);

    const selectedLabel = options.find((o) => o.value === value)?.label || placeholder;

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      if (!q) return options.slice(0, 300);
      return options.filter((o) => optionLabel(o).toLowerCase().includes(q)).slice(0, 300);
    }, [options, search, optionLabel]);

    return (
      <div ref={containerRef} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className={`w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-left text-white focus:outline-none focus:border-blue-500 flex items-center justify-between ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
        </button>
        {open && (
          <div className="absolute z-50 mt-1 w-full bg-surface border border-border-subtle rounded-lg shadow-xl max-h-72 flex flex-col">
            <div className="p-2 border-b border-border-subtle">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Type address, MLS or zip…"
                  className="w-full bg-background border border-border-subtle rounded-md pl-8 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
            <div className="overflow-auto p-1">
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-500">No matches</div>
              )}
              {filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={`w-full text-left px-3 py-2 text-xs rounded-md hover:bg-background ${o.value === value ? 'bg-blue-500/20 text-blue-300' : 'text-gray-300'}`}
                >
                  {optionLabel(o)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderPropertyInfoCard = (property: PropertyData) => (
    <div className="mb-5 p-4 bg-background border border-border-subtle rounded-xl">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-white">{property.address}</div>
          <div className="text-xs text-gray-400">
            {property.city}, {property.state} {property.zip} · MLS {property.mlsNumber}
          </div>
        </div>
        <button
          onClick={() => {
            setSelectedPropertyKey('');
            setEditFields({});
          }}
          className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
        >
          <X className="w-3 h-3" /> Clear
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {[
          { label: 'Area', value: property.area },
          { label: 'Subdivision', value: property.subdivisions },
          { label: 'Market Area', value: property.marketArea },
          { label: 'Property Type', value: property.propertyType },
          { label: 'Latitude', value: property.lat },
          { label: 'Longitude', value: property.lng },
          { label: 'Bed/Bath', value: `${property.br} / ${property.baths}` },
          { label: 'Sqft', value: property.sqft },
        ]
          .filter((item) => item.value !== '' && item.value != null)
          .map((item) => (
            <div key={item.label} className="bg-surface rounded-lg p-2">
              <div className="text-gray-500 mb-0.5">{item.label}</div>
              <div className="text-white font-medium truncate">{String(item.value)}</div>
            </div>
          ))}
      </div>
    </div>
  );

  const propertyOptions = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return filteredProperties.map((p) => ({
      value: `${p.mlsNumber}|${p.address}|${p.zip}`,
      label: `${p.address} | ${p.subdivisions || '—'} | Area ${p.area || '—'} | ${p.marketArea || '—'} | MLS ${p.mlsNumber} | ${p.zip}`,
      raw: p,
    }));
  }, [filteredProperties, getEngine().isLoaded, engineTick]);

  const renderPropertyEditor = (mode: 'sales' | 'rent' | 'current') => {
    const property = propertyEditMode === 'edit' ? selectedProperty : null;
    const fields = getQuickFields(mode);
    const sectionName = mode === 'rent' ? 'Rent Data' : mode === 'current' ? 'Current Listings' : 'Sales Data';

    return (
      <div className="bg-surface border border-border-subtle rounded-2xl p-5">
        <div className="mb-5 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-blue-300 mb-1 flex items-center gap-2">
              <ChevronRight className="w-4 h-4" /> Manual {sectionName} Editor
            </h4>
            <p className="text-xs text-gray-400">
              {propertyEditMode === 'edit'
                ? 'Use the CSV filters to find a record, update its values, then save.'
                : 'Create a new property record. Fill the required CSV fields and the values for this section.'}
            </p>
          </div>
          <div className="flex items-center gap-1 bg-background rounded-xl p-1 border border-border-subtle">
            <button
              onClick={() => {
                setPropertyEditMode('edit');
                setCreateFields({});
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${propertyEditMode === 'edit' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              Edit existing
            </button>
            <button
              onClick={() => {
                setPropertyEditMode('create');
                setSelectedPropertyKey('');
                setEditFields({});
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 ${propertyEditMode === 'create' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              <Plus className="w-3 h-3" /> Create new
            </button>
          </div>
        </div>

        {propertyEditMode === 'edit' && (
          <>
            <div className="grid md:grid-cols-3 gap-4 mb-5">
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">1. Area</label>
                <select
                  value={propFilters.area}
                  onChange={(e) => {
                    setPropFilters((f) => ({ ...f, area: e.target.value, subdivision: '', marketArea: '' }));
                    setSelectedPropertyKey('');
                  }}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">All areas</option>
                  {areaOptions.map((a) => (
                    <option key={a} value={a}>Area {a}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">2. Subdivision</label>
                <select
                  value={propFilters.subdivision}
                  onChange={(e) => {
                    setPropFilters((f) => ({ ...f, subdivision: e.target.value, marketArea: '' }));
                    setSelectedPropertyKey('');
                  }}
                  disabled={!propFilters.area}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">{propFilters.area ? 'All subdivisions' : 'First choose an area'}</option>
                  {subdivisionOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">3. Market Area</label>
                <select
                  value={propFilters.marketArea}
                  onChange={(e) => {
                    setPropFilters((f) => ({ ...f, marketArea: e.target.value }));
                    setSelectedPropertyKey('');
                  }}
                  disabled={!propFilters.area}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">{propFilters.area ? 'All market areas' : 'First choose an area'}</option>
                  {marketAreaOptions.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-5">
              <label className="text-xs font-medium text-gray-400 block mb-1.5">4. Select Property (search inside the dropdown)</label>
              <SearchableSelect
                value={selectedPropertyKey}
                onChange={(val) => setSelectedPropertyKey(val)}
                options={propertyOptions}
                placeholder={propFilters.area ? 'Choose a property…' : 'First choose at least an area'}
                disabled={!propFilters.area}
              />
            </div>
          </>
        )}

        {property && renderPropertyInfoCard(property)}

        {(property || propertyEditMode === 'create') && (
          <>
            <div className="mb-3">
              <label className="text-xs font-medium text-blue-300 block mb-1.5">{propertyEditMode === 'create' ? 'Required CSV fields' : 'Values to change'}</label>
              <p className="text-[11px] text-gray-500">
                {propertyEditMode === 'create'
                  ? 'Address, City, State, Zip, Latitude and Longitude are required. Then fill the section values.'
                  : 'Only fill the fields you want to change. Empty fields keep the original CSV value.'}
              </p>
            </div>

            {propertyEditMode === 'create' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                {[
                  { key: 'MLS Number', label: 'MLS Number' },
                  { key: 'Address', label: 'Address' },
                  { key: 'City/Location', label: 'City/Location' },
                  { key: 'State Or Province', label: 'State Or Province' },
                  { key: 'Zip', label: 'Zip' },
                  { key: 'Subdivision', label: 'Subdivision' },
                  { key: 'Area', label: 'Area' },
                  { key: 'Market Area', label: 'Market Area' },
                  { key: 'Latitude', label: 'Latitude' },
                  { key: 'Longitude', label: 'Longitude' },
                ].map((f) => (
                  <div key={f.key}>
                    <label className="text-xs font-medium text-gray-400 block mb-1">{f.label}</label>
                    <input
                      value={createFields[f.key] ?? ''}
                      placeholder={`Enter ${f.label}`}
                      onChange={(e) => setCreateFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                ))}
              </div>
            )}

            {renderQuickFieldInputs(
              fields,
              propertyEditMode === 'create' ? createFields : editFields,
              (key, value) => {
                if (propertyEditMode === 'create') {
                  setCreateFields((prev) => ({ ...prev, [key]: value }));
                } else {
                  setEditFields((prev) => ({ ...prev, [key]: value }));
                }
              }
            )}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() =>
                  handleSavePropertyEdit(
                    propertyEditMode === 'create' ? createFields : editFields,
                    property,
                    propertyEditMode
                  )
                }
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
              >
                <Save className="w-4 h-4" /> {propertyEditMode === 'create' ? 'Create on map' : 'Save to map'}
              </button>
              {property && propertyOverrides.find(
                (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
              ) && (
                <button
                  onClick={() => {
                    const existing = propertyOverrides.find(
                      (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
                    );
                    if (existing) handleDeletePropertyEdit(existing.id);
                  }}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" /> Remove edit
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderTaxEditor = () => {
    const property = selectedTaxProperty;
    return (
      <div className="bg-surface border border-border-subtle rounded-2xl p-5">
        <div className="mb-5 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
          <h4 className="text-sm font-bold text-emerald-300 mb-1 flex items-center gap-2">
            <ChevronRight className="w-4 h-4" /> Manual Tax Record Edit
          </h4>
          <p className="text-xs text-gray-400">Pick a ZIP code and property, then type the new tax values.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-5">
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">1. Select ZIP Code</label>
            <select
              value={selectedZip}
              onChange={(e) => {
                setSelectedZip(e.target.value);
                setSelectedTaxPropertyKey('');
              }}
              className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            >
              <option value="">Choose a ZIP…</option>
              {zipOptions.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">2. Select Property</label>
            <select
              value={selectedTaxPropertyKey}
              onChange={(e) => setSelectedTaxPropertyKey(e.target.value)}
              disabled={!selectedZip}
              className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
            >
              <option value="">{selectedZip ? 'Choose a property…' : 'First choose a ZIP'}</option>
              {propertiesInZip.map((p, idx) => (
                <option key={`${idx}-${p.mlsNumber}|${p.address}|${p.zip}`} value={`${p.mlsNumber}|${p.address}|${p.zip}`}>
                  {p.address} — MLS {p.mlsNumber}
                </option>
              ))}
            </select>
          </div>
        </div>

        {property && (
          <div className="mb-5 p-3 bg-background border border-border-subtle rounded-xl flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">{property.address}</div>
              <div className="text-xs text-gray-400">
                {property.city}, {property.state} {property.zip} · MLS {property.mlsNumber}
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedTaxPropertyKey('');
                setTaxFields({});
              }}
              className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          </div>
        )}

        {property && (
          <>
            <div className="mb-3">
              <label className="text-xs font-medium text-emerald-300 block mb-1.5">3. Type the new tax values</label>
              <p className="text-[11px] text-gray-500">Only fill the fields you want to change.</p>
            </div>
            {renderQuickFieldInputs(TAX_QUICK_FIELDS, taxFields, (key, value) => setTaxFields((prev) => ({ ...prev, [key]: value })))}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => handleSavePropertyEdit(taxFields, property)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
              >
                <Save className="w-4 h-4" /> Save to map
              </button>
              {propertyOverrides.find(
                (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
              ) && (
                <button
                  onClick={() => {
                    const existing = propertyOverrides.find(
                      (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
                    );
                    if (existing) handleDeletePropertyEdit(existing.id);
                  }}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" /> Remove edit
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderSchoolEditor = () => (
    <div className="bg-surface border border-border-subtle rounded-2xl p-5">
      <div className="mb-5 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
        <h4 className="text-sm font-bold text-amber-300 mb-1 flex items-center gap-2">
          <ChevronRight className="w-4 h-4" /> Manual School Rating Edit
        </h4>
        <p className="text-xs text-gray-400">Pick a school level and type the school name and new score.</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-5">
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-1.5">1. School level</label>
          <select
            value={schoolLevel}
            onChange={(e) => setSchoolLevel(e.target.value as 'elementary' | 'middle' | 'high')}
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
          >
            <option value="elementary">Elementary</option>
            <option value="middle">Middle</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-1.5">2. School name</label>
          <input
            value={schoolName}
            onChange={(e) => setSchoolName(e.target.value)}
            placeholder="e.g. CYPRESS WOODS HS"
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-1.5">3. New overall score</label>
          <input
            type="number"
            value={schoolScore}
            onChange={(e) => setSchoolScore(e.target.value)}
            placeholder="0-100"
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
          />
        </div>
      </div>

      <button
        onClick={handleSaveSchoolEdit}
        className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
      >
        <Save className="w-4 h-4" /> Save school rating
      </button>
    </div>
  );

  const renderDataSection = (key: Exclude<AdminSection, 'dashboard' | 'areas'>) => {
    const config = SECTION_CONFIG[key];

    return (
      <div className="space-y-6">
        <div className="bg-gradient-to-r from-blue-900/20 to-transparent border border-blue-500/20 rounded-2xl p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-lg font-bold text-white mb-1">{config.title}</h2>
              <p className="text-sm text-gray-400">{config.subtitle}</p>
            </div>
            <div className="flex items-center gap-1 bg-background rounded-xl p-1 border border-border-subtle">
              <button
                onClick={() => setDataTab('upload')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  dataTab === 'upload' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                Upload CSV
              </button>
              <button
                onClick={() => setDataTab('edit')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 ${
                  dataTab === 'edit' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Pencil className="w-3 h-3" /> Edit Manually
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-background/60 rounded-xl p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-blue-400 mb-3 flex items-center gap-2">
                <SlidersHorizontal className="w-3 h-3" /> This changes on the map
              </h3>
              <ul className="space-y-2">
                {config.whatItModifies.map((item, i) => (
                  <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-background/60 rounded-xl p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-3 flex items-center gap-2">
                <FileSpreadsheet className="w-3 h-3" /> Expected CSV files
              </h3>
              <p className="text-sm text-gray-300 mb-3">{config.fileHint}</p>
              <div className="text-xs text-gray-500">
                Required columns: <span className="text-gray-300">{config.requiredColumns.join(', ')}</span>
              </div>
            </div>
          </div>
        </div>

        {dataTab === 'upload' ? (
          <>
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1">
                <div className="bg-surface border border-border-subtle rounded-2xl p-5 sticky top-4">
                  <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                    <Upload className="w-4 h-4" /> Upload {config.title}
                  </h3>
                  <div
                    onDragEnter={onDrag}
                    onDragLeave={onDrag}
                    onDragOver={onDrag}
                    onDrop={onDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                      dragActive ? 'border-blue-500 bg-blue-500/10' : 'border-border-subtle hover:border-white/30 hover:bg-background/50'
                    }`}
                  >
                    <Upload className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                    <p className="text-sm text-gray-300 mb-1">Drop CSV files here</p>
                    <p className="text-xs text-gray-500 mb-3">or click to browse</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv"
                      multiple
                      className="hidden"
                      onChange={(e) => handleFiles(e.target.files, key)}
                    />
                    <div className="text-[10px] text-gray-500">Files replace matching rows in the engine instantly.</div>
                  </div>
                  {processing && (
                    <div className="mt-4 flex items-center gap-2 text-xs text-blue-400">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      Reloading engine…
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-2">
                {stagedFiles.length > 0 && (
                  <div className="bg-surface border border-blue-500/50 rounded-2xl p-5 mb-6 shadow-[0_0_15px_rgba(59,130,246,0.1)]">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-4">
                      <AlertTriangle className="w-4 h-4 text-blue-400" /> Staging Area: Pending Uploads
                    </h3>
                    <div className="space-y-3">
                      {stagedFiles.map(staged => (
                        <div key={staged.id} className="bg-background border border-border-subtle rounded-xl p-4">
                          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-3">
                            <div>
                              <div className="text-sm font-medium text-white break-all">{staged.record.name}</div>
                              <div className="text-xs text-gray-400">{formatBytes(staged.record.size)}</div>
                            </div>
                            <div className="flex gap-2 shrink-0">
                              <button onClick={() => handleDiscardStaged(staged.id)} className="px-3 py-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-xs font-medium transition-colors">Discard</button>
                              <button onClick={() => handleConfirmUpload(staged.id)} disabled={processing} className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 disabled:opacity-50">
                                <CheckCircle className="w-3 h-3" /> Confirm Upload
                              </button>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-3 gap-2">
                            <div className="bg-white/5 rounded-lg p-2 text-center">
                              <div className="text-[10px] sm:text-xs text-gray-400 mb-1">Total Rows</div>
                              <div className="text-xs sm:text-sm font-bold text-white">{staged.stats.total.toLocaleString()}</div>
                            </div>
                            <div className="bg-blue-500/10 rounded-lg p-2 text-center border border-blue-500/20">
                              <div className="text-[10px] sm:text-xs text-blue-400 mb-1">New Data</div>
                              <div className="text-xs sm:text-sm font-bold text-blue-400">{staged.stats.new.toLocaleString()}</div>
                            </div>
                            <div className="bg-amber-500/10 rounded-lg p-2 text-center border border-amber-500/20">
                              <div className="text-[10px] sm:text-xs text-amber-400 mb-1">Updating Existing</div>
                              <div className="text-xs sm:text-sm font-bold text-amber-400">{staged.stats.existing.toLocaleString()}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-surface border border-border-subtle rounded-2xl p-5">
                  <div className="flex flex-col sm:flex-row gap-3 mb-4 items-start sm:items-center justify-between">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Database className="w-4 h-4" /> Uploaded {config.title} Files
                    </h3>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <div className="relative flex-1 sm:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                        <input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search files…"
                          className="w-full bg-background border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <button
                        onClick={handleClearAll}
                        className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                      >
                        <Trash2 className="w-4 h-4" /> Delete All
                      </button>
                    </div>
                  </div>

                  {filteredFiles.length === 0 ? (
                    <div className="text-sm text-gray-500 py-8 text-center bg-background/40 rounded-xl border border-border-subtle">
                      No {config.title.toLowerCase()} files uploaded yet.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[500px] overflow-auto pr-1">
                      {(() => {
                        const rootNode = buildTree(filteredFiles);
                        return Object.values(rootNode.folders).map(folder => (
                          <FolderNode 
                            key={folder.name} 
                            node={folder} 
                            path={folder.name}
                            onPreview={async (file) => {
                              try {
                                const response = await fetch(file.storageUrl || '');
                                const csvText = await response.text();
                                const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
                                setPreviewFile({ ...file, rows: parsed.data as Record<string, string>[] });
                              } catch (err) {
                                console.error(err);
                              }
                            }}
                            onDelete={handleDelete}
                          />
                        )).concat(
                          rootNode.files.map(file => (
                            <div key={file.id} className="bg-background border border-border-subtle rounded-xl p-3 flex items-center justify-between gap-3 ml-4 first:ml-0">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-white truncate">{file.name.split('/').pop()}</div>
                                <div className="text-[10px] text-gray-400">
                                  {formatBytes(file.size)} · {new Date(file.uploadedAt).toLocaleString()}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button onClick={async () => {
                                  try {
                                    const response = await fetch(file.storageUrl || '');
                                    const csvText = await response.text();
                                    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
                                    setPreviewFile({ ...file, rows: parsed.data as Record<string, string>[] });
                                  } catch (err) {
                                    console.error(err);
                                  }
                                }} className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white" title="Preview">
                                  <Eye className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => { if (file.storageUrl) window.open(file.storageUrl, '_blank'); }}
                                  className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white"
                                  title="Download"
                                >
                                  <Download className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleDelete(file.id)} className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400" title="Delete">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          ))
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            {key === 'tax' && renderTaxEditor()}
            {key === 'schools' && renderSchoolEditor()}
            {(key === 'sales' || key === 'rent' || key === 'current') && renderPropertyEditor(key)}
          </>
        )}
      </div>
    );
  };

  const renderAreas = () => (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-purple-900/20 to-transparent border border-purple-500/20 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-white mb-1">Area Metrics — Manual Override</h2>
        <p className="text-sm text-gray-400 mb-4">
          Override any computed value for a ZIP code, subdivision, or school boundary. Use this when you want a specific number on the map without editing the underlying CSVs.
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-background/60 rounded-xl p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-3">This changes on the map</h3>
            <ul className="space-y-2">
              {[
                'Median close price for a ZIP',
                'Median price per sqft for a subdivision',
                'School ETA score for a boundary',
                'Investor index or appreciation rate',
              ].map((item, i) => (
                <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-500 mt-1.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-background/60 rounded-xl p-4 flex flex-col justify-center">
            <p className="text-sm text-gray-300">
              Pick a boundary, pick the metric you want to change, and enter the new value. The map updates immediately.
            </p>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="bg-surface border border-border-subtle rounded-2xl p-5 sticky top-4">
            <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4" /> New Override
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Boundary type</label>
                <select
                  value={overrideBoundary}
                  onChange={(e) => {
                    setOverrideBoundary(e.target.value as BoundaryKey);
                    setOverrideBoundaryId('');
                  }}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                >
                  {BOUNDARY_OPTIONS.map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Boundary ID / name</label>
                <input
                  list="boundary-options"
                  value={overrideBoundaryId}
                  onChange={(e) => setOverrideBoundaryId(e.target.value)}
                  placeholder={overrideBoundary === 'zipcodes' ? 'e.g. 77042' : 'e.g. ASHFORD COVE'}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
                <datalist id="boundary-options">
                  {boundaryValueOptions.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Metric to change</label>
                <select
                  value={overrideMetric}
                  onChange={(e) => setOverrideMetric(e.target.value as MetricKey)}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                >
                  {METRIC_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">New value</label>
                <input
                  type="number"
                  value={overrideValue}
                  onChange={(e) => setOverrideValue(e.target.value)}
                  placeholder="New median value"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Note (optional)</label>
                <input
                  value={overrideNote}
                  onChange={(e) => setOverrideNote(e.target.value)}
                  placeholder="Why this override exists"
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
              </div>
              <button
                onClick={handleSaveOverride}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2"
              >
                <Save className="w-4 h-4" /> Save Override
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-surface border border-border-subtle rounded-2xl p-5">
            <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4" /> Active Overrides
            </h3>
            {overrides.length === 0 ? (
              <div className="text-sm text-gray-500 py-8 text-center bg-background/40 rounded-xl border border-border-subtle">
                No manual overrides yet.
              </div>
            ) : (
              <div className="space-y-2 max-h-[600px] overflow-auto pr-1">
                {overrides.map((o) => (
                  <div key={o.id} className="bg-background border border-border-subtle rounded-xl p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">
                        {BOUNDARY_OPTIONS.find((b) => b.value === o.boundary)?.label || o.boundary}{' '}
                        <span className="text-purple-400">{o.boundaryId}</span>
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {METRIC_OPTIONS.find((m) => m.value === o.metric)?.label || o.metric}: {' '}
                        <span className="text-white font-medium">{formatNumber(o.value)}</span>
                        {o.note ? ` · ${o.note}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteOverride(o.id)}
                      className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors shrink-0"
                      title="Remove override"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-white flex font-sans">
      <style jsx global>{`
        :root {
          --background: #11131a;
          --surface: #1a1d27;
          --border-subtle: rgba(255, 255, 255, 0.08);
          --brand: #2563eb;
          --brand-hover: #1d4ed8;
        }
      `}</style>
      <aside className="w-64 shrink-0 bg-surface border-r border-border-subtle flex flex-col">
        <div className="p-4 border-b border-border-subtle">
          <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-4">
            <ArrowLeft className="w-4 h-4" />
            <span className="text-xs font-medium">Back to site</span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow">
              <span className="text-white font-bold text-lg">K</span>
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-tight">CMS</h1>
              <p className="text-[10px] text-gray-500">Data Manager</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-auto">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left ${
                section === s.id ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:bg-background hover:text-white'
              }`}
            >
              {s.icon}
              <span className="flex-1">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-border-subtle">
          <Link
            href="/map"
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg shadow flex items-center justify-center gap-2 font-semibold text-sm transition-all"
          >
            <Map className="w-4 h-4" /> View Map
          </Link>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="bg-surface border-b border-border-subtle px-6 py-4 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <p className="text-xs text-gray-400">{SECTIONS.find((s) => s.id === section)?.desc}</p>
          </div>
          <div className="text-xs text-gray-500">Engine rows: {getEngine().isLoaded ? formatNumber(getEngine().data.length) : '—'}</div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-6xl mx-auto">
            {loading ? (
              <div className="text-sm text-gray-400 py-12 text-center">Loading CMS…</div>
            ) : (
              <>
                {section === 'dashboard' && renderDashboard()}
                {section === 'sales' && renderDataSection('sales')}
                {section === 'rent' && renderDataSection('rent')}
                {section === 'current' && renderDataSection('current')}
                {section === 'tax' && renderDataSection('tax')}
                {section === 'schools' && renderDataSection('schools')}
                {section === 'areas' && renderAreas()}
              </>
            )}
          </div>
        </div>
      </main>

      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="bg-surface border border-border-subtle rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4" /> {previewFile.name}
              </h3>
              <button onClick={() => setPreviewFile(null)} className="p-1 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-auto p-0 flex-1">
              <table className="w-full text-left text-xs">
                <thead className="bg-background sticky top-0 z-10">
                  <tr>
                    {previewFile.headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-gray-400 font-medium border-b border-border-subtle whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewFile.rows.slice(0, 100).map((row, i) => (
                    <tr key={i} className="hover:bg-white/5">
                      {previewFile.headers.map((h) => (
                        <td key={h} className="px-3 py-2 text-gray-300 border-b border-white/5 whitespace-nowrap">{row[h]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t border-border-subtle text-xs text-gray-500">
              Showing first 100 of {previewFile.rows.length.toLocaleString()} rows
            </div>
          </div>
        </div>
      )}

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
