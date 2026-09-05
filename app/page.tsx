import Dashboard from "./dashboard";

// The login shell must follow the current server configuration on every visit.
// Keep hashed JS/CSS caching intact; only this page's HTML is request-rendered.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Home() {
  return <Dashboard />;
}
