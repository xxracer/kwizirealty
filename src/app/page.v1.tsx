import Link from 'next/link';
import {
  Map,
  BarChart3,
  Search,
  TrendingUp,
  Shield,
  Zap,
  School,
  MousePointerClick,
  Check,
  Lock,
  ArrowRight,
  MessageSquare,
} from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0b0d12] flex flex-col font-sans text-white">
      {/* Navigation */}
      <header className="sticky top-0 z-50 bg-[#0b0d12]/80 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xl">K</span>
            </div>
            <span className="text-xl font-bold text-white">Kwizi Realty</span>
          </Link>
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-300">
            <Link href="#features" className="hover:text-white transition-colors">
              Features
            </Link>
            <Link href="#how-it-works" className="hover:text-white transition-colors">
              How it works
            </Link>
            <Link href="#pricing" className="hover:text-white transition-colors">
              Pricing
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              href="/map"
              className="text-sm font-medium text-gray-300 hover:text-white transition-colors"
            >
              Workbench
            </Link>
            <Link
              href="/map"
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              Start free
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 via-transparent to-emerald-500/10 pointer-events-none" />
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-24 text-center">
            <div className="inline-flex items-center gap-2 bg-white/5 border border-white/[0.06] rounded-full px-4 py-1.5 text-sm text-gray-300 mb-8">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Houston market intelligence, now live
            </div>
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight mb-6">
              Know every Houston neighborhood
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
                before you invest
              </span>
            </h1>
            <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mx-auto mb-10">
              Kwizi Market Explorer turns local sales, rental, and school data into interactive maps,
              area reports, and investment signals — all in one clean workbench.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href="/map"
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-3.5 rounded-xl font-semibold text-lg transition-colors shadow-lg shadow-blue-900/20"
              >
                <Map className="w-5 h-5" />
                Launch Market Explorer
              </Link>
              <Link
                href="#pricing"
                className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/[0.06] text-white px-8 py-3.5 rounded-xl font-semibold text-lg transition-colors"
              >
                See pricing
              </Link>
            </div>

            {/* Mini preview stats */}
            <div className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto">
              {[
                { label: 'Properties analyzed', value: '4,700+' },
                { label: 'Zip codes covered', value: '184' },
                { label: 'Boundary types', value: '6' },
                { label: 'Report metrics', value: '11' },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="bg-[#121620] border border-white/[0.06] rounded-xl p-4"
                >
                  <div className="text-2xl font-bold text-white mb-1">{stat.value}</div>
                  <div className="text-xs text-gray-400 uppercase tracking-wider">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="py-20 bg-[#121620]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">Everything you need to compare areas</h2>
              <p className="text-gray-400 max-w-2xl mx-auto">
                Skip the spreadsheets. Filter, select, and export insights in seconds.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                {
                  icon: <Map className="w-5 h-5" />,
                  title: 'Interactive map',
                  desc: 'Visualize any area by subdivisions, zip codes, school zones, or neighborhoods.',
                  color: 'blue',
                },
                {
                  icon: <BarChart3 className="w-5 h-5" />,
                  title: 'Area reports',
                  desc: 'Quick stats, market health, time series, forecast, and top-area comparisons.',
                  color: 'emerald',
                },
                {
                  icon: <Search className="w-5 h-5" />,
                  title: 'Smart filters',
                  desc: 'Price, rent, beds, baths, square footage, lot size, year built, DOM, and more.',
                  color: 'purple',
                },
                {
                  icon: <TrendingUp className="w-5 h-5" />,
                  title: "Investor's Index",
                  desc: 'Find the best opportunities using appreciation, rent-to-sale, and list-to-sale signals.',
                  color: 'orange',
                },
                {
                  icon: <School className="w-5 h-5" />,
                  title: 'School boundary view',
                  desc: 'Switch to high school, elementary, or middle school zones for family-focused buyers.',
                  color: 'pink',
                },
                {
                  icon: <MousePointerClick className="w-5 h-5" />,
                  title: 'Box & Lasso select',
                  desc: 'Select multiple areas at once, then generate one combined report.',
                  color: 'cyan',
                },
              ].map((feature) => (
                <div
                  key={feature.title}
                  className="bg-[#121620] border border-white/[0.06] rounded-2xl p-6 hover:border-white/20 transition-colors"
                >
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center mb-4 ${
                      feature.color === 'blue'
                        ? 'bg-blue-900/40 text-blue-400'
                        : feature.color === 'emerald'
                        ? 'bg-emerald-900/40 text-emerald-400'
                        : feature.color === 'purple'
                        ? 'bg-purple-900/40 text-purple-400'
                        : feature.color === 'orange'
                        ? 'bg-orange-900/40 text-orange-400'
                        : feature.color === 'pink'
                        ? 'bg-pink-900/40 text-pink-400'
                        : 'bg-cyan-900/40 text-cyan-400'
                    }`}
                  >
                    {feature.icon}
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                  <p className="text-sm text-gray-400 leading-relaxed">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">Three steps to a market report</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {[
                {
                  step: '01',
                  title: 'Choose a boundary',
                  desc: 'Start with zip codes, then explore subdivisions, school zones, or neighborhoods.',
                },
                {
                  step: '02',
                  title: 'Filter & select',
                  desc: 'Narrow by price, property type, beds/baths, and time period. Click or lasso areas.',
                },
                {
                  step: '03',
                  title: 'Read the report',
                  desc: 'Get instant charts, forecasts, health scores, and comparable top areas.',
                },
              ].map((item) => (
                <div key={item.step} className="relative">
                  <div className="text-5xl font-black text-white/10 mb-4">{item.step}</div>
                  <h3 className="text-xl font-semibold mb-2">{item.title}</h3>
                  <p className="text-gray-400">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-20 bg-[#121620]">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">Free to explore. Premium to scale.</h2>
              <p className="text-gray-400 max-w-2xl mx-auto">
                Start with the full map and core reports. Upgrade when you need deeper boundaries,
                export tools, and AI chat assistance.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Free */}
              <div className="bg-[#121620] border border-white/[0.06] rounded-2xl p-8">
                <div className="text-sm font-bold text-blue-400 uppercase tracking-wider mb-2">Free</div>
                <div className="text-4xl font-bold mb-6">$0</div>
                <ul className="space-y-4 mb-8">
                  {[
                    'Interactive map with zip-code boundaries',
                    'Core metrics: sales price, rent, price/sqft, DOM',
                    'Filters for price, beds, baths, square footage',
                    'Basic area reports with charts',
                    'Single-area selection',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-gray-300">
                      <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      {item}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/map"
                  className="block w-full text-center bg-white/5 hover:bg-white/10 border border-white/[0.06] text-white py-3 rounded-xl font-semibold transition-colors"
                >
                  Start exploring
                </Link>
              </div>

              {/* Premium */}
              <div className="bg-[#121620] border border-blue-500/30 rounded-2xl p-8 relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-blue-600 text-white text-xs font-bold px-3 py-1 rounded-bl-lg">
                  Coming soon
                </div>
                <div className="text-sm font-bold text-blue-400 uppercase tracking-wider mb-2">
                  Premium
                </div>
                <div className="text-4xl font-bold mb-6">$29/mo</div>
                <ul className="space-y-4 mb-8">
                  {[
                    'All Free features',
                    'Subdivision, school-zone & neighborhood boundaries',
                    'Multi-select box & lasso tools',
                    'Exportable PDF/CSV reports',
                    '5-year forecast & investor scoring',
                    'AI market assistant',
                    'Save favorites & custom searches',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-gray-300">
                      <Check className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                      {item}
                    </li>
                  ))}
                </ul>
                <button
                  disabled
                  className="block w-full text-center bg-blue-600/50 text-white/70 py-3 rounded-xl font-semibold cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4" />
                  Available soon
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <div className="bg-gradient-to-r from-blue-600/20 to-emerald-600/20 border border-white/[0.06] rounded-3xl p-10 sm:p-14">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">Ready to explore Houston?</h2>
              <p className="text-gray-400 mb-8 max-w-xl mx-auto">
                Launch the free Market Explorer and start comparing areas in seconds.
              </p>
              <Link
                href="/map"
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-3.5 rounded-xl font-semibold text-lg transition-colors"
              >
                <Zap className="w-5 h-5" />
                Open the workbench
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/[0.06] py-10 bg-[#0b0d12]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center">
              <span className="text-white font-bold text-xs">K</span>
            </div>
            <span>Kwizi Realty</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/map" className="hover:text-white transition-colors">
              Workbench
            </Link>
            <Link href="#pricing" className="hover:text-white transition-colors">
              Pricing
            </Link>
            <Link href="/admin" className="hover:text-white transition-colors">
              Admin
            </Link>
          </div>
          <div>© {new Date().getFullYear()} Kwizi Realty. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
