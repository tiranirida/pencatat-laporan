/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        persona: { DEFAULT: "#0284C7", dark: "#0369A1", bright: "#0EA5E9" },
        ink: "#0a0a0a",
        panel: "#141414",
        panel2: "#1c1c1c",
        line: "#2a2a2a",
      },
    },
  },
  plugins: [],
};
