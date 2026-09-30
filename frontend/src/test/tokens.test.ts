import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `styles/tokens.css` is the only design system in the repo, and every
 * assertion here is a read of its source text.
 *
 * IMPORTANT — what these tests can and cannot prove. Tailwind is not
 * processed under vitest, and jsdom has no layout engine and no cascade, so
 * nothing in this file measures a computed style, a used value, or a painted
 * pixel. `expect(css).toMatch(...)` proves a rule is *written*; it cannot prove
 * the rule wins, that a class was applied by a component, or that anything is
 * visible to a user. The contrast test is the one exception: it evaluates the
 * WCAG relative-luminance formula in JS on the hex values parsed out of the
 * file, which is real arithmetic on the real token values rather than a proxy
 * for it. Everything else is a structural pin, and is labelled as one.
 */

// `import.meta.url` is an http URL under vitest's jsdom environment, so the
// module URL cannot be handed to `readFileSync`. `process.cwd()` is the vitest
// root (`frontend/`, where vitest.config.ts lives).
const CSS_PATH = resolve(process.cwd(), "src/styles/tokens.css");
const css = readFileSync(CSS_PATH, "utf8");

/** Every declared custom property name, e.g. `--tap-target`. */
function declaredTokens(): string[] {
  return [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1] as string);
}

