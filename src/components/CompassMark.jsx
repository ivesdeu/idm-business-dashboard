import { Compass } from "lucide-react";
import TransitionLink from "./TransitionLink.jsx";

export default function CompassMark({ compact = false }) {
  const iconWrap = compact
    ? "flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent"
    : "flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent";
  const word = compact ? "text-base font-extrabold tracking-tight text-ink" : "text-lg font-extrabold tracking-tight text-ink";

  return (
    <TransitionLink
      to="/"
      className={`flex shrink-0 items-center transition-[gap] duration-300 ease-out ${compact ? "gap-1.5" : "gap-2.5"}`}
    >
      <span className={`${iconWrap} transition-all duration-300 ease-out`}>
        <Compass
          className={`shrink-0 ${compact ? "h-4 w-4" : "h-5 w-5"}`}
          strokeWidth={1.75}
          aria-hidden
        />
      </span>
      <span className={`transition-all duration-300 ease-out ${word}`}>Compass</span>
    </TransitionLink>
  );
}
