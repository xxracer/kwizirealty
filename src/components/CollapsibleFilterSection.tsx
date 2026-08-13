'use client';

import { useState, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface CollapsibleFilterSectionProps {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  dataTour?: string;
}

export default function CollapsibleFilterSection({
  icon,
  title,
  children,
  defaultOpen = true,
  className = '',
  dataTour,
}: CollapsibleFilterSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      data-tour={dataTour}
      className={`bg-[#121620] border border-white/[0.06] rounded-2xl shadow-sm overflow-hidden ${className}`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-gray-400 hover:text-white transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-[11px] font-bold uppercase tracking-wider">{title}</h3>
        </div>
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown className="w-4 h-4" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
