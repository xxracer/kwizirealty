import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy | Kwizi',
  description: 'How Kwizi collects, uses, and protects your data — including our AI assistant.',
};

const SECTION = 'mb-8';
const H2 = 'text-lg font-semibold text-white mb-3';
const P = 'text-sm text-gray-400 leading-relaxed mb-3';
const UL = 'list-disc list-inside text-sm text-gray-400 space-y-1.5 mb-3 ml-1';

export default function PrivacyPage() {
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
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-10">Last updated: August 28, 2026</p>

        <div className={SECTION}>
          <h2 className={H2}>1. Overview</h2>
          <p className={P}>
            Kwizi (&quot;we&quot;, &quot;us&quot;) operates a Houston real estate analytics platform. This policy
            explains what information we collect, how we use it, and the choices you have. By creating an
            account or using the platform, you agree to this policy.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>2. Information We Collect</h2>
          <ul className={UL}>
            <li><strong className="text-gray-300">Account information:</strong> your email address and Google account profile (name, profile picture) when you sign in with Google. Authentication is handled by Firebase Authentication (Google Cloud).</li>
            <li><strong className="text-gray-300">AI chat messages:</strong> the messages you send to our AI assistant, Hommie (see Section 5).</li>
            <li><strong className="text-gray-300">Usage data:</strong> basic analytics such as pages visited and features used, to improve the product.</li>
            <li><strong className="text-gray-300">Content you upload:</strong> if you are an administrator, the data files and advertising media you upload to the platform.</li>
          </ul>
          <p className={P}>We do not sell your personal information.</p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>3. How We Use Information</h2>
          <ul className={UL}>
            <li>To provide access to the map, market data, and reports.</li>
            <li>To authenticate you and manage your account.</li>
            <li>To operate the AI assistant and respond to your questions.</li>
            <li>To show sponsored advertising relevant to the platform.</li>
            <li>To detect abuse and keep the platform secure.</li>
          </ul>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>4. Third-Party Services</h2>
          <ul className={UL}>
            <li><strong className="text-gray-300">Firebase / Google Cloud</strong> — authentication, database (Firestore), file storage, and hosting.</li>
            <li><strong className="text-gray-300">Google Gemini API</strong> — powers the Hommie AI assistant (see Section 5).</li>
            <li><strong className="text-gray-300">Map &amp; geodata providers</strong> — boundary and map imagery used to render the interactive map.</li>
          </ul>
          <p className={P}>
            These providers process data under their own privacy policies. We recommend reviewing Google&apos;s
            privacy policy at <span className="text-[#7ef29d]">policies.google.com/privacy</span>.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>5. AI Assistant (Hommie) Disclosure</h2>
          <p className={P}>
            Our platform includes an AI-powered assistant called <strong className="text-gray-300">Hommie</strong>.
            You should be aware of the following before using it:
          </p>
          <ul className={UL}>
            <li>Hommie is powered by the <strong className="text-gray-300">Google Gemini</strong> large language model, accessed through Google&apos;s Generative AI API.</li>
            <li><strong className="text-gray-300">Messages you type into the chat are transmitted to Google&apos;s API</strong> in order to generate a response. Do not share personal, financial, or confidential information in the chat.</li>
            <li>The assistant answers using aggregated market statistics from our own database; it is instructed not to use external sources, but AI systems can make mistakes.</li>
            <li><strong className="text-gray-300">AI responses are informational only</strong> and do not constitute real estate, legal, tax, or investment advice. Always verify figures independently before making decisions.</li>
            <li>You can clear your chat history at any time using the trash icon in the chat window.</li>
          </ul>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>6. Advertising</h2>
          <p className={P}>
            The platform may display sponsored banners or videos marked as &quot;Sponsored&quot;. Sponsored
            content links to third-party websites; we are not responsible for the content or practices of
            those sites. Clicking a sponsored link may take you to a site with its own privacy policy.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>7. Data Retention</h2>
          <p className={P}>
            Account data is retained while your account is active. You may request deletion of your account
            and associated data at any time using the contact below. Chat messages are stored in your
            browser session and can be cleared by you at any time.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>8. Your Rights</h2>
          <p className={P}>
            Depending on your jurisdiction (e.g. Texas, the CCPA/CPRA in California, or the GDPR in the EU),
            you may have rights to access, correct, or delete your personal data, and to object to certain
            processing. To exercise these rights, contact us using the details below.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>9. Children</h2>
          <p className={P}>
            The platform is intended for business and professional use and is not directed to children under
            13. We do not knowingly collect personal information from children.
          </p>
        </div>

        <div className={SECTION}>
          <h2 className={H2}>10. Changes &amp; Contact</h2>
          <p className={P}>
            We may update this policy as the product evolves; material changes will be reflected by updating
            the date at the top of this page.
          </p>
          <p className={P}>
            Questions or requests: <span className="text-[#7ef29d]">[legal contact email]</span>
          </p>
        </div>

        <div className="mt-12 pt-8 border-t border-white/[0.06] text-sm text-gray-500 space-y-2">
          <p>
            See also our{' '}
            <Link href="/terms" className="text-[#7ef29d] hover:underline">
              Terms of Service
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}