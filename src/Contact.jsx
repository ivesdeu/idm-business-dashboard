import { useEffect, useRef, useState } from "react";
import SiteFooter from "./components/SiteFooter.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
import TransitionLink from "./components/TransitionLink.jsx";
import { useReducedMotion } from "./hooks/useReducedMotion.js";
import { applyFlyIn, clearFlyIn, scrollRevealProgress } from "./utils/scrollReveal.js";

export default function Contact() {
  const reducedMotion = useReducedMotion();
  const formRef = useRef(null);

  useEffect(() => {
    const form = formRef.current;
    const clear = () => clearFlyIn(form);

    if (reducedMotion) {
      clear();
      return;
    }

    let ticking = false;
    const run = () => {
      ticking = false;
      if (!form) return;
      const vh = window.innerHeight;
      const r = form.getBoundingClientRect();
      const t = scrollRevealProgress(r, vh);
      applyFlyIn(form, t, { fromX: 0, fromY: 56, scale0: 0.94, scale1: 1 });
    };

    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(run);
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clear();
    };
  }, [reducedMotion]);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    const subject = encodeURIComponent(`Compass access: ${name || "Request"}`);
    const body = encodeURIComponent(
      [
        message.trim(),
        "",
        `Name: ${name}`,
        `Email: ${email}`,
        company.trim() ? `Company: ${company}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
    window.location.href = `mailto:contact@ivesdeu.com?subject=${subject}&body=${body}`;
  }

  return (
    <div className="min-h-screen bg-canvas font-sans text-ink">
      <SiteHeader />

      <main
        id="top"
        className="motion-reduce:animate-none animate-route-enter px-4 pb-20 pt-28 [animation-delay:0.05s] md:px-6 md:pb-24 md:pt-32"
      >
        <div className="mx-auto max-w-lg">
          <div>
            <div className="mb-8 flex items-center gap-3">
              <span className="h-px w-8 bg-accent" aria-hidden />
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                Get access
              </p>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl">
              Tell us about your firm.
            </h1>
            <p className="mt-4 text-base font-light leading-relaxed text-muted">
              Share a short note and we&apos;ll follow up with workspace access and onboarding next
              steps.
            </p>
          </div>

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            className="mt-10 space-y-5 rounded-[18px] border border-black/[0.06] bg-white p-6 shadow-card will-change-[transform,opacity] md:p-8"
          >
            <div>
              <label htmlFor="contact-name" className="block text-xs font-semibold text-ink">
                Name
              </label>
              <input
                id="contact-name"
                name="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="mt-1.5 w-full rounded-xl border border-black/[0.08] bg-canvas px-3 py-2.5 text-sm text-ink outline-none ring-accent/0 transition focus:border-accent/40 focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <div>
              <label htmlFor="contact-email" className="block text-xs font-semibold text-ink">
                Work email
              </label>
              <input
                id="contact-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="mt-1.5 w-full rounded-xl border border-black/[0.08] bg-canvas px-3 py-2.5 text-sm text-ink outline-none transition focus:border-accent/40 focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <div>
              <label htmlFor="contact-company" className="block text-xs font-semibold text-ink">
                Company <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                id="contact-company"
                name="company"
                type="text"
                autoComplete="organization"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-black/[0.08] bg-canvas px-3 py-2.5 text-sm text-ink outline-none transition focus:border-accent/40 focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <div>
              <label htmlFor="contact-message" className="block text-xs font-semibold text-ink">
                Message
              </label>
              <textarea
                id="contact-message"
                name="message"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                placeholder="Team size, how you bill clients, and what you want to see in Compass."
                className="mt-1.5 w-full resize-y rounded-xl border border-black/[0.08] bg-canvas px-3 py-2.5 text-sm text-ink outline-none transition focus:border-accent/40 focus:ring-2 focus:ring-accent/20"
              />
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center rounded-full bg-ink px-8 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-ink/90 sm:w-auto"
              >
                Send request
              </button>
              <TransitionLink
                to="/"
                className="text-center text-sm font-semibold text-muted underline decoration-muted/40 underline-offset-4 transition hover:text-ink"
              >
                Back to home
              </TransitionLink>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Submitting opens your mail app to send to{" "}
              <span className="font-medium text-ink">contact@ivesdeu.com</span>.
            </p>
          </form>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
