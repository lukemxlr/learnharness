import assert from "node:assert/strict";
import { it } from "node:test";
import { appPalette, INK_COLORS, resolvePaperTheme, resolveStrokeColor } from "../src/theme.ts";

it("reads app mode and every palette color without consulting OS preferences", () => {
  const names = ["document", "getComputedStyle", "matchMedia"] as const;
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let mode = "dark";
  const values = new Map<string, string>();
  try {
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: { documentElement: { classList: { contains: (name: string) => name === mode } }, body: undefined } },
      getComputedStyle: { configurable: true, value: () => ({ getPropertyValue: (name: string) => values.get(name) ?? "", backgroundColor: "" }) },
      matchMedia: { configurable: true, value: () => { throw new Error("OS preferences must not select Drawing Pad ink"); } },
    });
    assert.equal(appPalette().mode, "dark");
    let before = appPalette().key;
    mode = "light";
    assert.equal(appPalette().mode, "light");
    assert.notEqual(appPalette().key, before);
    for (const name of ["--background", "--foreground", "--card", "--border", "--muted-foreground", "--lh-accent",
      "--lh-ink-strong", "--lh-ink-italic", "--lh-ink-code", "--lh-error", "--lh-success", "--lh-warning"]) {
      before = appPalette().key;
      values.set(name, "#abcdef");
      assert.notEqual(appPalette().key, before, name);
    }
  } finally {
    names.forEach((name, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

it("resolves independent Light, Dark, and App paper themes and adapts monochrome strokes for contrast", () => {
  const light = resolvePaperTheme("light");
  const dark = resolvePaperTheme("dark");
  assert.equal(light.backgroundColor, "#ffffff");
  assert.equal(light.defaultInk, "#111827");
  assert.equal(dark.backgroundColor, "#141414");
  assert.equal(dark.defaultInk, "#f8fafc");

  assert.equal(resolveStrokeColor("auto", light), "#111827");
  assert.equal(resolveStrokeColor("auto", dark), "#f8fafc");
  // Monochrome white drawn on dark adapts to dark ink on light paper; black adapts to light ink on dark paper
  assert.equal(resolveStrokeColor("#f8fafc", light), "#111827");
  assert.equal(resolveStrokeColor("#ffffff", light), "#111827");
  assert.equal(resolveStrokeColor("#111827", dark), "#f8fafc");
  assert.equal(resolveStrokeColor("#000000", dark), "#f8fafc");

  // Chromatic colors stay untouched across themes
  for (const preset of INK_COLORS) {
    if (preset.id === "black" || preset.id === "white") continue;
    assert.equal(resolveStrokeColor(preset.hex, light), preset.hex);
    assert.equal(resolveStrokeColor(preset.hex, dark), preset.hex);
  }
});
