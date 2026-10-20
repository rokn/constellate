/**
 * Each top-level directory gets a territory colour on the map. Hues walk the
 * golden angle so neighbours never look alike, and skip the bands the display
 * grammar reserves: magenta (the course), amber (runtime), cyan (static).
 */
const RESERVED: [number, number][] = [
  [295, 330], // course
  [30, 48], // runtime
  [188, 200], // static
];

export function territoryColors(tops: string[]): Map<string, string> {
  const sorted = [...new Set(tops)].sort();
  const out = new Map<string, string>();
  let h = 205;
  sorted.forEach((t, i) => {
    do h = (h + 137.508) % 360;
    while (RESERVED.some(([a, b]) => h >= a && h <= b));
    // Past a handful of colours hue alone stops separating them (three
    // greens in a row), so lightness and saturation alternate as well.
    const [sat, light] = [[55, 66], [70, 54], [40, 76]][i % 3];
    out.set(t, `hsl(${h.toFixed(0)}, ${sat}%, ${light}%)`);
  });
  return out;
}

export const COURSE = "#ff4fd8";
export const STATIC = "#5bd6ff";
export const RUNTIME = "#ffb547";
