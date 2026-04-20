/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0A0A",
        muted: "#6B7280",
        accent: "#E8472A",
        "accent-soft": "#FDF2F0",
        navy: "#1A2B45",
        canvas: "#F5F5F5",
        card: "#F3F4F6",
        slate: "#1A2B45",
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 4px 6px -1px rgb(0 0 0 / 0.06), 0 10px 24px -4px rgb(0 0 0 / 0.08)",
        nav: "0 8px 30px rgb(0 0 0 / 0.08)",
        mock: "0 25px 50px -12px rgb(0 0 0 / 0.15)",
      },
      keyframes: {
        "route-enter": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "route-enter": "route-enter 0.45s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
