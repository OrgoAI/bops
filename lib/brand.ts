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
};

const BOPS: Brand = { id: "bops", name: "Bops", tagline: "AI coworkers with their own computers." };

const MOMENTUM: Brand = {
  id: "momentum",
  name: "Momentum AMP",
  tagline: "AI teammates for your agency, each with its own computer.",
  mark: { src: "/brand/momentum-m.png", alt: "Momentum AMP" },
};

export const BRAND: Brand = process.env.NEXT_PUBLIC_BOPS_BRAND === "momentum" ? MOMENTUM : BOPS;
