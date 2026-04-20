import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./hooks/useReducedMotion.js";
import {
  ChartColumn,
  Circle,
  Clock,
  LayoutGrid,
  MessagesSquare,
  Settings,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import SiteFooter from "./components/SiteFooter.jsx";
import SiteHeader from "./components/SiteHeader.jsx";
import TransitionLink from "./components/TransitionLink.jsx";
import {
  applyFlyIn,
  clearFlyIn,
  clamp,
  scrollRevealProgress,
} from "./utils/scrollReveal.js";

function useScrollRevealMocks({
  heroMockRef,
  productMockRef,
  layoutMockRef,
  customersMockRef,
  advisorMockRef,
  stepRefs,
  featureCardRefs,
  reducedMotion,
}) {
  useEffect(() => {
    const clearAll = () => {
      [
        heroMockRef,
        productMockRef,
        layoutMockRef,
        customersMockRef,
        advisorMockRef,
      ].forEach((r) => clearFlyIn(r.current));
      stepRefs.current.forEach((el) => clearFlyIn(el));
      featureCardRefs.current.forEach((el) => clearFlyIn(el));
    };

    if (reducedMotion) {
      clearAll();
      return;
    }

    let ticking = false;

    const run = () => {
      ticking = false;
      const vh = window.innerHeight;

      if (heroMockRef.current) {
        const r = heroMockRef.current.getBoundingClientRect();
        const t = scrollRevealProgress(r, vh);
        applyFlyIn(heroMockRef.current, t, {
          fromX: 0,
          fromY: 64,
          scale0: 0.93,
          scale1: 1,
        });
      }

      if (productMockRef.current) {
        const r = productMockRef.current.getBoundingClientRect();
        const t = scrollRevealProgress(r, vh);
        applyFlyIn(productMockRef.current, t, {
          fromX: 56,
          fromY: 36,
          scale0: 0.94,
          scale1: 1,
        });
      }

      if (layoutMockRef.current) {
        const r = layoutMockRef.current.getBoundingClientRect();
        const t = scrollRevealProgress(r, vh);
        applyFlyIn(layoutMockRef.current, t, {
          fromX: 0,
          fromY: 72,
          scale0: 0.93,
          scale1: 1,
        });
      }

      if (customersMockRef.current) {
        const r = customersMockRef.current.getBoundingClientRect();
        const t = scrollRevealProgress(r, vh);
        applyFlyIn(customersMockRef.current, t, {
          fromX: 52,
          fromY: 40,
          scale0: 0.94,
          scale1: 1,
        });
      }

      if (advisorMockRef.current) {
        const r = advisorMockRef.current.getBoundingClientRect();
        const t = scrollRevealProgress(r, vh);
        applyFlyIn(advisorMockRef.current, t, {
          fromX: -52,
          fromY: 40,
          scale0: 0.94,
          scale1: 1,
        });
      }

      stepRefs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        let t = scrollRevealProgress(r, vh);
        t = clamp(t - i * 0.11, 0, 1);
        applyFlyIn(el, t, {
          fromX: i % 2 === 0 ? -40 : 40,
          fromY: 48,
          scale0: 0.93,
          scale1: 1,
        });
      });

      featureCardRefs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        let t = scrollRevealProgress(r, vh);
        t = clamp(t - (i % 3) * 0.065 - Math.floor(i / 3) * 0.08, 0, 1);
        const col = i % 3;
        applyFlyIn(el, t, {
          fromX: col === 1 ? 0 : col === 0 ? -36 : 36,
          fromY: 44,
          scale0: 0.94,
          scale1: 1,
        });
      });
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
      clearAll();
    };
  }, [
    reducedMotion,
    heroMockRef,
    productMockRef,
    layoutMockRef,
    customersMockRef,
    advisorMockRef,
    stepRefs,
    featureCardRefs,
  ]);
}

