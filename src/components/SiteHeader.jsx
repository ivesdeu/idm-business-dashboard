import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import CompassMark from "./CompassMark.jsx";
import TransitionLink from "./TransitionLink.jsx";

function NavItem({ id, children }) {
  const { pathname } = useLocation();
  const className = "transition hover:text-ink";
  if (pathname === "/") {
    return (
      <a href={`#${id}`} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link to={{ pathname: "/", hash: `#${id}` }} className={className}>
      {children}
    </Link>
  );
}

function NavItemMobile({ id, children }) {
  const { pathname } = useLocation();
  const className = "whitespace-nowrap transition hover:text-ink";
  if (pathname === "/") {
    return (
      <a href={`#${id}`} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link to={{ pathname: "/", hash: `#${id}` }} className={className}>
      {children}
    </Link>
  );
}

const SCROLL_CONDENSE = 72;

export default function SiteHeader() {
  const [condensed, setCondensed] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setCondensed(window.scrollY > SCROLL_CONDENSE);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-4 pt-4 md:px-6 md:pt-6">
      <div
        className={`pointer-events-auto relative mx-auto flex w-full items-center justify-between gap-2 rounded-full border border-black/[0.06] bg-white/90 px-3 py-2 shadow-nav backdrop-blur-md transition-[max-width] duration-300 ease-out sm:gap-3 sm:px-4 sm:py-2.5 md:px-6 ${
          condensed ? "max-w-4xl" : "max-w-6xl"
        }`}
      >
        <CompassMark />
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-6 text-sm font-semibold text-muted lg:gap-8 md:flex">
          <NavItem id="product">Product</NavItem>
          <NavItem id="features">Features</NavItem>
          <NavItem id="faq">FAQ</NavItem>
          <NavItem id="pricing">Pricing</NavItem>
        </nav>
        <nav className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs font-semibold text-muted md:hidden">
          <NavItemMobile id="product">Product</NavItemMobile>
          <NavItemMobile id="features">Features</NavItemMobile>
          <NavItemMobile id="faq">FAQ</NavItemMobile>
          <NavItemMobile id="pricing">Pricing</NavItemMobile>
        </nav>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          <TransitionLink
            to="/contact"
            className="rounded-full bg-ink px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-ink/90 sm:px-5 sm:py-2 sm:text-sm"
          >
            Get Access
          </TransitionLink>
        </div>
      </div>
    </header>
  );
}
