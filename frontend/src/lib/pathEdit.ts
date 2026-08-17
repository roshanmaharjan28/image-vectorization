import type { Point } from './pathFlatten';

// Node-editing support for a layer's `attrs.d`: parses a path into normalized absolute commands
// (expanding relative/shorthand forms), exposes one draggable "anchor" per endpoint-bearing
// command plus the bezier control points that should translate along with it, and serializes
// edits back into a `d` string. Kept separate from pathFlatten.ts, which only needs flattened
// polygon contours (via the browser's getPointAtLength) and never exposes control points.

export type Command =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'A'; rx: number; ry: number; rot: number; large: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { type: 'Z' };

export interface Subpath {
  commands: Command[];
  closed: boolean;
}

export interface ParsedPath {
  subpaths: Subpath[];
}

/** A control point attached to one command's x1/y1 (or, for a C command, x2/y2) field. */
export interface ControlRef {
  commandIndex: number;
  which: 1 | 2;
}

export interface AnchorInfo {
  id: string;
  subpathIndex: number;
  /** Normally one command index; two for a closed subpath's start/end seam (see buildAnchors). */
  commandIndices: number[];
  point: Point;
  controls: ControlRef[];
  controlPoints: Point[]; // parallel to `controls`
}

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

// Handles the SVG-legal compact form "1.2.3" (= "1.2 .3") by preferring a full "digits.digits"
// match before falling back to a bare ".digits" or "digits" run.
const NUM_RE = /[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

function parseNums(s: string): number[] {
  return (s.match(NUM_RE) ?? []).map(Number);
}

interface RawCommand {
  letter: string;
  nums: number[];
}

function tokenize(d: string): RawCommand[] {
  const commands: RawCommand[] = [];
  const re = /([MLHVCSQTAZ])([^MLHVCSQTAZ]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    commands.push({ letter: m[1], nums: parseNums(m[2]) });
  }
  return commands;
}

/**
 * Parses a `d` string into subpaths of normalized ABSOLUTE commands — relative commands are
 * resolved against the running current point, H/V become L, and S/T shorthand curves are expanded
 * via the standard reflected-control-point rule (mirroring the previous command's last control
 * point through the current point, or falling back to the current point itself if the previous
 * command wasn't a curve of the same family — see the SVG spec's `S`/`T` semantics).
 */
export function parsePath(d: string): ParsedPath {
  const subpaths: Subpath[] = [];
  let curCommands: Command[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: Point = [0, 0];
  let prevLetter = '';

  function pushSubpath(closed: boolean) {
    if (curCommands.length) subpaths.push({ commands: curCommands, closed });
    curCommands = [];
  }

  for (const { letter, nums } of tokenize(d)) {
    const isRel = letter === letter.toLowerCase();
    const type = letter.toUpperCase();

    if (type === 'Z') {
      curCommands.push({ type: 'Z' });
      cx = sx;
      cy = sy;
      pushSubpath(true);
      prevLetter = 'Z';
      continue;
    }

    const arity = ARITY[type];
    if (!arity) continue;

    for (let i = 0; i + arity <= nums.length; i += arity) {
      const isFirst = i === 0;
      // A moveto's coordinate pairs after the first are implicit linetos (SVG spec).
      const repeatLetter = type === 'M' && !isFirst ? 'L' : type;
      const c = nums.slice(i, i + arity);

      switch (repeatLetter) {
        case 'M': {
          const x = isRel ? cx + c[0] : c[0];
          const y = isRel ? cy + c[1] : c[1];
          pushSubpath(false);
          curCommands.push({ type: 'M', x, y });
          cx = x;
          cy = y;
          sx = x;
          sy = y;
          break;
        }
        case 'L': {
          const x = isRel ? cx + c[0] : c[0];
          const y = isRel ? cy + c[1] : c[1];
          curCommands.push({ type: 'L', x, y });
          cx = x;
          cy = y;
          break;
        }
        case 'H': {
          const x = isRel ? cx + c[0] : c[0];
          curCommands.push({ type: 'L', x, y: cy });
          cx = x;
          break;
        }
        case 'V': {
          const y = isRel ? cy + c[0] : c[0];
          curCommands.push({ type: 'L', x: cx, y });
          cy = y;
          break;
        }
        case 'C': {
          const x1 = isRel ? cx + c[0] : c[0];
          const y1 = isRel ? cy + c[1] : c[1];
          const x2 = isRel ? cx + c[2] : c[2];
          const y2 = isRel ? cy + c[3] : c[3];
          const x = isRel ? cx + c[4] : c[4];
          const y = isRel ? cy + c[5] : c[5];
          curCommands.push({ type: 'C', x1, y1, x2, y2, x, y });
          lastCtrl = [x2, y2];
          cx = x;
          cy = y;
          break;
        }
        case 'S': {
          const x2 = isRel ? cx + c[0] : c[0];
          const y2 = isRel ? cy + c[1] : c[1];
          const x = isRel ? cx + c[2] : c[2];
          const y = isRel ? cy + c[3] : c[3];
          const reflected: Point = prevLetter === 'C' || prevLetter === 'S' ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
          curCommands.push({ type: 'C', x1: reflected[0], y1: reflected[1], x2, y2, x, y });
          lastCtrl = [x2, y2];
          cx = x;
          cy = y;
          break;
        }
        case 'Q': {
          const x1 = isRel ? cx + c[0] : c[0];
          const y1 = isRel ? cy + c[1] : c[1];
          const x = isRel ? cx + c[2] : c[2];
          const y = isRel ? cy + c[3] : c[3];
          curCommands.push({ type: 'Q', x1, y1, x, y });
          lastCtrl = [x1, y1];
          cx = x;
          cy = y;
          break;
        }
        case 'T': {
          const x = isRel ? cx + c[0] : c[0];
          const y = isRel ? cy + c[1] : c[1];
          const reflected: Point = prevLetter === 'Q' || prevLetter === 'T' ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
          curCommands.push({ type: 'Q', x1: reflected[0], y1: reflected[1], x, y });
          lastCtrl = reflected;
          cx = x;
          cy = y;
          break;
        }
        case 'A': {
          const x = isRel ? cx + c[5] : c[5];
          const y = isRel ? cy + c[6] : c[6];
          curCommands.push({
            type: 'A',
            rx: c[0],
            ry: c[1],
            rot: c[2],
            large: c[3] ? 1 : 0,
            sweep: c[4] ? 1 : 0,
            x,
            y,
          });
          cx = x;
          cy = y;
          break;
        }
      }
      prevLetter = repeatLetter;
    }
  }
  pushSubpath(false);
  return { subpaths };
}

function endpoint(cmd: Command): Point | null {
  return cmd.type === 'Z' ? null : [cmd.x, cmd.y];
}

const SEAM_EPSILON = 1e-3;

function closeEnough(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) < SEAM_EPSILON && Math.abs(a[1] - b[1]) < SEAM_EPSILON;
}

function controlsForAnchor(commands: Command[], commandIndices: number[]): ControlRef[] {
  const controls: ControlRef[] = [];
  for (const idx of commandIndices) {
    const cmd = commands[idx];
    if (cmd.type === 'C') controls.push({ commandIndex: idx, which: 2 });
    else if (cmd.type === 'Q') controls.push({ commandIndex: idx, which: 1 });
    const next = commands[idx + 1];
    if (next?.type === 'C' || next?.type === 'Q') controls.push({ commandIndex: idx + 1, which: 1 });
  }
  return controls;
}

function controlPoint(commands: Command[], ref: ControlRef): Point {
  const cmd = commands[ref.commandIndex] as Extract<Command, { type: 'C' | 'Q' }>;
  return ref.which === 1 ? [cmd.x1, cmd.y1] : [(cmd as Extract<Command, { type: 'C' }>).x2, (cmd as Extract<Command, { type: 'C' }>).y2];
}

/**
 * One draggable anchor per endpoint-bearing command (M/L/C/Q/A). A closed subpath whose last
 * command's endpoint coincides with its initial `M` (the common case for traced shapes) gets a
 * single merged seam anchor spanning both commands, so dragging it doesn't tear the seam open.
 */
function buildAnchorsForSubpath(subpath: Subpath, subpathIndex: number): AnchorInfo[] {
  const { commands, closed } = subpath;
  const endpointIdxs = commands.reduce<number[]>((acc, c, i) => {
    if (endpoint(c)) acc.push(i);
    return acc;
  }, []);
  if (endpointIdxs.length === 0) return [];

  const firstIdx = endpointIdxs[0];
  const lastIdx = endpointIdxs[endpointIdxs.length - 1];
  const mergeSeam = closed && lastIdx !== firstIdx && closeEnough(endpoint(commands[firstIdx])!, endpoint(commands[lastIdx])!);

  const anchors: AnchorInfo[] = [];
  for (const idx of endpointIdxs) {
    if (mergeSeam && idx === lastIdx) continue;
    const commandIndices = mergeSeam && idx === firstIdx ? [firstIdx, lastIdx] : [idx];
    const controls = controlsForAnchor(commands, commandIndices);
    anchors.push({
      id: `${subpathIndex}:${idx}`,
      subpathIndex,
      commandIndices,
      point: endpoint(commands[idx])!,
      controls,
      controlPoints: controls.map((ref) => controlPoint(commands, ref)),
    });
  }
  return anchors;
}

export function getAnchors(parsed: ParsedPath): AnchorInfo[] {
  return parsed.subpaths.flatMap((sp, i) => buildAnchorsForSubpath(sp, i));
}

export function cloneParsedPath(parsed: ParsedPath): ParsedPath {
  return { subpaths: parsed.subpaths.map((sp) => ({ closed: sp.closed, commands: sp.commands.map((c) => ({ ...c })) })) };
}

/**
 * Returns a new ParsedPath with `anchor`'s point(s) and attached control points set to absolute
 * positions — always applied against a clone of `parsed`, never mutating it in place, so callers
 * can recompute a drag's result from the same drag-start snapshot every frame instead of
 * accumulating error frame over frame (same pattern as useCanvasInteractions' gizmo drags).
 */
export function applyAnchorEdit(parsed: ParsedPath, anchor: AnchorInfo, newPoint: Point, newControlPoints: Point[]): ParsedPath {
  const cloned = cloneParsedPath(parsed);
  const subpath = cloned.subpaths[anchor.subpathIndex];
  for (const idx of anchor.commandIndices) {
    const cmd = subpath.commands[idx] as Extract<Command, { x: number; y: number }>;
    cmd.x = newPoint[0];
    cmd.y = newPoint[1];
  }
  anchor.controls.forEach((ref, i) => {
    const cmd = subpath.commands[ref.commandIndex] as Extract<Command, { type: 'C' | 'Q' }>;
    const [px, py] = newControlPoints[i];
    if (ref.which === 1) {
      cmd.x1 = px;
      cmd.y1 = py;
    } else {
      (cmd as Extract<Command, { type: 'C' }>).x2 = px;
      (cmd as Extract<Command, { type: 'C' }>).y2 = py;
    }
  });
  return cloned;
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Rebuilds a `d` string from a ParsedPath, always emitting absolute uppercase commands. */
export function serializePath(parsed: ParsedPath): string {
  const parts: string[] = [];
  for (const sp of parsed.subpaths) {
    for (const cmd of sp.commands) {
      switch (cmd.type) {
        case 'M':
          parts.push(`M${fmt(cmd.x)},${fmt(cmd.y)}`);
          break;
        case 'L':
          parts.push(`L${fmt(cmd.x)},${fmt(cmd.y)}`);
          break;
        case 'C':
          parts.push(`C${fmt(cmd.x1)},${fmt(cmd.y1)} ${fmt(cmd.x2)},${fmt(cmd.y2)} ${fmt(cmd.x)},${fmt(cmd.y)}`);
          break;
        case 'Q':
          parts.push(`Q${fmt(cmd.x1)},${fmt(cmd.y1)} ${fmt(cmd.x)},${fmt(cmd.y)}`);
          break;
        case 'A':
          parts.push(`A${fmt(cmd.rx)},${fmt(cmd.ry)} ${fmt(cmd.rot)} ${cmd.large} ${cmd.sweep} ${fmt(cmd.x)},${fmt(cmd.y)}`);
          break;
        case 'Z':
          parts.push('Z');
          break;
      }
    }
  }
  return parts.join(' ');
}
