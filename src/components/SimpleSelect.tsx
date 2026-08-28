'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

interface SimpleSelectProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string }[];
  className?: string;
}

const PANEL_MAX_HEIGHT = 288; // px — matches max-h-72
const PANEL_GAP = 4;

/**
 * Lightweight dropdown that replaces the native <select> so we have full control
 * over styling, dark theme contrast and z-index.
 *
 * The panel is rendered in a portal with `position: fixed` because these
 * selects live inside CollapsibleFilterSection, which uses `overflow-hidden`
 * for its collapse animation — an absolutely-positioned panel would be clipped
 * to a few pixels tall (and its options unclickable).
 */
export default function SimpleSelect<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: SimpleSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.key === value);

  const updateRect = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom, left: r.left, width: r.width });
  }, []);

  // Track scroll/resize while open so the panel follows the trigger.
  useEffect(() => {
    if (!open) return;
    updateRect();
    const onReposition = () => updateRect();
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open, updateRect]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const panelHeight = Math.min(PANEL_MAX_HEIGHT, options.length * 40 + 8);
  const openUpward =
    rect !== null && rect.top + PANEL_GAP + panelHeight > window.innerHeight;
  const panelStyle: React.CSSProperties | undefined = rect
    ? {
        position: 'fixed',
        left: rect.left,
        width: Math.max(rect.width, 220),
        maxHeight: PANEL_MAX_HEIGHT,
        ...(openUpward
          ? { bottom: window.innerHeight - rect.top + PANEL_GAP }
          : { top: rect.top + PANEL_GAP }),
      }
    : undefined;

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full bg-white/5 border border-white/[0.08] text-white text-sm rounded-xl px-3 py-2.5 pr-9 outline-none hover:border-white/20 focus:border-blue-500/60 transition-colors flex items-center justify-between text-left"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={panelStyle}
            className="z-[9500] overflow-y-auto bg-[#121620] border border-white/[0.08] rounded-xl shadow-2xl py-1"
          >
            {options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="option"
                aria-selected={opt.key === value}
                onClick={() => {
                  onChange(opt.key);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  opt.key === value ? 'bg-blue-500/20 text-blue-300' : 'text-gray-200 hover:bg-white/5'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}