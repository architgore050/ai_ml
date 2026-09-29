/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        midnight: '#121416',
        terracotta: '#e8a87c',
        sage: '#aad0b1',
        'honey-gold': '#f1ce6d',
        'surface-lowest': '#0c0e10',
        'surface-low': '#1a1c1e',
        surface: '#1e2022',
        'surface-bright': '#282a2c',
        'surface-highest': '#333537',
        primary: '#ffeade',
        'primary-container': '#ffc69f',
        'inverse-primary': '#7f5536',
        secondary: '#aad0b1',
        'secondary-container': '#2c4e36',
        tertiary: '#ffecc1',
        'tertiary-container': '#f1ce6d',
        error: '#ffb4ab',
        'error-container': '#93000a',
      },
      fontFamily: {
        display: ['Lexend', 'sans-serif'],
        body: ['Lexend', 'sans-serif'],
      },
      borderRadius: {
        sm: '0.5rem',
        DEFAULT: '1rem',
        md: '1.5rem',
        lg: '2rem',
        xl: '3rem',
        full: '9999px',
      },
      spacing: {
        'tap': '64px',
        'stack': '24px',
        'gutter': '16px',
        'margin-mobile': '20px',
      },
      boxShadow: {
        'glow': '0 0 20px rgba(232, 168, 124, 0.25)',
        'glow-sage': '0 0 20px rgba(170, 208, 177, 0.25)',
        'glow-gold': '0 0 20px rgba(241, 206, 109, 0.25)',
      },
    },
  },
  plugins: [],
}
