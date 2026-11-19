export type PaperTheme = "app" | "light" | "dark";

export interface InkColorPreset {
  readonly id: string;
  readonly label: string;
  readonly hex: string;
}

export const INK_COLORS: readonly InkColorPreset[] = Object.freeze([
  { id: "black", label: "Black ink", hex: "#111827" },
  { id: "white", label: "White ink", hex: "#f8fafc" },
  { id: "blue", label: "Blue ink", hex: "#2563eb" },
  { id: "red", label: "Red ink", hex: "#dc2626" },
  { id: "green", label: "Green ink", hex: "#16a34a" },
  { id: "yellow", label: "Yellow ink", hex: "#eab308" },
]);

export interface ResolvedPaper {
  readonly theme: PaperTheme;
  readonly mode: "light" | "dark";
  readonly backgroundColor: string;
  readonly gridColor: string;
  readonly exportGridColor: string;
  readonly defaultInk: string;
}

// Read the selected app palette, not the operating system's color preference.
const paletteVars = [
  "--background", "--foreground", "--muted-foreground", "--border", "--lh-ink-strong",
  "--lh-ink-italic", "--lh-ink-code", "--lh-accent", "--card", "--lh-error", "--lh-success", "--lh-warning",
];

export function appPalette(): { key: string; mode: "dark" | "light" } {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const mode = root?.classList.contains("light") ? "light" : "dark";
  const style = root && typeof getComputedStyle === "function" ? getComputedStyle(root) : undefined;
  return { mode, key: JSON.stringify([mode, ...paletteVars.map(name => style?.getPropertyValue(name).trim() ?? "")]) };
}

function parseRgb(color: string): [number, number, number] | undefined {
  const trimmed = color.trim();
  const hex6 = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex6) {
    const n = Number.parseInt(hex6[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (hex3) {
    const h = hex3[1]!;
    return [
      Number.parseInt(h[0]! + h[0]!, 16),
      Number.parseInt(h[1]! + h[1]!, 16),
      Number.parseInt(h[2]! + h[2]!, 16),
    ];
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/i.exec(trimmed);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return undefined;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function resolveAppBackground(mode: "light" | "dark"): string {
  if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
    const root = document.documentElement;
    const rawVar = getComputedStyle(root).getPropertyValue("--background").trim();
    if (rawVar && parseRgb(rawVar)) return rawVar;
    const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : "";
    if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent" && parseRgb(bodyBg)) return bodyBg;
  }
  return mode === "light" ? "#ffffff" : "#141414";
}

export function resolvePaperTheme(
  theme: PaperTheme,
  appInk?: { darkInkColor?: string; lightInkColor?: string },
): ResolvedPaper {
  if (theme === "light") {
    return {
      theme: "light",
      mode: "light",
      backgroundColor: "#ffffff",
      gridColor: "rgba(15, 23, 42, 0.12)",
      exportGridColor: "rgba(15, 23, 42, 0.06)",
      defaultInk: "#111827",
    };
  }
  if (theme === "dark") {
    return {
      theme: "dark",
      mode: "dark",
      backgroundColor: "#141414",
      gridColor: "rgba(226, 232, 240, 0.12)",
      exportGridColor: "rgba(226, 232, 240, 0.06)",
      defaultInk: "#f8fafc",
    };
  }
  const palette = appPalette();
  const backgroundColor = resolveAppBackground(palette.mode);
  const rgb = parseRgb(backgroundColor);
  const effectiveMode: "light" | "dark" = rgb
    ? (relativeLuminance(rgb[0], rgb[1], rgb[2]) >= 0.25 ? "light" : "dark")
    : palette.mode;
  const defaultInk = effectiveMode === "light"
    ? (appInk?.lightInkColor || "#111827")
    : (appInk?.darkInkColor || "#f8fafc");
  return {
    theme: "app",
    mode: effectiveMode,
    backgroundColor,
    gridColor: effectiveMode === "light" ? "rgba(15, 23, 42, 0.12)" : "rgba(226, 232, 240, 0.12)",
    exportGridColor: effectiveMode === "light" ? "rgba(15, 23, 42, 0.06)" : "rgba(226, 232, 240, 0.06)",
    defaultInk,
  };
}

/** Resolve stroke ink color against the active paper theme so monochrome ink
 * drawn on dark/light paper remains legible after switching paper theme. */
export function resolveStrokeColor(color: string | undefined, paper: ResolvedPaper): string {
  if (!color || color === "auto") return paper.defaultInk;
  const rgb = parseRgb(color);
  if (!rgb) return paper.defaultInk;
  const [r, g, b] = rgb;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread <= 24) {
    const lum = relativeLuminance(r, g, b);
    if (lum < 0.08 && paper.mode === "dark") return paper.defaultInk;
    if (lum > 0.85 && paper.mode === "light") return paper.defaultInk;
  }
  return color;
}
