'use client';

import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import {
  Map,
  BarChart3,
  TrendingUp,
  School,
  Search,
  SlidersHorizontal,
  Loader2,
  Bot,
  Globe,
  Database,
  Crosshair,
  ShieldCheck,
  ChevronRight,
  Check,
  PlayCircle
} from 'lucide-react';

const MapComponent = dynamic(() => import('@/components/MapComponent'), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full bg-[#0a0c10] flex items-center justify-center">
      <Loader2 className="w-6 h-6 text-[#7ef29d] animate-spin" />
    </div>
  ),
});

const capabilities = [
  {
    icon: <Map className="w-5 h-5" />,
    title: 'Interactive Houston map',
    body: 'Color-coded ZIP codes, neighborhoods, school zones, and subdivisions. Click, box, or lasso to build your selection.',
  },
  {
    icon: <BarChart3 className="w-5 h-5" />,
    title: 'Live area reports',
    body: 'Median price, rent, price per sq.ft., appreciation, days on market, and the Investor\'s Index — updated as you filter.',
  },
  {
    icon: <TrendingUp className="w-5 h-5" />,
    title: '5-year forecast',
    body: 'See fitted trends, forecast lines, and prediction intervals for any selected region or comparison set.',
  },
  {
    icon: <School className="w-5 h-5" />,
    title: 'School-district intelligence',
    body: 'Filter by elementary, middle, and high-school ratings, or switch boundaries to see market behavior by school zone.',
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white flex flex-col font-sans selection:bg-[#7ef29d]/30 selection:text-[#7ef29d]">
      {/* Navigation (ACRES style: White background) */}
      <header className="sticky top-0 z-50 bg-white border-b border-gray-100">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          
          <div className="flex items-center gap-10">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded bg-[#111] flex items-center justify-center">
                <span className="text-white font-bold text-lg">K</span>
              </div>
              <span className="text-xl font-bold text-[#111] tracking-tight">Kwizi</span>
            </Link>

            <nav className="hidden md:flex items-center gap-8 text-[15px] font-medium text-[#4a5568]">
              <Link href="/map" className="hover:text-black transition-colors">Map</Link>
              <Link href="#product" className="hover:text-black transition-colors">Features</Link>
              <Link href="/about" className="hover:text-black transition-colors">About Us</Link>
            </nav>
          </div>

          <div className="flex items-center">
            <Link href="#contact" className="hidden lg:block text-[15px] font-medium text-[#4a5568] hover:text-black transition-colors mr-6">
              Contact Us
            </Link>
            <div className="h-6 w-px bg-gray-300 mx-4 hidden sm:block"></div>
            
            <div className="flex items-center gap-3 ml-2">
              <Link href="/admin" className="hidden sm:flex items-center justify-center border border-[#cbd5e1] text-[#0f172a] hover:bg-gray-50 px-5 py-2.5 rounded text-[15px] font-semibold transition-colors">
                Log In
              </Link>
              <Link
                href="/map"
                className="flex items-center gap-2 bg-[#7ef29d] hover:bg-[#68e08a] text-black px-6 py-2.5 rounded text-[15px] font-semibold transition-colors"
              >
                Start For Free
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 bg-[#05090f]">
        {/* Hero Section (Shorter with map background) */}
        <section className="relative overflow-hidden pt-4 pb-8 lg:pt-6 lg:pb-10 bg-[#05090f]">
          {/* Map Background Image */}
          <div 
            className="absolute inset-0 z-0 opacity-20 pointer-events-none"
            style={{
              backgroundImage: "url('/hero_map_bg.png')",
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat'
            }}
          />
          {/* Gradient overlay to ensure text readability */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#05090f] via-[#05090f]/90 to-transparent z-0" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#05090f] via-transparent to-transparent z-0" />

          <div className="relative max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 z-10">
            <div className="grid md:grid-cols-2 lg:grid-cols-[1.1fr,0.9fr] gap-6 lg:gap-8 items-center">
              
              {/* Left Column: Bold Typography */}
              <div className="max-w-2xl lg:pr-8">
                <h1 className="text-3xl sm:text-4xl lg:text-[50px] font-extrabold tracking-tight mb-4 leading-[1.1] text-white">
                  The First AI Agent Built for Real Estate
                </h1>

                <p className="text-base sm:text-lg text-gray-300 mb-6 leading-relaxed font-normal">
                  A single system for sourcing, diligence, and strategy in the Houston metro area. Make data-driven land and property decisions faster than ever.
                </p>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                  <Link
                    href="/map"
                    className="flex justify-center items-center gap-2 bg-[#7ef29d] hover:bg-[#68e08a] text-black px-6 py-3 rounded text-base font-bold transition-colors"
                  >
                    Launch Explorer
                  </Link>
                </div>
              </div>

              {/* Right Column: Perspective Mobile Mockup */}
              <div className="relative flex justify-center perspective-[2000px] mt-8 md:mt-0">
                {/* 3D Tilted Wrapper */}
                <div 
                  className="relative transform-gpu rotate-y-[-12deg] rotate-x-[4deg] hover:rotate-y-0 hover:rotate-x-0 transition-transform duration-1000 ease-out"
                  style={{ transformStyle: 'preserve-3d' }}
                >
                  {/* The iPhone CSS Mockup (Scaled Down) */}
                  <div className="relative w-[240px] h-[480px] lg:w-[280px] lg:h-[560px] bg-[#0a0c10] rounded-[2.5rem] border-[8px] border-[#1f2228] shadow-[0_25px_50px_-12px_rgba(126,242,157,0.15)] overflow-hidden shrink-0 ring-1 ring-white/10 bg-gradient-to-br from-[#1a1d24] to-[#0a0c10]">
                    
                    {/* Dynamic Island / Notch */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[110px] h-[28px] bg-[#1f2228] rounded-b-2xl z-50 flex items-center justify-center gap-3 shadow-sm">
                      <div className="w-10 h-1 rounded-full bg-black/60" />
                      <div className="w-2.5 h-2.5 rounded-full bg-[#111] flex items-center justify-center border border-white/5"><div className="w-1 h-1 bg-blue-900 rounded-full" /></div>
                    </div>
                    
                    {/* Live Map Component inside the Phone */}
                    <div className="absolute inset-0 z-0 pointer-events-none opacity-90">
                      <MapComponent
                        boundary="zipcodes"
                        metricValues={{}}
                        sampleCounts={{}}
                        nameMap={{}}
                        colorStops={[]}
                        selectedIds={[]}
                        onSelectionChange={() => {}}
                        multiSelect={false}
                        rawData={[]}
                        showSales={false}
                        showRentals={false}
                        showFlood={false}
                        metricLabel=""
                        fillOpacity={0.6}
                      />
                    </div>

                    {/* Gradient Overlay for Chatbot visibility */}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#05090f] via-black/40 to-transparent z-10" />

                    {/* Chatbot Overlay UI */}
                    <div className="absolute bottom-5 left-4 right-4 z-20">
                      <div className="bg-[#111]/90 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 shadow-2xl relative overflow-hidden">
                        <div className="absolute -top-10 -right-10 w-24 h-24 bg-[#7ef29d]/10 rounded-full blur-2xl" />
                        
                        <div className="flex items-start gap-3 mb-3 relative z-10">
                          <div className="w-8 h-8 rounded-lg bg-[#7ef29d] flex items-center justify-center shrink-0">
                            <Bot className="w-4 h-4 text-black" />
                          </div>
                          <div className="flex-1 pt-0.5">
                            <p className="text-[12px] font-medium text-gray-200 mb-2 leading-snug">
                              I have gathered the requested information and I am currently loading the data to generate your report...
                            </p>
                            <div className="flex items-center gap-1.5 text-[#7ef29d] text-[10px] font-bold tracking-wide">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              PROCESSING DATA
                            </div>
                          </div>
                        </div>
                        
                        <div className="space-y-2.5 mt-3 pt-3 border-t border-white/5 relative z-10">
                          <div className="flex items-center justify-between">
                            <div className="h-1.5 w-24 bg-white/10 rounded-full" />
                            <div className="h-1.5 w-8 bg-[#7ef29d]/50 rounded-full" />
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="h-1.5 w-16 bg-white/10 rounded-full" />
                            <div className="h-1.5 w-12 bg-white/20 rounded-full" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Trust Band */}
        <section className="bg-gradient-to-b from-[#032415] to-[#01140b] py-16 border-y border-[#7ef29d]/10">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid lg:grid-cols-[1fr,1fr] gap-10 items-center">
              <div>
                <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white leading-[1.1]">
                  Over <span className="text-[#7ef29d]">$40 Billion</span> in <br />
                  Land Decisions Made <br />
                  Annually With Kwizi
                </h2>
              </div>
              <div>
                <p className="text-lg text-gray-300 leading-relaxed font-medium mb-8 max-w-lg">
                  The nation's best real estate teams rely on Kwizi Intelligence to move faster, catch risks earlier, and close more of the right deals.
                </p>
                <div className="flex items-center gap-8 opacity-60 grayscale">
                  <div className="text-xl font-bold font-serif tracking-widest">CBRE</div>
                  <div className="text-xl font-bold italic">LENNAR</div>
                  <div className="text-xl font-bold uppercase">Vulcan</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Feature Highlights */}
        <section className="py-24 bg-black border-b border-white/5">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid lg:grid-cols-2 gap-16 items-center">
              <div className="order-2 lg:order-1 relative">
                <div className="aspect-[4/3] rounded-2xl bg-[#0a0c10] border border-white/10 overflow-hidden shadow-2xl relative p-6">
                  {/* Fake UI mockup to represent data analysis */}
                  <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "url('/hero_map_bg.png')", backgroundSize: 'cover' }} />
                  <div className="relative z-10 space-y-6">
                    <div className="w-full bg-[#111]/80 backdrop-blur border border-white/10 rounded-xl p-4">
                      <div className="flex items-center gap-3 mb-4">
                        <Search className="w-4 h-4 text-[#7ef29d]" />
                        <div className="h-2 w-32 bg-white/20 rounded" />
                      </div>
                      <div className="space-y-3">
                        <div className="h-2 w-full bg-white/10 rounded" />
                        <div className="h-2 w-5/6 bg-white/10 rounded" />
                        <div className="h-2 w-4/6 bg-white/10 rounded" />
                      </div>
                    </div>
                    <div className="w-3/4 ml-auto bg-[#7ef29d]/10 backdrop-blur border border-[#7ef29d]/20 rounded-xl p-4">
                      <div className="flex items-center gap-3 mb-3">
                        <Database className="w-4 h-4 text-[#7ef29d]" />
                        <div className="h-2 w-24 bg-[#7ef29d]/40 rounded" />
                      </div>
                      <div className="h-12 w-full bg-black/40 rounded border border-[#7ef29d]/10" />
                    </div>
                  </div>
                </div>
              </div>
              <div className="order-1 lg:order-2">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded bg-[#7ef29d]/10 text-[#7ef29d] text-sm font-bold tracking-wide uppercase mb-6">
                  <Crosshair className="w-4 h-4" /> Comprehensive Data
                </div>
                <h3 className="text-3xl sm:text-4xl font-extrabold mb-6 leading-tight">Uncover off-market opportunities with precision.</h3>
                <p className="text-gray-400 text-lg leading-relaxed mb-8">
                  Stop relying on outdated county records. Kwizi aggregates millions of data points—from zoning and floodplains to historical sales and school ratings—so you can identify high-value parcels before they hit the market.
                </p>
                <ul className="space-y-4">
                  {[
                    'Instant property ownership lookup',
                    'Historical sales and tax data',
                    'Interactive zoning and flood overlays'
                  ].map((item, i) => (
                    <li key={i} className="flex items-center gap-3 text-gray-300">
                      <Check className="w-5 h-5 text-[#7ef29d]" /> {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Cinematic Video Section (Using Client Location Video) */}
        <section className="relative h-[600px] bg-black border-b border-white/5 overflow-hidden flex items-center justify-center">
          <video 
            autoPlay 
            loop 
            muted 
            playsInline
            className="absolute inset-0 w-full h-full object-cover opacity-40 mix-blend-luminosity grayscale hover:grayscale-0 hover:opacity-70 transition-all duration-1000"
          >
            <source src="/image/4AB04F9D-849B-4B65-B12B-BB0CEF6FBA4E.mp4" type="video/mp4" />
          </video>
          
          <div className="relative z-10 text-center max-w-4xl mx-auto px-4">
            <h2 className="text-4xl md:text-5xl lg:text-6xl font-extrabold text-white mb-6 drop-shadow-xl">
              Understand the ground truth.
            </h2>
            <p className="text-xl text-gray-200 mb-10 max-w-2xl mx-auto drop-shadow-md">
              From dense urban cores to sprawling suburban developments, our platform provides context to every location across Texas.
            </p>
            <button className="inline-flex items-center gap-2 bg-white hover:bg-gray-100 text-black px-8 py-3.5 rounded text-lg font-bold transition-colors">
              <PlayCircle className="w-5 h-5" /> See the platform in action
            </button>
          </div>
          
          <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black pointer-events-none" />
        </section>

        {/* Neighborhood Intelligence (Using Client Location Images) */}
        <section className="py-24 bg-[#03060a] border-b border-white/5">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-3xl mx-auto mb-16">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded bg-[#7ef29d]/10 text-[#7ef29d] text-sm font-bold tracking-wide uppercase mb-6">
                <Globe className="w-4 h-4" /> Regional Coverage
              </div>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                Hyper-local intelligence across Houston.
              </h2>
              <p className="text-gray-400 text-lg">
                Explore dedicated insights tailored to specific communities and their unique market dynamics.
              </p>
            </div>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div className="group relative h-80 rounded-2xl overflow-hidden border border-white/10 bg-black cursor-pointer">
                <div className="absolute inset-0 bg-[url('/image/katy-tx.jpg')] bg-cover bg-center opacity-40 group-hover:opacity-70 group-hover:scale-105 transition-all duration-700 ease-out" />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
                <div className="absolute bottom-0 left-0 p-8 w-full">
                  <h3 className="text-3xl font-extrabold text-white mb-2">Katy, TX</h3>
                  <div className="flex justify-between items-center text-gray-300">
                    <p className="font-medium">Suburban expansion analysis</p>
                    <span className="text-[#7ef29d] font-bold flex items-center gap-1">
                      <TrendingUp className="w-4 h-4" /> +8.2%
                    </span>
                  </div>
                </div>
              </div>
              
              <div className="group relative h-80 rounded-2xl overflow-hidden border border-white/10 bg-black cursor-pointer">
                <div className="absolute inset-0 bg-[url('/image/beach-galveston-island-texas.jpg')] bg-cover bg-center opacity-40 group-hover:opacity-70 group-hover:scale-105 transition-all duration-700 ease-out" />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
                <div className="absolute bottom-0 left-0 p-8 w-full">
                  <h3 className="text-3xl font-extrabold text-white mb-2">Galveston</h3>
                  <div className="flex justify-between items-center text-gray-300">
                    <p className="font-medium">Coastal property intelligence</p>
                    <span className="text-[#7ef29d] font-bold flex items-center gap-1">
                      <TrendingUp className="w-4 h-4" /> +5.4%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Bento Box Gallery (Using Client IMG files) */}
        <section className="py-24 bg-black border-b border-white/5">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-16">
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                Real world validation.
              </h2>
              <p className="text-gray-400 text-lg max-w-2xl">
                A closer look at the properties and data points we analyze daily to bring you the best market intelligence.
              </p>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 grid-rows-2 gap-4 h-[600px]">
              {/* Large block */}
              <div className="col-span-2 row-span-2 relative rounded-2xl overflow-hidden border border-white/10 group">
                <div className="absolute inset-0 bg-[url('/image/IMG_2183.jpeg')] bg-cover bg-center opacity-60 group-hover:opacity-80 transition-opacity duration-500" />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent" />
                <div className="absolute bottom-6 left-6 right-6">
                  <div className="bg-black/60 backdrop-blur-md border border-white/10 p-4 rounded-xl">
                    <p className="text-sm text-gray-300 font-bold uppercase tracking-wider mb-1">Featured Asset</p>
                    <p className="text-white font-medium">Urban residential analysis and valuation modeling.</p>
                  </div>
                </div>
              </div>
              
              {/* Top right blocks */}
              <div className="relative rounded-2xl overflow-hidden border border-white/10 group">
                 <div className="absolute inset-0 bg-[url('/image/IMG_2186.jpeg')] bg-cover bg-center opacity-60 group-hover:opacity-90 transition-opacity duration-500" />
              </div>
              <div className="relative rounded-2xl overflow-hidden border border-white/10 group">
                 <div className="absolute inset-0 bg-[url('/image/IMG_2188.jpeg')] bg-cover bg-center opacity-60 group-hover:opacity-90 transition-opacity duration-500" />
              </div>
              
              {/* Bottom right blocks */}
              <div className="col-span-2 relative rounded-2xl overflow-hidden border border-white/10 group">
                 <div className="absolute inset-0 bg-[url('/image/IMG_2190.jpeg')] bg-cover bg-center opacity-50 group-hover:opacity-80 transition-opacity duration-500" />
                 <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="bg-black/80 backdrop-blur px-6 py-2 rounded-full border border-white/10 text-white font-bold tracking-wide shadow-2xl">
                      Property Portfolios
                    </div>
                 </div>
              </div>
            </div>
          </div>
        </section>

        {/* Capabilities Grid */}
        <section id="product" className="py-24 bg-[#05090f]">
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-16">
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                Built for speed and precision.
              </h2>
              <p className="text-gray-400 text-lg max-w-2xl">
                A complete suite of tools designed specifically for real estate professionals in the Houston market.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {capabilities.map((c) => (
                <div key={c.title} className="bg-[#0a0c10] border border-white/5 rounded-xl p-6 hover:bg-[#111] transition-colors group">
                  <div className="w-10 h-10 rounded bg-[#7ef29d]/10 text-[#7ef29d] flex items-center justify-center mb-5 group-hover:scale-110 transition-transform">
                    {c.icon}
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">{c.title}</h3>
                  <p className="text-sm text-gray-400 leading-relaxed">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-24 bg-gradient-to-b from-black to-[#021008] border-t border-white/5 text-center">
           <div className="max-w-3xl mx-auto px-4">
              <h2 className="text-4xl sm:text-5xl font-extrabold mb-6">Ready to see the full picture?</h2>
              <p className="text-xl text-gray-400 mb-10">Join the top land teams using Kwizi to source and evaluate property in seconds.</p>
              <Link
                href="/map"
                className="inline-flex justify-center items-center gap-2 bg-[#7ef29d] hover:bg-[#68e08a] text-black px-10 py-4 rounded text-lg font-bold transition-colors"
              >
                Start For Free
              </Link>
           </div>
        </section>

      </main>

      {/* Footer (Acres style) */}
      <footer className="bg-black pt-20 pb-10 border-t border-white/10">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-12 mb-20">
            <div className="col-span-2 pr-12">
              <Link href="/" className="flex items-center gap-3 mb-8">
                <div className="w-10 h-10 bg-[#7ef29d] rounded flex items-center justify-center">
                  <span className="text-black font-extrabold text-xl">K</span>
                </div>
                <span className="font-extrabold text-2xl text-white tracking-tight">Kwizi</span>
              </Link>
              <p className="text-gray-400 text-lg max-w-sm leading-relaxed">
                The ultimate Houston real estate analytics platform. Make smarter decisions with live data, interactive maps, and AI insights.
              </p>
            </div>
            
            <div>
              <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-sm">Product</h4>
              <ul className="space-y-4 text-base text-gray-400 font-medium">
                <li><Link href="/map" className="hover:text-[#7ef29d] transition-colors">Market Explorer</Link></li>
                <li><Link href="/about" className="hover:text-[#7ef29d] transition-colors">About Us</Link></li>
                <li><Link href="/admin" className="hover:text-[#7ef29d] transition-colors">Admin Login</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-white mb-6 uppercase tracking-widest text-sm">Legal</h4>
              <ul className="space-y-4 text-base text-gray-400 font-medium">
                <li><Link href="/privacy" className="hover:text-[#7ef29d] transition-colors">Privacy Policy</Link></li>
                <li><Link href="/terms" className="hover:text-[#7ef29d] transition-colors">Terms of Service</Link></li>
                <li><Link href="#contact" className="hover:text-[#7ef29d] transition-colors">Contact Us</Link></li>
              </ul>
            </div>
          </div>
          
          <div className="pt-8 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500 font-medium">
            <div>© {new Date().getFullYear()} Kwizi Realty. All rights reserved.</div>
            <div className="flex gap-6">
              <a href="#" className="hover:text-white transition-colors">Twitter</a>
              <a href="#" className="hover:text-white transition-colors">LinkedIn</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
