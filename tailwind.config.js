/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Custom color palette matching the existing dark theme
        primary: {
          DEFAULT: '#0078d4',
          hover: '#106ebe',
          light: '#40a8ff',
        },
        secondary: {
          DEFAULT: '#404040',
          hover: '#555555',
        },
        success: {
          DEFAULT: '#107c10',
          hover: '#0e6e0e',
        },
        danger: {
          DEFAULT: '#d13438',
          hover: '#b92b2f',
        },
        warning: {
          DEFAULT: '#ff8c00',
          hover: '#e67e00',
        },
        background: {
          DEFAULT: '#212121',
          light: '#2d2d30',
        },
        surface: {
          DEFAULT: '#2d2d2d',
          hover: '#3d3d3d',
        },
        border: {
          DEFAULT: '#404040',
          light: '#555555',
        },
        text: {
          DEFAULT: '#ffffff',
          secondary: '#cccccc',
          muted: '#999999',
        }
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Oxygen',
          'Ubuntu',
          'Cantarell',
          'Fira Sans',
          'Droid Sans',
          'Helvetica Neue',
          'sans-serif'
        ],
        mono: [
          'Consolas',
          'Monaco',
          'Courier New',
          'monospace'
        ]
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
      },
      animation: {
        'spin-slow': 'spin 3s linear infinite',
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        }
      },
      boxShadow: {
        'modal': '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        'table': '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
      }
    },
  },
  plugins: [],
}
