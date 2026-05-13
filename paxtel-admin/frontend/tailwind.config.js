/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#10B981',
        'primary-dark': '#059669',
        'primary-light': '#D1FAE5',
        sidebar: '#0D1B2E',
        'sidebar-active': '#162236',
        content: '#F0F4F8',
      },
      fontFamily: {
        outfit: ['Outfit', 'sans-serif'],
      },
      borderRadius: {
        card: '10px',
        btn: '6px',
      },
    },
  },
  plugins: [],
};
