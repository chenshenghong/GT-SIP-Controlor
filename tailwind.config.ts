/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{vue,js,ts,jsx,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#4edea3',
        'primary-container': '#10b981',
        secondary: '#4cd7f6',
        'secondary-container': '#03b5d3',
        error: '#ffb4ab',
        surface: '#0c1324',
        'surface-container': '#191f31',
        'surface-container-low': '#151b2d',
        'surface-container-lowest': '#070d1f',
        'surface-container-high': '#23293c',
        'surface-container-highest': '#2e3447',
        outline: '#86948a',
        'outline-variant': '#3c4a42',
        'on-surface': '#dce1fb',
        'on-surface-variant': '#bbcabf',
        'on-primary': '#003824',
      },
      fontFamily: {
        headline: ['Space Grotesk', 'sans-serif'],
        body: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        none: '0px', // Brutalist: no rounded corners
      },
      animation: {
        'radar-sweep': 'sweep 4s linear infinite',
        scanline: 'scan 8s linear infinite',
        shimmer: 'shimmer 2s infinite',
        'bounce-x': 'bounce-x 1s ease-in-out infinite',
      },
      keyframes: {
        sweep: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        scan: {
          '0%': { top: '0' },
          '100%': { top: '100%' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        'bounce-x': {
          '0%, 100%': { transform: 'translateX(0)' },
          '50%': { transform: 'translateX(10px)' },
        },
      },
    },
  },
  plugins: [],
}
