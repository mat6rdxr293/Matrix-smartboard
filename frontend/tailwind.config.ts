/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        white: "rgb(var(--color-overlay) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        graphite: "rgb(var(--color-graphite) / <alpha-value>)",
        frost: "rgb(var(--color-frost) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        accentText: "rgb(var(--color-accent-text) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
        success: "rgb(var(--color-success) / <alpha-value>)",
        neon: "#9EEBFF",
        ember: "#FFB86B",
        cobalt: "#4DA3FF",
        aurora: "#7CFFB2",
        rose: "#FF8FA3",
        gold: "#F6D365",
        dusk: "#5B6BFF",
      },
      boxShadow: {
        glass: "var(--shadow-glass)",
        soft: "var(--shadow-soft)",
      },
      backgroundImage: {
        "radial-glow": "radial-gradient(circle at 20% 20%, rgba(94,234,212,0.12), transparent 55%), radial-gradient(circle at 80% 30%, rgba(158,235,255,0.16), transparent 45%), radial-gradient(circle at 50% 80%, rgba(255,184,107,0.08), transparent 50%)",
      },
    },
  },
  plugins: [],
};
