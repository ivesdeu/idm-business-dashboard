import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);
window.Chart = Chart;

if (Chart.defaults) {
  Chart.defaults.font.family =
    '"Helvetica Now Pro Display Medium", system-ui, -apple-system, sans-serif';
  /** No canvas draw-in; charts appear with the same page stagger as `.motion-item` cards. */
  if (Chart.defaults.animation) {
    Chart.defaults.animation.duration = 0;
  }
}
