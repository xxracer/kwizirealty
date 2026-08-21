'use client';

import { motion } from 'framer-motion';
import { Check, X, Zap, Crown, Building2, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

const tiers = [
  {
    name: 'Basic',
    id: 'tier-basic',
    href: '/login',
    priceMonthly: '$49',
    description: 'Essential market insights for independent agents.',
    icon: <Zap className="w-6 h-6 text-blue-400" />,
    features: [
      'Access to standard zip codes & schools',
      'Basic property filters',
      'Generate up to 10 reports/month',
      'Top 5 area comparisons',
      'Standard email support',
    ],
    notIncluded: ['Custom GeoJSON areas', 'Advanced AI forecasting', 'White-label PDF reports'],
    featured: false,
    cta: 'Start Free Trial',
  },
  {
    name: 'Pro',
    id: 'tier-pro',
    href: '/login',
    priceMonthly: '$149',
    description: 'Advanced analytics for top-performing realtors.',
    icon: <Crown className="w-6 h-6 text-purple-400" />,
    features: [
      'Everything in Basic, plus:',
      'Unlimited report generation',
      'Custom GeoJSON area uploads',
      'Advanced AI market forecasting',
      'Custom branding on PDFs',
      'Priority 24/7 support',
    ],
    notIncluded: [],
    featured: true,
    cta: 'Get Pro',
  },
  {
    name: 'Enterprise',
    id: 'tier-enterprise',
    href: '/login',
    priceMonthly: 'Custom',
    description: 'Full-scale solutions for brokerages & teams.',
    icon: <Building2 className="w-6 h-6 text-emerald-400" />,
    features: [
      'Everything in Pro, plus:',
      'Multi-user team management',
      'API access to property data',
      'Dedicated account manager',
      'Custom AI model tuning',
      'SLA guarantee',
    ],
    notIncluded: [],
    featured: false,
    cta: 'Contact Sales',
  },
];

export default function PricingPage() {
  const [isAnnual, setIsAnnual] = useState(true);

  return (
    <div className="min-h-screen bg-[#020817] text-white selection:bg-blue-500/30 font-sans relative overflow-hidden">
      {/* Dynamic Background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-blue-600/20 blur-[120px] mix-blend-screen animate-pulse" />
        <div className="absolute top-[40%] -right-[20%] w-[50%] h-[70%] rounded-full bg-purple-600/20 blur-[150px] mix-blend-screen" />
        <div className="absolute inset-0 bg-[url('/grid.svg')] bg-center opacity-10" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-24 sm:py-32 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl font-bold tracking-tight sm:text-6xl text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400"
          >
            Pricing that scales with you
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mt-6 text-lg leading-8 text-gray-300 max-w-2xl mx-auto"
          >
            Unlock the full potential of Houston&apos;s real estate market. Choose the plan that best fits your needs, whether you&apos;re a solo agent or a large brokerage.
          </motion.p>
        </div>

        {/* Toggle Billing */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="mt-16 flex justify-center"
        >
          <div className="relative flex items-center p-1 rounded-full bg-white/5 border border-white/10">
            <button
              onClick={() => setIsAnnual(false)}
              className={`relative w-32 py-2 text-sm font-medium transition-colors z-10 ${
                !isAnnual ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setIsAnnual(true)}
              className={`relative w-32 py-2 text-sm font-medium transition-colors z-10 ${
                isAnnual ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Annually <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold">-20%</span>
            </button>
            <div
              className={`absolute inset-y-1 w-32 bg-blue-600 rounded-full transition-transform duration-300 ease-in-out shadow-lg shadow-blue-500/25 ${
                isAnnual ? 'translate-x-32' : 'translate-x-0'
              }`}
            />
          </div>
        </motion.div>

        {/* Pricing Cards */}
        <div className="mx-auto mt-16 grid max-w-lg grid-cols-1 gap-y-6 sm:mt-20 lg:max-w-none lg:grid-cols-3 lg:gap-8">
          {tiers.map((tier, idx) => (
            <motion.div
              key={tier.id}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + idx * 0.1 }}
              className={`relative flex flex-col justify-between rounded-3xl p-8 xl:p-10 ${
                tier.featured
                  ? 'bg-gradient-to-b from-[#1e293b] to-[#0f172a] border border-blue-500/50 shadow-2xl shadow-blue-900/50 ring-1 ring-blue-500/20'
                  : 'bg-white/5 border border-white/10 backdrop-blur-sm hover:border-white/20 transition-colors'
              }`}
            >
              {tier.featured && (
                <div className="absolute -top-5 inset-x-0 flex justify-center">
                  <span className="bg-gradient-to-r from-blue-500 to-purple-500 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-lg">
                    Most Popular
                  </span>
                </div>
              )}
              
              <div>
                <div className="flex items-center justify-between gap-x-4">
                  <h3 id={tier.id} className="text-xl font-bold leading-8 text-white">
                    {tier.name}
                  </h3>
                  <div className={`p-2 rounded-xl ${tier.featured ? 'bg-blue-500/20' : 'bg-white/5'}`}>
                    {tier.icon}
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-gray-400">{tier.description}</p>
                <div className="mt-6 flex items-baseline gap-x-1">
                  <span className="text-4xl font-bold tracking-tight text-white">
                    {tier.priceMonthly === 'Custom' 
                      ? 'Custom' 
                      : isAnnual 
                        ? `$${Math.floor(parseInt(tier.priceMonthly.replace('$', '')) * 0.8)}`
                        : tier.priceMonthly}
                  </span>
                  {tier.priceMonthly !== 'Custom' && (
                    <span className="text-sm font-semibold leading-6 text-gray-400">/month</span>
                  )}
                </div>
                {tier.priceMonthly !== 'Custom' && isAnnual && (
                  <p className="mt-1 text-xs text-emerald-400">Billed annually</p>
                )}

                <ul role="list" className="mt-8 space-y-3 text-sm leading-6 text-gray-300">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex gap-x-3 items-start">
                      <Check className="h-5 w-5 flex-none text-emerald-400 mt-0.5" aria-hidden="true" />
                      {feature}
                    </li>
                  ))}
                  {tier.notIncluded.map((feature) => (
                    <li key={feature} className="flex gap-x-3 items-start text-gray-500">
                      <X className="h-5 w-5 flex-none text-gray-600 mt-0.5" aria-hidden="true" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
              <Link
                href={tier.href}
                aria-describedby={tier.id}
                className={`mt-8 block rounded-xl px-3 py-3 text-center text-sm font-semibold leading-6 transition-all duration-200 flex items-center justify-center gap-2 group ${
                  tier.featured
                    ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/25'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                {tier.cta}
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
