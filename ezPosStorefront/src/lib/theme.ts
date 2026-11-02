import "server-only";
import type { CSSProperties } from "react";

/**
 * Theme engine: converts a storefront's token config into CSS variables and
 * provides per-theme skin classes. The 4 launch theme ids MUST match the
 * backend catalog (ezPosBackend/src/modules/storefronts/themes.catalog.ts);
 * unknown ids fall back to the generic skin so old snapshots keep rendering.
 */

const FONT_STACKS: Record<string, string> = {
  system: "system-ui, sans-serif",
  inter: "'Inter Variable', 'Inter', system-ui, sans-serif",
  poppins: "'Poppins', system-ui, sans-serif",
  roboto: "'Roboto', system-ui, sans-serif",
  playfair: "'Playfair Display', Georgia, serif",
  lora: "'Lora', Georgia, serif",
};

const RADIUS: Record<string, string> = {
  none: "0rem",
  sm: "0.25rem",
  md: "0.5rem",
  lg: "1rem",
};

const CONTAINER: Record<string, string> = {
  narrow: "56rem",
  normal: "72rem",
  wide: "84rem",
};

export interface ThemeTokens {
  primaryColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  fontHeading?: string;
  fontBody?: string;
  radius?: string;
  containerWidth?: string;
  headerLayout?: string;
  footerLayout?: string;
  buttonStyle?: string;
  productCardStyle?: string;
}

export function tokensToStyle(tokens: ThemeTokens): CSSProperties {
  const style: Record<string, string> = {
    "--sf-primary": tokens.primaryColor ?? "#16a34a",
    "--sf-secondary": tokens.secondaryColor ?? "#0f172a",
    "--sf-bg": tokens.backgroundColor ?? "#ffffff",
    "--sf-text": tokens.textColor ?? "#0f172a",
    "--sf-font-heading": FONT_STACKS[tokens.fontHeading ?? "inter"] ?? FONT_STACKS.inter!,
    "--sf-font-body": FONT_STACKS[tokens.fontBody ?? "inter"] ?? FONT_STACKS.inter!,
    "--sf-radius": RADIUS[tokens.radius ?? "md"] ?? RADIUS.md!,
    "--sf-container": CONTAINER[tokens.containerWidth ?? "normal"] ?? CONTAINER.normal!,
  };
  return style as CSSProperties;
}

export interface ThemeSkin {
  /** Extra classes mixed into section headings. */
  headingClass: string;
  /** Hero presentation flavor. */
  heroClass: string;
  /** Product card flavor. */
  cardClass: string;
}

const genericSkin: ThemeSkin = {
  headingClass: "font-semibold tracking-tight",
  heroClass: "",
  cardClass: "",
};

const SKINS: Record<string, ThemeSkin> = {
  "aura-fashion": {
    headingClass: "font-serif uppercase tracking-[0.2em]",
    heroClass: "italic",
    cardClass: "hover:opacity-95 transition-opacity",
  },
  "volt-electronics": {
    headingClass: "font-semibold uppercase tracking-tight",
    heroClass: "bg-slate-900 text-white rounded-xl",
    cardClass: "shadow-sm hover:shadow-md transition-shadow",
  },
  "freshmart-grocery": {
    headingClass: "font-bold tracking-tight",
    heroClass: "rounded-2xl",
    cardClass: "hover:-translate-y-0.5 transition-transform",
  },
  "cornerstone-general": genericSkin,
};

export function getSkin(themeId: string): ThemeSkin {
  return SKINS[themeId] ?? genericSkin;
}