/** The hex value a token resolves to, following one `var(--alias)` hop. */
function tokenHex(name: string): string {
  const direct = new RegExp(`^\\s*${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, "m").exec(css);
  if (direct) return direct[1] as string;
  const alias = new RegExp(`^\\s*${name}\\s*:\\s*var\\((--[\\w-]+)\\)\\s*;`, "m").exec(css);
  if (alias) return tokenHex(alias[1] as string);
  throw new Error(`${name} does not resolve to a hex colour`);
}

function srgb(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function contrast(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The `App.tsx:64` root div. Every surface the feed renders on is this or lighter. */
const APP_BACKGROUND = "#0A0A0A";

/** The body of the first `@media (prefers-reduced-motion: reduce)` block. */
function reducedMotionBlock(): string {
  const open = css.indexOf("@media (prefers-reduced-motion: reduce)");
  if (open === -1) return "";
  const braceStart = css.indexOf("{", open);
  let depth = 0;
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(braceStart + 1, i);
    }
  }
  return "";
}

describe("tokens.css — the tap-target token is wired, not dead", () => {
  it("declares a .tap-target utility in terms of the --tap-target token", () => {
    // `--tap-target: 64px` was declared and referenced nowhere in the app, so
    // the one value that was supposed to govern every hit area governed none.
    const rule = /\.tap-target\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/var\(\s*--tap-target\s*\)/);
    // Both axes: a control that is wide but 4px tall is not a target.
    expect(rule?.[1]).toMatch(/min-(block|height)-size/);
    expect(rule?.[1]).toMatch(/min-(inline|width)-size/);
  });

  it("no longer leaves --tap-target referenced by nothing", () => {
    const uses = [...css.matchAll(/var\(\s*--tap-target\s*\)/g)];
    expect(uses.length).toBeGreaterThanOrEqual(1);
  });
});

describe("tokens.css — a global focus-visible indicator", () => {
  it("draws a visible indicator on keyboard focus", () => {
    // The app had 11 `focus:outline-none` declarations, which deleted the
    // browser's focus ring outright, and no rule anywhere replaced it. A global
    // rule is the only way the files that removed theirs can inherit one.
    const rules = [...css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);

    const bodies = rules.map((r) => r[2] as string).join("\n");
    expect(bodies).toMatch(/outline\s*:\s*2px solid/);
    // The one thing this must never do is re-suppress the ring.
    expect(bodies).not.toMatch(/outline\s*:\s*(none|0)\b/);
  });

  it("covers the form controls whose focus:outline-none was removed", () => {
    const selector = [...css.matchAll(/([^{}]*:focus-visible[^{}]*)\{/g)]
      .map((m) => m[1] as string)
      .join(",");
    for (const element of ["button", "input", "select", "textarea", "a"]) {
      expect(selector).toMatch(new RegExp(`\\b${element}\\b`));
    }
  });

  it("uses a ring colour that is visible on the app's darkest surface", () => {
    // A focus indicator has to clear 3:1 against what it sits on (WCAG 1.4.11),
    // or it is present in the DOM and invisible to the person using it.
    const ring = /--focus-ring\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(css);
    expect(ring).not.toBeNull();
    expect(contrast(ring?.[1] as string, APP_BACKGROUND)).toBeGreaterThanOrEqual(3);
  });
});

describe("tokens.css — prefers-reduced-motion", () => {
  it("has a prefers-reduced-motion block at all", () => {
    // Zero occurrences existed anywhere in src/. WCAG 2.3.3 is AAA, but 2.2.2
    // Pause/Stop/Hide is A, and the feed's auto-advance has no stop control.
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(reducedMotionBlock()).not.toBe("");
  });

  it("overrides the ungated smooth scroll, which is the motion users feel most", () => {
    // `html { scroll-behavior: smooth }` is unconditional and applies to every
    // scroll in the app, including the feed's auto-advance scroll.
    expect(css).toMatch(/html\s*\{[^}]*scroll-behavior:\s*smooth/);
    expect(reducedMotionBlock()).toMatch(/scroll-behavior:\s*auto/);
  });

  it("stops the animations rather than merely shortening them", () => {
    const block = reducedMotionBlock();
    // `animation-iteration-count: 1` is what kills `.skeleton`'s infinite
    // `shimmer` and Tailwind's `animate-pulse` / `animate-spin`; overriding the
    // duration alone would leave a `pulse` that is merely very fast.
    expect(block).toMatch(/animation-iteration-count\s*:\s*1/);
    expect(block).toMatch(/animation-duration/);
    expect(block).toMatch(/transition-duration/);
  });
});

describe("tokens.css — the category palette is wired", () => {
  const cats = [
    "--cat-instrumental",
    "--cat-funny",
    "--cat-news",
    "--cat-science",
    "--cat-music",
    "--cat-neutral",
  ];

  it("references every --cat-* token from a rule", () => {
    // All six were declared and used nowhere: `AudioClip.category` chips were
    // painted from a hardcoded brand hex instead.
    for (const cat of cats) {
      expect(css, `${cat} is declared but referenced by no rule`).toMatch(
        new RegExp(`var\\(\\s*${cat}\\s*\\)`),
      );
    }
  });

  it("keeps the keys byte-identical to the stored category strings", () => {
    // `/suggestions/?category=` matches by exact string, so a renamed key would
    // silently stop matching. The class names are the keys.
    for (const cat of cats) {
      const key = cat.replace("--cat-", "");
      expect(css).toMatch(new RegExp(`\\.cat-${key}\\b`));
    }
  });
});

describe("tokens.css — the terracotta constraint is recorded on the token", () => {
  it("documents that white on terracotta fails", () => {
    // Measured: white on #e8a87c is 2.03:1. It is a prohibition, not a
    // preference, and the migration that would exercise it is deferred.
    expect(css).toMatch(/never\s+white\s+on\s+terracotta/i);
  });

  it("marks the light theme as unreachable rather than usable", () => {
    // `data-theme` is set nowhere, and enabling it would put the app's
    // hardcoded near-black root div on top of it. Terracotta as text on its
    // `--background` is 1.80:1, so the block cannot be rescued by flipping the
    // attribute either.
    const comment = css.slice(0, css.indexOf('[data-theme="light"]'));
    expect(comment).toMatch(/unreachable|DEAD AND UNSAFE/i);
    expect(comment).toMatch(/set nowhere/i);
    expect(comment).toMatch(/1\.80:1/);
  });
});

describe("tokens.css — token contrast (regression pin, no fix in this pass)", () => {
  it("every token the app uses as text clears 4.5:1 on the app background", () => {
    // A pin, not a repair: the token palette was already well-tuned
    // (RECON-06 §8). The 1.4.3 failures come from components bypassing it with
    // `text-white/30` and `/40`, which this file cannot fix. This test exists
    // so a future edit to a token value cannot silently reintroduce a failure.
    const asText = [
      "--text-primary",
      "--text-secondary",
      "--text-tertiary",
      "--terracotta",
      "--accent-hover",
      "--sage",
      "--honey-gold",
      "--error",
      "--cat-instrumental",
      "--cat-funny",
      "--cat-news",
      "--cat-science",
      "--cat-music",
      "--cat-neutral",
    ];
    for (const token of asText) {
      expect(
        contrast(tokenHex(token), APP_BACKGROUND),
        `${token} is under 4.5:1 on ${APP_BACKGROUND}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("declares every token this file's own utilities reference", () => {
    // Guards against a utility referencing a token that was renamed.
    const declared = new Set(declaredTokens());
    const referenced = new Set(
      [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1] as string),
    );
    for (const name of referenced) {
      expect(declared, `${name} is referenced but never declared`).toContain(name);
    }
  });
});
