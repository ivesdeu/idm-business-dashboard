export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function easeOutCubic(t) {
  const u = clamp(t, 0, 1);
  return 1 - (1 - u) ** 3;
}

/** 0 = below enter zone, 1 = settled in view; stays 1 once scrolled past. */
export function scrollRevealProgress(rect, vh) {
  if (rect.bottom < -100) return 1;
  /* Wider band = same motion over more scroll (feels slower). */
  const start = vh * 0.96;
  const end = vh * 0.22;
  const { top } = rect;
  if (top > start) return 0;
  if (top < end) return 1;
  return (start - top) / (start - end);
}

export function applyFlyIn(el, t, { fromX = 0, fromY = 52, scale0 = 0.94, scale1 = 1 } = {}) {
  if (!el) return;
  const k = easeOutCubic(t);
  const x = (1 - k) * fromX;
  const y = (1 - k) * fromY;
  const s = scale0 + (scale1 - scale0) * k;
  const o = 0.58 + 0.42 * k;
  el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
  el.style.opacity = String(o);
}

export function clearFlyIn(el) {
  if (!el) return;
  el.style.transform = "";
  el.style.opacity = "";
}
