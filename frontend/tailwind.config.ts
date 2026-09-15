/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0E14",
        graphite: "#121824",
        frost: "#E7F2FF",
        accent: "#5BE7C4",
        neon: "#9EEBFF",
        ember: "#FFB86B",
        cobalt: "#4DA3FF",
        aurora: "#7CFFB2",
        rose: "#FF8FA3",
        gold: "#F6D365",
        dusk: "#5B6BFF",
      },
      boxShadow: {
        glass: "0 20px 60px rgba(10,14,20,0.55)",
        soft: "0 10px 30px rgba(0,0,0,0.35)",
      },
      backgroundImage: {
        "radial-glow": "radial-gradient(circle at 20% 20%, rgba(94,234,212,0.12), transparent 55%), radial-gradient(circle at 80% 30%, rgba(158,235,255,0.16), transparent 45%), radial-gradient(circle at 50% 80%, rgba(255,184,107,0.08), transparent 50%)",
      },
    },
  },
  plugins: [],
};
