/**
 * Lazy Chart.js loader — legacy renderers guard on `window.Chart` and listen for `bizdash:chart-ready`.
 */
let chartPromise = null;

export function ensureChart() {
  if (chartPromise) return chartPromise;
  chartPromise = import('chart.js').then(({ Chart, registerables }) => {
    Chart.register(...registerables);
    if (Chart.defaults) {
      Chart.defaults.font.family =
        '"Helvetica Now Pro Display Medium", system-ui, -apple-system, sans-serif';
      if (Chart.defaults.animation) {
        Chart.defaults.animation.duration = 0;
      }
    }
    window.Chart = Chart;
    window.dispatchEvent(new CustomEvent('bizdash:chart-ready'));
    return Chart;
  });
  return chartPromise;
}
