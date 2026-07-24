import localFont from "next/font/local";

export const openDyslexic = localFont({
  variable: "--font-opendyslexic",
  preload: false,
  src: [
    {
      path: "./opendyslexic/opendyslexic-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./opendyslexic/opendyslexic-latin-700-normal.woff2",
      weight: "700",
      style: "normal",
    },
  ],
});
