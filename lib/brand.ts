/**
 * Whose app this is: Bops, or a partner's build of it under their own name and look (white label). Chosen
 * when the app is built (NEXT_PUBLIC_BOPS_BRAND, which Next writes into the server and the page alike);
 * the desktop shell gets the same from desktop/brand.json (scripts/brand.sh writes it). Bops when unset.
 *
 * A brand changes what people see: the name, the mark, the colors and type (app/globals.css
 * [data-brand]), the window and the app's identity. What runs underneath (Bops Cloud, Orgo, the bots) is
 * the same app.
 */
export type Brand = {
  id: "bops" | "momentum";
  /** The app's name wherever it shows ("Bops", "Momentum AMP"). */
  name: string;
  /** Its one-line description (the page title's). */
  tagline: string;
  /** Its mark: a picture under public/brand, or none for Bops (the mascot is its mark). */
  mark?: { src: string; alt: string };
  /**
   * The main bot's colors (lib/look.ts, lib/mascot.ts): its headphones and accents, the wash behind its
   * computer and Details, the bezel when you drive its computer, and its color on ink.
   */
  accent: string;
  wash: string;
  bezel: string;
  onInk: string;
};

const BOPS: Brand = {
  id: "bops",
  name: "Bops",
  tagline: "AI coworkers with their own computers.",
  accent: "#E9FF3B",
  wash: "linear-gradient(160deg in oklab, oklab(96.8% -0.056 0.130) 0%, oklab(95.2% -0.090 0.182) 45%, oklab(86% -0.087 0.168) 100%)",
  bezel: "#C6DE12",
  onInk: "#E8FF3A",
};

const MOMENTUM: Brand = {
  id: "momentum",
  name: "Momentum AMP",
  tagline: "AI teammates for your agency, each with its own computer.",
  mark: { src: "/brand/momentum-m.png", alt: "Momentum AMP" },
  // The M's violet, and a wash from lavender into it (momentumamp.com).
  accent: "#A200FF",
  wash: "linear-gradient(160deg, #F7F1FC 0%, #E7D5FA 45%, #C9A2F2 100%)",
  bezel: "#A200FF",
  onInk: "#D2A1FF",
};

export const BRAND: Brand = process.env.NEXT_PUBLIC_BOPS_BRAND === "momentum" ? MOMENTUM : BOPS;
