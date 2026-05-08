/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './site/themes/gallery/layouts/**/*.html',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'system-ui', '-apple-system', '"Segoe UI"',
          'Helvetica', 'Arial', 'sans-serif',
        ],
      },
      scale: {
        '102': '1.02',
        '103': '1.03',
      },
      transitionDuration: {
        '400': '400ms',
      },
      aspectRatio: {
        '4/3': '4 / 3',
        '3/2': '3 / 2',
      },
    },
  },
  plugins: [],
};
