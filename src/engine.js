// ============================================================
//  NEON HEIST — Game Engine
//  Covers: Problem Formulation, A* Search, Minimax + Alpha-Beta
// ============================================================

// ── UNIT 1: PROBLEM FORMULATION ──────────────────────────────
// State Space: 2D grid (0 = road, 1 = building)
// Operators:   accelerate, brake, steer-left, steer-right
// Path Cost:   1 unit per grid tile crossed
export const TILE    = 72;
export const GRID_W  = 32;
export const GRID_H  = 32;
export const WORLD_W = GRID_W * TILE;
export const WORLD_H = GRID_H * TILE;

let _grid = [];

export function generateCity() {
  _grid = [];
  for (let y = 0; y < GRID_H; y++) {
    _grid[y] = [];
    for (let x = 0; x < GRID_W; x++) {
      // Road if on every-4th row or column, else building
      _grid[y][x] = (x % 4 === 0 || y % 4 === 0) ? 0 : 1;
    }
  }
  return _grid;
}
export const getGrid    = () => _grid;
export const isRoad     = (gx, gy) => gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H && _grid[gy]?.[gx] === 0;
export const w2g        = (wx, wy) => ({ gx: Math.floor(wx / TILE), gy: Math.floor(wy / TILE) });
export const g2w        = (gx, gy) => ({ wx: gx * TILE + TILE / 2, wy: gy * TILE + TILE / 2 });

export function snapToRoad(wx, wy) {
  let { gx, gy } = w2g(wx, wy);
  if (isRoad(gx, gy)) return { wx, wy };
  for (let r = 1; r <= 8; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (isRoad(gx + dx, gy + dy)) return g2w(gx + dx, gy + dy);
  return { wx, wy };
}

// ── UNIT 2: A* WITH MANHATTAN HEURISTIC ──────────────────────
// Finds shortest road path from player to nearest data orb
// h(n) = Manhattan distance — admissible for grid graphs
export function astar(sx, sy, ex, ey) {
  if (sx === ex && sy === ey) return [];
  const h   = (x, y) => Math.abs(x - ex) + Math.abs(y - ey);
  const key = (x, y) => x * 100 + y;

  const open   = [{ x: sx, y: sy, g: 0, f: h(sx, sy) }];
  const closed = new Set();
  const gCost  = new Map([[key(sx, sy), 0]]);
  const from   = new Map();

  while (open.length) {
    // Select lowest f-score node (priority queue behaviour)
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck  = key(cur.x, cur.y);

    if (cur.x === ex && cur.y === ey) {
      // Reconstruct path backwards via cameFrom map
      const path = [];
      let c = ck;
      while (from.has(c)) { path.unshift({ gx: c / 100 | 0, gy: c % 100 }); c = from.get(c); }
      return path;
    }

    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!isRoad(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = (gCost.get(ck) ?? 0) + 1;
      if (ng < (gCost.get(nk) ?? Infinity)) {
        gCost.set(nk, ng);
        from.set(nk, ck);
        open.push({ x: nx, y: ny, g: ng, f: ng + h(nx, ny) });
      }
    }
  }
  return [];
}

// ── UNIT 3: MINIMAX WITH ALPHA-BETA PRUNING ──────────────────
// Treats pursuit as a 2-player zero-sum game:
//   MAX player = player (tries to escape)
//   MIN player = cop   (tries to intercept)
// Alpha-Beta cuts branches where cop can't do better than known paths
export function minimaxIntercept(copGx, copGy, plGx, plGy, velX, velY, depth) {
  // Predict player's grid position 'depth' steps ahead using velocity
  const predGx = Math.round(plGx + (velX / TILE) * depth * 1.6);
  const predGy = Math.round(plGy + (velY / TILE) * depth * 1.6);
  let tgx = Math.max(0, Math.min(GRID_W - 1, predGx));
  let tgy = Math.max(0, Math.min(GRID_H - 1, predGy));

  // Snap predicted target to nearest road cell
  if (!isRoad(tgx, tgy)) {
    outer: for (let r = 1; r <= 5; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          if (isRoad(tgx + dx, tgy + dy)) { tgx += dx; tgy += dy; break outer; }
  }

  // A* from cop to predicted player position
  const path = astar(copGx, copGy, tgx, tgy);
  if (!path.length) return { gx: tgx, gy: tgy, zones: [] };

  // Alpha-Beta over intercept candidates along the path:
  // alpha = best guaranteed escape score (MAX player)
  // beta  = best guaranteed intercept score (MIN player)
  let alpha = -Infinity, beta = Infinity;
  let bestNode = path[0];
  const zones = [];

  for (let i = 0; i < Math.min(path.length, depth * 3); i++) {
    const n = path[i];
    const copDist  = Math.abs(n.gx - copGx) + Math.abs(n.gy - copGy);
    const plDist   = Math.abs(n.gx - plGx)  + Math.abs(n.gy - plGy);
    // Score = cop advantage: being close to player's future spot
    const score = plDist - copDist * 0.6;

    if (score > alpha) {          // Better intercept found (minimax MAX step)
      alpha = score;
      bestNode = n;
    }
    zones.push({ gx: n.gx, gy: n.gy, depth: i });

    if (beta <= alpha) break;     // ← Alpha-Beta cutoff: prune this branch
  }

  return { gx: bestNode.gx, gy: bestNode.gy, zones };
}

// District visual themes
const THEMES = [
  // Corporate (top-left)
  { road:'#060616', b:['#050514','#07071e'], neon:['#00f7ff','#40e0ff'], light:'#00f7ff' },
  // Neon Alley (top-right)
  { road:'#090610', b:['#180820','#130618'], neon:['#ff2d6e','#b14fff'], light:'#ff2d6e' },
  // Industrial (bottom-left)
  { road:'#080808', b:['#101006','#0e0e04'], neon:['#ffaa00','#ff6600'], light:'#ffaa00' },
  // Slums (bottom-right)
  { road:'#070509', b:['#0d080a','#100a0c'], neon:['#00ffaa','#44ff88'], light:'#00ffaa' },
];

export function getTheme(gx, gy) {
  return THEMES[(gx < GRID_W/2 ? 0 : 1) + (gy < GRID_H/2 ? 0 : 2)];
}

// Window cache per building tile
const _winCache = new Map();
export function getBuildingWindows(gx, gy) {
  const k = gx * 1000 + gy;
  if (!_winCache.has(k)) {
    const wins = [];
    for (let wx = 0; wx < 3; wx++)
      for (let wy = 0; wy < 4; wy++)
        wins.push({ x: 12 + wx*18, y: 10 + wy*15,
          lit: Math.sin(gx*wx*13.7 + gy*wy*7.3) > 0.15 });
    _winCache.set(k, wins);
  }
  return _winCache.get(k);
}
