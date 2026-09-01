import Link from "next/link";

type LegalDocumentProps = {
  eyebrow: string;
  title: string;
  summary: string;
  children: React.ReactNode;
};

export default function LegalDocument({ eyebrow, title, summary, children }: LegalDocumentProps) {
  return (
    <div className="titanium-legal-shell">
      <header className="titanium-legal-header">
        <div className="titanium-legal-header-inner">
          <Link className="titanium-legal-brand" href="/" aria-label="العودة إلى Titanium Management">
            <span className="titanium-legal-mark" aria-hidden="true">T</span>
            <span>
              <strong>Titanium Management</strong>
              <small>WhatsApp</small>
            </span>
          </Link>
          <span className="titanium-legal-badge">Public information · معلومات عامة</span>
        </div>
      </header>

      <main className="titanium-legal-main">
        <section className="titanium-legal-hero">
          <p>{eyebrow}</p>
          <h1>{title}</h1>
          <div className="titanium-legal-accent" aria-hidden="true" />
          <p className="titanium-legal-summary">{summary}</p>
          <p className="titanium-legal-date">آخر تحديث · Last updated: 1 September 2026</p>
        </section>

        <div className="titanium-legal-content">{children}</div>
      </main>

      <footer className="titanium-legal-footer">
        <nav aria-label="روابط قانونية · Legal links">
          <Link href="/">النظام · App</Link>
          <Link href="/privacy">الخصوصية · Privacy</Link>
          <Link href="/data-deletion">حذف البيانات · Data deletion</Link>
        </nav>
        <p>© 2026 Titanium Management</p>
      </footer>
    </div>
  );
}

