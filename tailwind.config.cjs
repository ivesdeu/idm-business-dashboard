/** @type {import('tailwindcss').Config} */
module.exports = {
  // Advisor island only imports this CSS from the React entry — no `important` wrapper so Motion
  // and library-generated DOM reliably match utility selectors.
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