function HeroDashboardMock() {
  const nav = [
    "Dashboard",
    "Customers",
    "Income",
    "Expenses",
    "Timesheet",
    "Analytics",
    "Advisor",
    "Team",
    "Settings",
  ];
  return (
    <div className="overflow-hidden rounded-[18px] border border-black/[0.06] bg-white shadow-mock">
      <div className="flex h-9 items-center gap-2 border-b border-black/[0.06] bg-[#F3F4F6] px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#FCA5A5]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#FCD34D]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#86EFAC]" />
        <span className="ml-2 flex-1 truncate rounded-md bg-white px-2 py-0.5 text-[10px] text-muted shadow-sm">
          app.compass.work / northline-advisors
        </span>
      </div>
      <div className="flex min-h-[320px] md:min-h-[380px]">
        <aside className="hidden w-44 shrink-0 border-r border-black/[0.06] bg-[#FAFAFA] py-4 text-[11px] font-medium text-muted sm:block">
          <div className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-wider text-muted/80">
            Workspace
          </div>
          <nav className="space-y-0.5 px-2">
            {nav.map((item) => (
              <div
                key={item}
                className={`rounded-lg px-2 py-1.5 ${
                  item === "Dashboard"
                    ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.04]"
                    : "hover:bg-white/80"
                }`}
              >
                {item}
              </div>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink md:text-base">Business Performance</h3>
            <span className="rounded-full bg-card px-3 py-1 text-[10px] font-semibold text-muted ring-1 ring-black/[0.06]">
              Q1 2026 · Accrual
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              { label: "Total Revenue", value: "$142,300", delta: "+12%" },
              { label: "Outstanding AR", value: "$18,400", delta: "4 invoices" },
              { label: "Active Customers", value: "24", delta: "retainers" },
              { label: "Net Margin", value: "31%", delta: "vs budget" },
            ].map((k) => (
              <div
                key={k.label}
                className="rounded-xl border border-black/[0.06] bg-card p-3 shadow-sm"
              >
                <p className="text-[10px] font-medium text-muted">{k.label}</p>
                <p className="mt-1 text-lg font-extrabold tracking-tight text-ink md:text-xl">
                  {k.value}
                </p>
                <p className="mt-0.5 text-[10px] text-accent">{k.delta}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-black/[0.06] bg-white p-3 shadow-sm lg:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-bold text-ink">Revenue trend</span>
                <span className="text-[10px] text-muted">Last 6 mo</span>
              </div>
              <div className="flex h-24 items-end gap-1">
                {[40, 55, 48, 62, 58, 72].map((h, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-t bg-gradient-to-t from-accent/25 to-accent/45"
                    style={{ height: `${h}%` }}
                  />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  This week
                </span>
                {["Lead sync", "QBR prep", "Invoice review"].map((ev) => (
                  <span
                    key={ev}
                    className="rounded-lg bg-accent/20 px-2.5 py-1 text-[10px] font-medium text-ink ring-1 ring-accent/15"
                  >
                    {ev}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-black/[0.06] bg-white p-3 shadow-sm">
              <p className="text-xs font-bold text-ink">Your team</p>
              <p className="mt-1 text-[10px] text-muted">3 active · 1 viewing</p>
              <div className="mt-3 flex -space-x-2">
                {["SJ", "MR", "KL"].map((i) => (
                  <span
                    key={i}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#E5E7EB] text-[10px] font-bold text-ink"
                  >
                    {i}
                  </span>
                ))}
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-muted/40 bg-card text-[10px] text-muted">
                  +1
                </span>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function TeamMockCard() {
  return (
    <div className="rounded-[18px] border border-black/[0.06] bg-white p-5 shadow-card">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink">Team</h3>
        <button
          type="button"
          className="rounded-full bg-navy px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white"
        >
          + Invite member
        </button>
      </div>
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5 ring-1 ring-amber-100">
          <div>
            <p className="font-semibold text-ink">alex@clientfirm.com</p>
            <p className="text-[10px] text-amber-800/80">Pending invite · Viewer</p>
          </div>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-amber-900 ring-1 ring-amber-200">
            Resend
          </span>
        </div>
        <div className="flex items-center justify-between rounded-xl bg-card px-3 py-2.5 ring-1 ring-black/[0.04]">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">
              MR
            </span>
            <div>
              <p className="font-semibold text-ink">Morgan Rivera</p>
              <p className="text-[10px] text-muted">morgan@northline.com</p>
            </div>
          </div>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
            Admin
          </span>
        </div>
      </div>
    </div>
  );
}

function ColumnPickerMock() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <p className="mb-2 text-center text-[10px] font-bold uppercase tracking-wider text-muted">
          Default
        </p>
        <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-white shadow-sm">
          <div className="border-b border-black/[0.06] bg-card px-3 py-2 text-[10px] font-bold text-ink">
            Customers
          </div>
          <div className="divide-y divide-black/[0.04] text-[10px]">
            {["Acme Co", "Brightline", "Cedar"].map((c) => (
              <div key={c} className="flex justify-between px-3 py-2 text-muted">
                <span className="font-medium text-ink">{c}</span>
                <span>$42k</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div>
        <p className="mb-2 text-center text-[10px] font-bold uppercase tracking-wider text-muted">
          Your setup
        </p>
        <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-white shadow-sm">
          <div className="flex border-b border-black/[0.06] bg-card">
            <div className="flex-1 px-3 py-2 text-[10px] font-bold text-ink">Customers</div>
            <div className="w-[44%] border-l border-black/[0.06] bg-white px-3 py-2 text-[10px] font-bold text-accent">
              Columns
            </div>
          </div>
          <div className="flex min-h-[120px]">
            <div className="flex-1 divide-y divide-black/[0.04] text-[10px] opacity-40">
              <div className="px-3 py-2">Acme Co</div>
              <div className="px-3 py-2">Brightline</div>
            </div>
            <div className="w-[44%] space-y-2 border-l border-black/[0.06] bg-[#FAFAFA] p-3">
              {["Revenue", "Margin %", "Last touch"].map((x) => (
                <label key={x} className="flex items-center gap-2 text-[10px] text-ink">
                  <span className="h-3 w-3 rounded border border-accent bg-accent shadow-sm" />
                  {x}
                </label>
              ))}
              {["Cost", "Tags"].map((x) => (
                <label key={x} className="flex items-center gap-2 text-[10px] text-muted">
                  <span className="h-3 w-3 rounded border border-muted/40 bg-white" />
                  {x}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrendBars({ heights }) {
  return (
    <div className="flex h-6 items-end gap-px">
      {heights.map((h, i) => (
        <div key={i} className="w-1 rounded-sm bg-accent/70" style={{ height: `${h}px` }} />
      ))}
    </div>
  );
}

function CustomersRowMock() {
  const rows = [
    {
      client: "Northline Advisory",
      revenue: "$84,200",
      cost: "$31,400",
      margin: "37%",
      bars: [12, 18, 14, 22, 19, 28, 24, 30],
    },
    {
      client: "Brightline Media",
      revenue: "$52,900",
      cost: "$24,100",
      margin: "29%",
      bars: [10, 14, 16, 15, 20, 22, 21, 26],
    },
    {
      client: "Cedar & Co.",
      revenue: "$38,400",
      cost: "$19,800",
      margin: "24%",
      bars: [8, 10, 12, 11, 14, 13, 17, 19],
    },
    {
      client: "Harbor Systems",
      revenue: "$61,750",
      cost: "$27,320",
      margin: "31%",
      bars: [14, 16, 18, 20, 19, 24, 26, 28],
    },
    {
      client: "Signal Foundry",
      revenue: "$44,200",
      cost: "$21,650",
      margin: "28%",
      bars: [9, 11, 13, 12, 16, 18, 17, 22],
    },
  ];

  return (
    <div className="flex h-full min-h-[22rem] flex-col overflow-hidden rounded-[18px] border border-black/[0.06] bg-white shadow-card md:min-h-0">
      <div className="shrink-0 border-b border-black/[0.06] bg-card px-4 py-2.5 text-xs font-bold text-ink">
        Customers
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-[11px]">
          <thead>
            <tr className="text-muted">
              <th className="px-4 py-2.5 font-medium">Client</th>
              <th className="px-4 py-2.5 font-medium">Revenue</th>
              <th className="px-4 py-2.5 font-medium">Cost</th>
              <th className="px-4 py-2.5 font-medium">Margin</th>
              <th className="px-4 py-2.5 font-medium">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={row.client}
                className={`border-t border-black/[0.06] ${idx % 2 === 1 ? "bg-[#FAFAFA]" : "bg-white"}`}
              >
                <td className="px-4 py-3.5 font-semibold text-ink">{row.client}</td>
                <td className="px-4 py-3.5 font-medium">{row.revenue}</td>
                <td className="px-4 py-3.5 text-muted">{row.cost}</td>
                <td className="px-4 py-3.5 font-semibold text-accent">{row.margin}</td>
                <td className="px-4 py-3.5">
                  <TrendBars heights={row.bars} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-black/[0.06] bg-card px-4 py-3 text-[10px] text-muted">
        <span className="font-medium text-ink">5 active</span> · AR aging &amp; tags roll up to
        this view
      </div>
    </div>
  );
}

function AdvisorChatMock() {
  return (
    <div className="space-y-4">
      <div className="rounded-[18px] border border-black/[0.06] bg-white p-4 shadow-card">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-lg bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">
            Advisor
          </span>
          <span className="text-[10px] text-muted">Workspace context on</span>
        </div>
        <div className="space-y-3 text-xs">
          <div className="ml-auto max-w-[92%] rounded-2xl rounded-br-md bg-card px-3 py-2 font-medium text-ink ring-1 ring-black/[0.06]">
            Why did margins drop in March?
          </div>
          <div className="max-w-[95%] rounded-2xl rounded-bl-md bg-accent-soft px-3 py-2 text-muted leading-relaxed ring-1 ring-accent/10">
            <span className="font-semibold text-ink">Advisor:</span> March blended margin fell
            mainly because two large expenses were tagged to core clients before revenue
            recognition landed in April. Net impact is timing, not a structural change.
          </div>
        </div>
      </div>
      <button
        type="button"
        className="w-full rounded-[18px] border border-black/[0.06] bg-card px-4 py-4 text-left shadow-sm transition hover:bg-white"
      >
        <p className="text-xs font-bold text-ink">Recap</p>
        <p className="mt-1 text-[11px] text-muted">
          Generate a one-click summary of cash, AR, and client touchpoints for leadership.
        </p>
        <span className="mt-3 inline-flex rounded-full bg-accent px-3 py-1 text-[10px] font-semibold text-white">
          Generate recap
        </span>
      </button>
    </div>
  );
}

const faqItems = [
  {
    id: "q1",
    q: "How do organization invites work and what can each role do?",
    a: "Owners can invite by email or share a scoped invite link. Members sign into the same organization with roles that control billing, settings, exports, and Advisor usage. Viewers can follow along without changing core accounting data.",
  },
  {
    id: "q2",
    q: "Where does my data live?",
    a: "Your workspace data is stored in Compass infrastructure designed for teams. You control access through roles and invites; exports are available whenever you need a local copy.",
  },
  {
    id: "q3",
    q: "What does 'allocated cost' on a customer mean?",
    a: "Allocated cost sums expenses you have tagged to that client or project. It is a simple way to approximate client-level economics next to recognized revenue, not a formal cost accounting allocation.",
  },
  {
    id: "q4",
    q: "How does Advisor get context, and what happens if it's unavailable?",
    a: "Advisor reads structured workspace context you already see in tables and KPIs, plus session-safe prompts you provide. If the model or network is unavailable, you can still use dashboards, exports, and manual workflows.",
  },
  {
    id: "q5",
    q: "Can I export my data?",
    a: "Yes. Income, customers, and related tables support CSV export for offline analysis or handoff to your finance stack.",
  },
  {
    id: "q6",
    q: "Is this accounting software?",
    a: "Compass is operational visibility and reporting for your firm, not a CPA substitute. It helps your firm see performance and clients together; your team remains responsible for filings, audits, and final books.",
  },
];

const featureCards = [
  {
    title: "Dashboard",
    body: "KPIs, AR, income statement, and budget vs actual at a glance",
    glyph: "dashboard",
    tone: "blue",
  },
  {
    title: "Customers",
    body: "Revenue, cost allocation, margin, and relationship timeline per client",
    glyph: "customers",
    tone: "rose",
  },
  {
    title: "Income",
    body: "Log income, track AR aging, filter by status, export to CSV",
    glyph: "income",
    tone: "blue",
  },
  {
    title: "Expenses",
    body: "Slice by category, vendor, or client; compare budget vs actual",
    glyph: "expenses",
    tone: "rose",
  },
  {
    title: "Timesheet",
    body: "Track time per client or project alongside revenue",
    glyph: "timesheet",
    tone: "blue",
  },
  {
    title: "Analytics",
    body: "Performance, retention, and insights across your client base",
    glyph: "analytics",
    tone: "rose",
  },
  {
    title: "Advisor",
    body: "AI chat tied to your workspace data for briefs, recaps, and variance answers",
    glyph: "advisor",
    tone: "blue",
  },
  {
    title: "Team",
    body: "Invite by email or link, assign roles, manage org members",
    glyph: "team",
    tone: "rose",
  },
  {
    title: "Settings",
    body: "Budgets, reporting periods, workspace preferences",
    glyph: "settings",
    tone: "blue",
  },
];

/** Lucide icons (same family as [Notion Icons](https://notionicons.so/) “Lucide” set). */
const LUCIDE_FEATURE_ICONS = {
  dashboard: LayoutGrid,
  customers: Users,
  income: TrendingUp,
  expenses: Wallet,
  timesheet: Clock,
  analytics: ChartColumn,
  advisor: MessagesSquare,
  team: UserPlus,
  settings: Settings,
};

function FeatureIcon({ tone, glyph }) {
  const isCoral = tone === "blue";
  const Icon = LUCIDE_FEATURE_ICONS[glyph] ?? Circle;
  return (
    <span
      className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${
        isCoral ? "bg-accent/15 text-accent" : "bg-navy/10 text-navy"
      }`}
    >
      <Icon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
    </span>
  );
}

export default function Home() {
  const [openFaq, setOpenFaq] = useState(null);
  const reducedMotion = useReducedMotion();

  const heroMockRef = useRef(null);
  const productMockRef = useRef(null);
  const layoutMockRef = useRef(null);
  const customersMockRef = useRef(null);
  const advisorMockRef = useRef(null);
  const stepRefs = useRef([]);
  const featureCardRefs = useRef([]);

  useScrollRevealMocks({
    heroMockRef,
    productMockRef,
    layoutMockRef,
    customersMockRef,
    advisorMockRef,
    stepRefs,
    featureCardRefs,
    reducedMotion,
  });

  return (
    <div className="min-h-screen bg-canvas font-sans text-ink">
      <SiteHeader />

      <main
        id="top"
        className="motion-reduce:animate-none animate-route-enter [animation-delay:0.05s]"
      >
        {/* Hero */}
        <section
          id="hero"
          className="border-b border-black/[0.06] bg-canvas pb-16 pt-28 md:pb-24 md:pt-32"
        >
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="mx-auto max-w-3xl text-center">
              <h1 className="text-balance text-4xl font-extrabold leading-[1.08] tracking-tight text-ink md:text-5xl lg:text-[3.25rem]">
                One place for performance, clients, and how your team works.
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg font-light leading-relaxed text-muted md:text-[18px]">
                See performance, clients, and cash in one place. Dashboards you shape, plus Advisor for
                recaps and answers from your numbers.
              </p>
              <div className="mt-8 flex justify-center">
                <TransitionLink
                  to="/contact"
                  className="inline-flex w-full items-center justify-center rounded-full bg-ink px-8 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-ink/90 sm:w-auto"
                >
                  Get Access
                </TransitionLink>
              </div>
            </div>
            <div
              ref={heroMockRef}
              className="mx-auto mt-12 max-w-5xl will-change-[transform,opacity] md:mt-16"
            >
              <HeroDashboardMock />
            </div>
          </div>
        </section>

        {/* Section A */}
        <section id="product" className="scroll-mt-28 border-b border-black/[0.06] bg-canvas py-16 md:py-24">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 md:grid-cols-2 md:gap-16 md:px-6">
            <div>
              <div className="mb-4 flex items-center gap-3">
                <span className="h-px w-8 bg-accent" aria-hidden />
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                  Collaboration
                </p>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                Invite your team to one workspace
              </h2>
              <ul className="mt-8 space-y-4 text-base font-light leading-relaxed text-ink md:text-[17px]">
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Invite by email, assign a role, or generate a shareable invite link
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Everyone signs into the same organization with one shared ledger and one
                    dashboard
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    A bookmarkable workspace URL for your firm&apos;s Compass, not a generic account
                  </span>
                </li>
              </ul>
            </div>
            <div ref={productMockRef} className="will-change-[transform,opacity]">
              <TeamMockCard />
            </div>
          </div>
        </section>

        {/* Section B */}
        <section className="border-b border-black/[0.06] bg-card/40 py-16 md:py-24">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <div className="mb-4 flex items-center justify-center gap-3">
                <span className="h-px w-8 bg-accent" aria-hidden />
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                  Your layout
                </p>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                Tune the dashboard to how you review the business.
              </h2>
            </div>
            <div className="mx-auto mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  t: "Reporting Period",
                  d: "Scope the dashboard to any date range, all-time or filtered.",
                  icon: "⏱",
                },
                {
                  t: "Column Control",
                  d: "Pick which columns show in Customers and Income tables.",
                  icon: "☷",
                },
                {
                  t: "Filter + Export",
                  d: "Filter income by status, apply bulk actions, export to CSV.",
                  icon: "⇅",
                },
                {
                  t: "Budget vs Actual",
                  d: "Set budgets in Settings; see variance in the Expenses view.",
                  icon: "⊞",
                },
              ].map((f) => (
                <div
                  key={f.t}
                  className="rounded-[18px] border border-black/[0.06] bg-white p-5 shadow-card"
                >
                  <span className="text-xl text-accent">{f.icon}</span>
                  <h3 className="mt-3 text-sm font-semibold text-ink">{f.t}</h3>
                  <p className="mt-2 text-sm font-light leading-relaxed text-muted">{f.d}</p>
                </div>
              ))}
            </div>
            <div
              ref={layoutMockRef}
              className="mx-auto mt-14 max-w-4xl rounded-[18px] border border-black/[0.06] bg-white p-5 shadow-card will-change-[transform,opacity] md:p-8"
            >
              <ColumnPickerMock />
            </div>
          </div>
        </section>

        {/* Section C */}
        <section className="border-b border-black/[0.06] bg-white/40 py-16 md:py-24">
          <div className="mx-auto grid max-w-6xl items-start gap-12 px-4 md:grid-cols-2 md:items-stretch md:gap-16 md:px-6">
            <div>
              <div className="mb-4 flex items-center gap-3">
                <span className="h-px w-8 bg-accent" aria-hidden />
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                  Customers
                </p>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                See client economics next to cash and AR.
              </h2>
              <ul className="mt-8 space-y-4 text-base font-light leading-relaxed text-ink md:text-[17px]">
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Customers table shows revenue, allocated cost from tagged expenses, and
                    profit margin
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Income table with AR aging so you can see what&apos;s outstanding across all
                    clients
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Relationship timeline for reminders and recent touchpoints. Lightweight by
                    design, not a Salesforce replacement
                  </span>
                </li>
              </ul>
            </div>
            <div
              ref={customersMockRef}
              className="flex min-h-[22rem] will-change-[transform,opacity] md:min-h-0 md:h-full"
            >
              <CustomersRowMock />
            </div>
          </div>
        </section>

        {/* Section D */}
        <section className="border-b border-black/[0.06] bg-white/50 py-16 md:py-24">
          <div className="mx-auto grid max-w-6xl items-start gap-12 px-4 md:grid-cols-2 md:gap-16 md:px-6">
            <div>
              <div className="mb-4 flex items-center gap-3">
                <span className="h-px w-8 bg-accent" aria-hidden />
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                  AI-assisted
                </p>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                Advisor for questions. Weekly recaps for rhythm.
              </h2>
              <ul className="mt-8 space-y-4 text-base font-light leading-relaxed text-ink md:text-[17px]">
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Advisor chat: ask about variances, get a brief, or draft a follow-up, all
                    grounded in your workspace data
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>
                    Recaps on your dashboard, each generated in one click
                  </span>
                </li>
              </ul>
              <p className="mt-6 text-sm italic leading-relaxed text-muted">
                Suggestions and drafts are assistive. Your team reviews client updates and
                accounting decisions.
              </p>
            </div>
            <div ref={advisorMockRef} className="will-change-[transform,opacity]">
              <AdvisorChatMock />
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-b border-black/[0.06] bg-canvas py-16 md:py-24">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <div className="mb-4 flex items-center justify-center gap-3">
                <span className="h-px w-8 bg-accent" aria-hidden />
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                  Process
                </p>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                Up and running in three steps.
              </h2>
            </div>
            <div className="mx-auto mt-14 flex max-w-5xl flex-col gap-5 md:flex-row md:items-stretch md:justify-center md:gap-4 lg:gap-5">
              {[
                {
                  n: "01",
                  label: "Create",
                  t: "Create your workspace by naming the organization, picking your URL slug, and signing in.",
                },
                {
                  n: "02",
                  label: "Add data",
                  t: "Add your data by entering transactions, income lines, and expenses, or import via CSV.",
                },
                {
                  n: "03",
                  label: "Review",
                  t: "Invite the team and review together on a shared dashboard, with Advisor on standby for your next leadership check-in.",
                },
              ].map((s, idx) => (
                <div
                  key={s.n}
                  ref={(el) => {
                    stepRefs.current[idx] = el;
                  }}
                  className="relative flex min-h-0 flex-1 flex-col rounded-[18px] border border-black/[0.06] bg-white p-6 shadow-card will-change-[transform,opacity] md:p-7"
                >
                  <div className="flex shrink-0 items-start justify-between gap-3">
                    <span className="text-3xl font-extrabold tabular-nums tracking-tight text-ink md:text-4xl">
                      {s.n}
                    </span>
                    <span className="rounded-full bg-navy px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-white">
                      {s.label}
                    </span>
                  </div>
                  <p className="mt-5 flex-1 text-sm font-light leading-relaxed text-muted md:text-[15px]">
                    {s.t}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Feature grid */}
        <section
          id="features"
          className="scroll-mt-28 border-t border-black/[0.06] bg-card/30 py-16 md:py-24"
        >
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <div className="mb-4 flex items-center justify-center gap-3">
                <span className="h-px w-8 bg-accent" aria-hidden />
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                  Product
                </p>
              </div>
              <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                What&apos;s inside Compass?
              </h2>
              <p className="mt-4 text-base font-light text-muted md:text-lg">
                Everything your firm needs in one shared workspace.
              </p>
            </div>
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {featureCards.map((c, i) => (
                <div
                  key={c.title}
                  ref={(el) => {
                    featureCardRefs.current[i] = el;
                  }}
                  className="rounded-[18px] border border-black/[0.06] bg-white p-6 shadow-card will-change-[transform,opacity] transition-colors hover:border-black/[0.1]"
                >
                  <FeatureIcon tone={c.tone} glyph={c.glyph} />
                  <h3 className="mt-4 text-lg font-semibold text-ink">{c.title}</h3>
                  <p className="mt-2 text-sm font-light leading-relaxed text-muted">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-28 border-b border-black/[0.06] bg-white py-16 md:py-24">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
              <div>
                <div className="mb-4 flex items-center gap-3">
                  <span className="h-px w-8 bg-accent" aria-hidden />
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                    Pricing
                  </p>
                </div>
                <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
                  Free for approved beta workspaces.
                </h2>
                <p className="mt-6 text-base font-light leading-relaxed text-muted md:text-[17px]">
                  During our beta testing period, Compass is free for anyone whose organization is
                  approved after you contact our team for access. We review each request so we can
                  onboard firms thoughtfully, stay close to product feedback, and keep the beta
                  cohort manageable while we ship improvements quickly.
                </p>
                <ul className="mt-8 space-y-4 text-base font-light leading-relaxed text-ink md:text-[17px]">
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      Start with the contact flow—tell us about your firm and how you&apos;d like to
                      use Compass. We&apos;ll follow up with timing, eligibility, and onboarding steps.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      Approved organizations receive the full workspace at no charge for the duration
                      of the beta program, including team invites, dashboards, exports, and Advisor.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      Anyone who participates as an approved beta tester receives one year of
                      Enterprise access free after official launch—a $1,500 value—as thanks for
                      helping us refine the product before general availability.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>
                      No credit card required. When we introduce paid plans, we&apos;ll give you clear
                      notice and time to decide before anything changes on your bill.
                    </span>
                  </li>
                </ul>
              </div>
              <div className="rounded-[18px] border border-black/[0.06] bg-card/40 p-8 shadow-card md:p-10">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      Beta
                    </p>
                    <p className="mt-2 text-4xl font-extrabold tracking-tight text-ink md:text-5xl">
                      $0
                    </p>
                    <p className="mt-1 text-sm font-light text-muted">
                      per organization during the beta period
                    </p>
                  </div>
                  <span className="rounded-full bg-accent px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                    Active
                  </span>
                </div>
                <p className="mt-6 rounded-xl border border-accent/20 bg-accent/10 px-4 py-3 text-sm leading-relaxed text-ink">
                  <span className="font-semibold">After launch:</span> Beta testers get one year of
                  Enterprise access free ($1,500 value).
                </p>
                <ul className="mt-8 space-y-3 border-t border-black/[0.06] pt-8 text-sm font-light leading-relaxed text-muted">
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>Full product access for your approved org</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>Roles, invites, and shared workspace URL</span>
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span>Advisor, exports, and the features you see on this page</span>
                  </li>
                </ul>
                <TransitionLink
                  to="/contact"
                  className="mt-8 flex w-full items-center justify-center rounded-full bg-ink px-8 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-ink/90"
                >
                  Request access
                </TransitionLink>
                <p className="mt-4 text-center text-xs text-muted">
                  We&apos;ll confirm approval and help you get started.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-28 border-b border-black/[0.06] bg-canvas py-16 md:py-24">
          <div className="mx-auto max-w-3xl px-4 md:px-6">
            <div className="mb-4 flex items-center justify-center gap-3">
              <span className="h-px w-8 bg-accent" aria-hidden />
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                FAQ
              </p>
            </div>
            <h2 className="text-center text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
              Common questions.
            </h2>
            <div className="mt-10 divide-y divide-black/[0.08] rounded-[18px] border border-black/[0.06] bg-white px-1 shadow-card">
              {faqItems.map((item) => {
                const open = openFaq === item.id;
                return (
                  <div key={item.id} className="px-4 py-1">
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : item.id)}
                      className="flex w-full items-center justify-between gap-4 py-4 text-left"
                      aria-expanded={open}
                    >
                      <span className="text-sm font-bold text-ink md:text-base">{item.q}</span>
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-muted ring-1 ring-black/[0.06] transition ${
                          open ? "rotate-180 text-accent" : ""
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M6 9l6 6 6-6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </span>
                    </button>
                    {open && (
                      <div className="pb-4 text-sm leading-relaxed text-muted">{item.a}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section id="cta" className="scroll-mt-28 bg-canvas py-16 md:py-24">
          <div className="mx-auto max-w-3xl px-4 text-center md:px-6">
            <div className="mb-4 flex items-center justify-center gap-3">
              <span className="h-px w-8 bg-accent" aria-hidden />
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
                Get started
              </p>
            </div>
            <h2 className="text-3xl font-extrabold tracking-tight text-ink md:text-4xl md:leading-tight">
              Start your workspace. Invite your team this week.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base font-light leading-relaxed text-muted md:text-lg">
              Same URL, same org, and one picture of the business everyone shares.
            </p>
            <TransitionLink
              to="/contact"
              className="mt-8 inline-flex rounded-full bg-ink px-10 py-4 text-sm font-semibold text-white shadow-sm transition hover:bg-ink/90"
            >
              Get Access
            </TransitionLink>
            <p className="mt-4 text-xs text-muted">No credit card required.</p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
