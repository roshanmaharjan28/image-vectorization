export type Mat2x3 = [number, number, number, number, number, number]; // a b c d e f, SVG matrix order

export const IDENTITY: Mat2x3 = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Mat2x3, m2: Mat2x3): Mat2x3 {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function parseNumbers(args: string): number[] {
  return (args.match(/-?[\d.]+(?:e-?\d+)?/gi) ?? []).map(Number);
}

/**
 * Parses an SVG `transform` attribute into a single 2x3 affine matrix, composing each
 * translate/scale/rotate/skew/matrix function left to right per the SVG spec. Needed because
 * vtracer emits every path as `<path d="..." transform="translate(tx,ty)"/>` — the browser's
 * native SVG renderer applies that transform for free, but flattening/triangulating just the
 * raw `d` coordinates (as Canvas.tsx's DOM approach doesn't need to worry about) would place
 * every shape at the wrong position.
 */
export function parseTransform(transform: string | undefined): Mat2x3 {
  if (!transform) return IDENTITY;
  let result = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(transform))) {
    const [, name, argsStr] = match;
    const args = parseNumbers(argsStr);
    let m: Mat2x3 = IDENTITY;
    switch (name) {
      case 'translate':
        m = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        const sy = args[1] ?? sx;
        m = [sx, 0, 0, sy, 0, 0];
        break;
      }
      case 'rotate': {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rotation: Mat2x3 = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const [cx, cy] = [args[1], args[2]];
          m = multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
        } else {
          m = rotation;
        }
        break;
      }
      case 'skewX':
        m = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        m = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      case 'matrix':
        if (args.length === 6) m = args as Mat2x3;
        break;
      default:
        break;
    }
    result = multiply(result, m);
  }
  return result;
}

export function applyTransform([a, b, c, d, e, f]: Mat2x3, x: number, y: number): [number, number] {
  return [a * x + c * y + e, b * x + d * y + f];
}

export function isIdentityMatrix(m: Mat2x3): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/** Composes a pure translation onto the outside of `m` — i.e. moves the already-transformed shape by (dx, dy). */
export function translateMatrix(m: Mat2x3, dx: number, dy: number): Mat2x3 {
  return multiply([1, 0, 0, 1, dx, dy], m);
}

/** Composes a scale about world-space point (px, py) onto the outside of `m`, used for gizmo corner-handle drags. */
export function scaleAroundPivot(m: Mat2x3, px: number, py: number, sx: number, sy: number): Mat2x3 {
  const scale: Mat2x3 = multiply(multiply([1, 0, 0, 1, px, py], [sx, 0, 0, sy, 0, 0]), [1, 0, 0, 1, -px, -py]);
  return multiply(scale, m);
}

/** Composes a rotation (radians) about world-space point (px, py) onto the outside of `m`, used for the gizmo rotate handle. */
export function rotateAroundPivot(m: Mat2x3, px: number, py: number, radians: number): Mat2x3 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotation: Mat2x3 = multiply(multiply([1, 0, 0, 1, px, py], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -px, -py]);
  return multiply(rotation, m);
}
