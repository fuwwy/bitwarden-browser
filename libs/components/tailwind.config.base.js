/* eslint-disable */
const colors = require("tailwindcss/colors");

module.exports = {
  prefix: "tw-",
  content: ["./src/**/*.{html,ts}", "../../libs/components/src/**/*.{html,ts}"],
  safelist: [],
  corePlugins: { preflight: false },
  theme: {
    colors: {
      transparent: colors.transparent,
      current: colors.current,
      primary: {
        300: "var(--color-primary-300)",
        500: "var(--color-primary-500)",
        700: "var(--color-primary-700)",
      },
      secondary: {
        100: "var(--color-secondary-100)",
        300: "var(--color-secondary-300)",
        500: "var(--color-secondary-500)",
        700: "var(--color-secondary-700)",
      },
      success: {
        500: "var(--color-success-500)",
        700: "var(--color-success-700)",
      },
      danger: {
        500: "var(--color-danger-500)",
        700: "var(--color-danger-700)",
      },
      warning: {
        500: "var(--color-warning-500)",
        700: "var(--color-warning-700)",
      },
      info: {
        500: "var(--color-info-500)",
        700: "var(--color-info-700)",
      },
      text: {
        main: "var(--color-text-main)",
        muted: "var(--color-text-muted)",
        contrast: "var(--color-text-contrast)",
        alt2: "var(--color-text-alt2)",
      },
      background: {
        DEFAULT: "var(--color-background)",
        alt: "var(--color-background-alt)",
        alt2: "var(--color-background-alt2)",
      },
    },
    textColor: {
      main: "var(--color-text-main)",
      muted: "var(--color-text-muted)",
      contrast: "var(--color-text-contrast)",
      alt2: "var(--color-text-alt2)",
      success: "var(--color-success-500)",
      danger: "var(--color-danger-500)",
      warning: "var(--color-warning-500)",
      info: "var(--color-info-500)",
      primary: {
        300: "var(--color-primary-300)",
        500: "var(--color-primary-500)",
        700: "var(--color-primary-700)",
      },
    },
    ringOffsetColor: ({ theme }) => ({
      DEFAULT: theme("colors.background"),
      ...theme("colors"),
    }),
  },
  plugins: [],
};
