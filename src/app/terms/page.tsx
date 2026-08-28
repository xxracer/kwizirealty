import Link from 'next/link';

export const metadata = {
  title: 'Terms of Service | Kwizi',
  description: 'The terms that govern your use of the Kwizi real estate analytics platform.',
};

const SECTION = 'mb-8';
const H2 = 'text-lg font-semibold text-white mb-3';
const P = 'text-sm text-gray-400 leading-relaxed mb-3';
const UL = 'list-disc list-inside text-sm text-gray-400 space-y-1.5 mb-3 ml-1';

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#05090f] text-white">
      <header className="border-b border-white/[0.06]">
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold">
            kwizi<span className="text-[#7ef29d]">.</span>
          </Link>
          <Link
            href="/map"
            className="text-sm px-4 py-2 rounded-xl bg-white/[0.06] border border-white/10 hover:bg-white/10 transition-colors"
          >
            Open Map
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-10">Last updated: August 28, 2026</p>

        <div className={SECTION}>
          <h2 className={H2}>1. Acceptance</h2>
          <p className={P}>
            By accessing or using Kwizi (&quot;the Service&quot;), you agree to these Terms of Service and to
            our{' '}
            <Link href="/privacy" className="text-[#7ef29d] hover:underline">
              Privacy Policy
            </Link>
            . If you do not agree, do not use the Service.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>2. Accounts</h2>
          <ul className={UL}>
            <li>You must sign in with a valid Google account to use the map and reports.</li>
            <li>You are responsible for activity that happens under your account.</li>
            <li>Accounts are for individual use; sharing credentials across a team requires a company plan.</li>
            <li>We may suspend or terminate accounts that violate these terms or abuse the platform.</li>
          </ul>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>3. Nature of the Data — No Professional Advice</h2>
          <p className={P}>
            Kwizi aggregates publicly available and licensed real estate data (listings, sales, tax, school,
            flood, and geographic information) for the Greater Houston area. You acknowledge that:
          </p>
          <ul className={UL}>
            <li>Data may be delayed, incomplete, or inaccurate; figures such as averages, medians, forecasts, and scores are statistical estimates.</li>
            <li>Nothing in the Service — including AI-generated responses — constitutes real estate, legal, tax, financial, or investment advice.</li>
            <li>You are solely responsible for verifying any information before relying on it in a transaction.</li>
          </ul>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>4. AI Assistant (Hommie)</h2>
          <ul className={UL}>
            <li>The Service includes an AI chat assistant powered by the Google Gemini model.</li>
            <li>AI responses are generated automatically and can be inaccurate or incomplete.</li>
            <li>You agree not to enter personal or confidential information into the chat.</li>
            <li>You agree not to use the assistant to generate unlawful, harassing, or misleading content.</li>
          </ul>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>5. Acceptable Use</h2>
          <ul className={UL}>
            <li>Do not scrape, bulk-export, resell, or redistribute the data available through the Service.</li>
            <li>Do not attempt to access admin functionality, other users&apos; accounts, or non-public data.</li>
            <li>Do not interfere with the operation of the Service or exceed reasonable usage limits.</li>
          </ul>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>6. Sponsored Advertising</h2>
          <p className={P}>
            The Service may display sponsored banners, videos, or links marked as &quot;Sponsored&quot;.
            Advertisements are third-party content; we do not endorse advertised products or services and are
            not party to any transaction between you and an advertiser.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>7. Intellectual Property</h2>
          <p className={P}>
            The Service, its software, design, and compiled datasets are owned by Kwizi and its licensors.
            You receive a limited, non-exclusive, revocable license to use the Service for its intended
            purpose. Data providers may impose additional restrictions on portions of the underlying data.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>8. Disclaimer of Warranties</h2>
          <p className={P}>
            THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY
            KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
            ACCURACY OF DATA. WE DO NOT GUARANTEE UNINTERRUPTED OR ERROR-FREE OPERATION.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>9. Limitation of Liability</h2>
          <p className={P}>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, KWIZI WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
            SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, DATA, OR BUSINESS
            OPPORTUNITIES ARISING FROM YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT
            EXCEED THE AMOUNT YOU PAID US IN THE 12 MONTHS PRECEDING THE CLAIM.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>10. Changes, Governing Law &amp; Contact</h2>
          <p className={P}>
            We may modify these Terms; continued use after changes are posted constitutes acceptance. These
            Terms are governed by the laws of the State of Texas, USA.
          </p>
          <p className={P}>
            Questions: <span className="text-[#7ef29d]">[legal contact email]</span>
          </p>
        </div>
      </main>
    </div>
  );
}