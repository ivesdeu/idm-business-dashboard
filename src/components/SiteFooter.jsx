import { Link, useLocation } from "react-router-dom";
import CompassMark from "./CompassMark.jsx";
import TransitionLink from "./TransitionLink.jsx";

function FooterNavLink({ id, children }) {
  const { pathname } = useLocation();
  if (pathname === "/") {
    return (
      <a href={`#${id}`} className="hover:text-ink">
        {children}
      </a>
    );
  }
  return (
    <Link to={{ pathname: "/", hash: `#${id}` }} className="hover:text-ink">
      {children}
    </Link>
  );
}

export default function SiteFooter() {
  return (
    <footer className="border-t border-black/[0.06] bg-card/60 py-12">
      <div className="mx-auto max-w-6xl px-4 md:px-6">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xs">
            <CompassMark />
            <p className="mt-3 text-sm text-muted">Shared workspace for your firm.</p>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold text-muted">
            <FooterNavLink id="product">Product</FooterNavLink>
            <FooterNavLink id="pricing">Pricing</FooterNavLink>
            <a href="#" className="hover:text-ink">
              Privacy Policy
            </a>
            <a href="#" className="hover:text-ink">
              Terms
            </a>
            <TransitionLink to="/contact" className="hover:text-ink">
              Contact
            </TransitionLink>
          </nav>
          <p className="text-sm text-muted md:text-right">© 2026 Compass</p>
        </div>
        <p className="mt-10 max-w-3xl text-xs leading-relaxed text-muted">
          Advisor uses workspace and session context to generate text. No guarantee of financial
          or legal accuracy. Users remain responsible for all decisions.
        </p>
      </div>
    </footer>
  );
}
