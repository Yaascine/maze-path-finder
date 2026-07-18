/* ============================================================
   Maze Pathfinder
   ------------------------------------------------------------
   A grid maze editor + live bidirectional Dijkstra visualizer.

   Structure:
     1. Config & state
     2. MinHeap (binary min-heap priority queue)
     3. Board DOM + rendering (state -> classes, nothing else)
     4. Responsive sizing
     5. Pointer input (draw walls, erase, move A/B)
     6. Bidirectional Dijkstra solver
     7. Animation loop (requestAnimationFrame, speed-driven)
     8. Toolbar wiring & status line
   ============================================================ */

"use strict";

/* ---------------- 1. Config & state ---------------- */

const COLS = 31; // landscape grid (~650 cells) fits laptops without scrolling
const ROWS = 21;
const N = COLS * ROWS;
const GAP = 1; // px gap between cells (must match CSS grid gap)
const MAX_CELL = 24; // px
const MIN_CELL = 10; // px
const COST = 1; // uniform edge weight (up/down/left/right)

// ms per algorithm step (one settled node) / per revealed path cell
const SPEEDS = {
  slow: { search: 45, path: 60 },
  normal: { search: 14, path: 35 },
  fast: { search: 3.5, path: 15 },
};

/**
 * Algorithm registry. Adding a future algorithm = add an entry here and
 * flip `ready` once its solver exists. `learn` feeds the toolbar link.
 */
const ALGORITHMS = {
  dijkstra: {
    label: "Dijkstra (bidirectional)",
    ready: true,
    learn: {
      text: "Learn what's Dijkstra ↗",
      url: "https://www.youtube.com/watch?v=EFg3u_E6eHU",
    },
  },
  astar: { label: "A* Search — coming soon", ready: false },
  bfs: { label: "Breadth-First Search — coming soon", ready: false },
  greedy: { label: "Greedy Best-First — coming soon", ready: false },
};

const state = {
  walls: new Uint8Array(N), // 1 = wall
  start: idx(Math.floor(ROWS / 2), 5),
  end: idx(Math.floor(ROWS / 2), COLS - 6),
  mode: "wall", // wall | erase | start | end
  speed: "normal",
  algorithm: "", // key into ALGORITHMS; empty until the user picks one
  phase: "idle", // idle | search | path | done | nopath

  // Visualization overlay (derived by the solver, cleared on edit/reset)
  visitedSide: new Uint8Array(N), // 0 none, 1 = A's wave, 2 = B's wave
  onPath: new Uint8Array(N),
  meet: -1,
  pathLength: 0,
};

let solver = null; // live solver internals while phase is search/path
let cellSize = MAX_CELL; // current cell px, set by fitBoard()

function idx(r, c) {
  return r * COLS + c;
}

function rowOf(i) {
  return Math.floor(i / COLS);
}

function colOf(i) {
  return i % COLS;
}

/* ---------------- 2. MinHeap ---------------- */

/**
 * Array-based binary min-heap keyed on `key` (the tentative distance).
 * Decrease-key is done lazily: we push a fresh entry and skip stale ones
 * (entries whose node was already settled) when popping.
 */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].key <= a[i].key) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }

  peek() {
    return this.items[0];
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < a.length && a[l].key < a[smallest].key) smallest = l;
        if (r < a.length && a[r].key < a[smallest].key) smallest = r;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/* ---------------- 3. Board DOM + rendering ---------------- */

const els = {
  app: document.querySelector(".app"),
  board: document.getElementById("board"),
  boardWrap: document.getElementById("board-wrap"),
  status: document.getElementById("status"),
  callout: document.getElementById("callout"),
  calloutSub: document.getElementById("callout-sub"),
  solve: document.getElementById("btn-solve"),
  resetPath: document.getElementById("btn-reset-path"),
  clear: document.getElementById("btn-clear"),
  modeBtns: [...document.querySelectorAll(".mode-btn")],
  speedBtns: [...document.querySelectorAll(".speed-btn")],
  algoSelect: document.getElementById("algo-select"),
  learnLink: document.getElementById("learn-link"),
};

const cellEls = new Array(N);

function buildBoard() {
  els.board.style.gridTemplateColumns = `repeat(${COLS}, var(--cell))`;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < N; i++) {
    const div = document.createElement("div");
    div.className = "cell";
    frag.appendChild(div);
    cellEls[i] = div;
  }
  els.board.appendChild(frag);
}

/** Derive a cell's full class list purely from state. */
function cellClass(i) {
  let cls = "cell";
  if (state.walls[i]) cls += " wall";
  if (state.visitedSide[i] === 1) cls += " visited-a";
  else if (state.visitedSide[i] === 2) cls += " visited-b";
  if (state.onPath[i]) cls += " path";
  if (state.meet === i) cls += " meet";
  if (state.start === i) cls += " start";
  if (state.end === i) cls += " end";
  return cls;
}

function paintCell(i) {
  cellEls[i].className = cellClass(i);
}

function renderAll() {
  for (let i = 0; i < N; i++) paintCell(i);
}

function setStatus(html, tone = "") {
  els.status.innerHTML = html;
  els.status.className = "status" + (tone ? ` is-${tone}` : "");
}

/* ----- Callout ("This is the path") ----- */

function showCallout(i, steps) {
  const cell = cellEls[i];
  const below = rowOf(i) < 4; // flip under the cell near the top edge
  els.calloutSub.textContent = `length: ${steps} steps`;
  els.callout.classList.toggle("below", below);
  els.callout.style.left = `${cell.offsetLeft + cell.offsetWidth / 2}px`;
  els.callout.style.top = `${below ? cell.offsetTop + cell.offsetHeight : cell.offsetTop}px`;
  els.callout.hidden = false;
}

function hideCallout() {
  els.callout.hidden = true;
}

/* ---------------- 4. Responsive sizing ---------------- */

function fitBoard() {
  const wrapPad = window.innerWidth <= 640 ? 6 : 10;
  const availW = els.app.clientWidth - wrapPad * 2 - 2; // minus wrap padding+border
  const top = els.boardWrap.getBoundingClientRect().top;
  const availH = window.innerHeight - top - 95; // reserve for legend + footer

  const byW = (availW - (COLS - 1) * GAP) / COLS;
  const byH = (availH - (ROWS - 1) * GAP) / ROWS;
  cellSize = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(Math.min(byW, byH))));
  els.board.style.setProperty("--cell", `${cellSize}px`);

  // Keep the callout glued to the meeting cell across resizes
  if (!els.callout.hidden && state.meet >= 0) showCallout(state.meet, state.pathLength);
}

/* ---------------- 5. Pointer input ---------------- */

let painting = false;
let paintValue = 1; // what walls[] gets while dragging (1 draw, 0 erase)
let lastPaintIdx = -1;

function cellAtEvent(e) {
  const rect = els.board.getBoundingClientRect();
  const pitch = cellSize + GAP;
  const c = Math.floor((e.clientX - rect.left) / pitch);
  const r = Math.floor((e.clientY - rect.top) / pitch);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return -1;
  return idx(r, c);
}

function isLocked() {
  return state.phase === "search" || state.phase === "path";
}

/** Any edit invalidates a finished visualization — wipe it first. */
function clearStaleOverlay() {
  if (state.phase === "done" || state.phase === "nopath") {
    clearOverlay(false);
    setStatus("Maze edited — hit <strong>Solve</strong> to search again.");
  }
}

function setWall(i, value) {
  if (i === state.start || i === state.end) return; // endpoints stay clear
  if (state.walls[i] === value) return;
  state.walls[i] = value;
  paintCell(i);
}

function placeEndpoint(which, i) {
  if (state.walls[i]) {
    setStatus("Can't place a point on a wall — pick an open cell.");
    return;
  }
  const other = which === "start" ? state.end : state.start;
  if (i === other) return; // A and B can't share a cell
  const old = state[which];
  state[which] = i;
  paintCell(old);
  paintCell(i);
}

/** Paint every cell on the straight line between two cells (avoids gaps on fast drags). */
function paintLine(from, to) {
  let r0 = rowOf(from);
  let c0 = colOf(from);
  const r1 = rowOf(to);
  const c1 = colOf(to);
  const dr = Math.abs(r1 - r0);
  const dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  for (;;) {
    setWall(idx(r0, c0), paintValue);
    if (r0 === r1 && c0 === c1) break;
    const e2 = 2 * err;
    if (e2 > -dr) {
      err -= dr;
      c0 += sc;
    }
    if (e2 < dc) {
      err += dc;
      r0 += sr;
    }
  }
}

function onPointerDown(e) {
  if (isLocked() || e.button > 0) return;
  const i = cellAtEvent(e);
  if (i < 0) return;
  e.preventDefault();
  clearStaleOverlay();

  if (state.mode === "start" || state.mode === "end") {
    placeEndpoint(state.mode, i);
    painting = true; // allow dragging the point around
  } else {
    // Wall mode toggles based on the first cell; eraser always erases
    paintValue = state.mode === "erase" ? 0 : state.walls[i] ? 0 : 1;
    setWall(i, paintValue);
    painting = true;
  }
  lastPaintIdx = i;
  els.board.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!painting || isLocked()) return;
  const i = cellAtEvent(e);
  if (i < 0 || i === lastPaintIdx) return;

  if (state.mode === "start" || state.mode === "end") {
    placeEndpoint(state.mode, i);
  } else {
    paintLine(lastPaintIdx, i);
  }
  lastPaintIdx = i;
}

function onPointerUp() {
  painting = false;
  lastPaintIdx = -1;
}

/* ---------------- 6. Bidirectional Dijkstra ---------------- */

/**
 * Two Dijkstra searches run at once: one rooted at A (side 1), one at B
 * (side 2), each with its own priority queue, distance map and parent map.
 * The animation loop settles one node per tick, alternating sides.
 *
 * Meeting rule (true bidirectional Dijkstra, not "first collision wins"):
 * every time a node v gets a finite distance from BOTH sides we record
 * distA[v] + distB[v] as a candidate total, keeping the best node `meet`.
 * The search only stops once min(heapA) + min(heapB) >= bestTotal — at that
 * point no undiscovered meeting can beat the recorded one, so the combined
 * path through `meet` is provably the shortest.
 */
function initSolver() {
  solver = {
    distA: new Float64Array(N).fill(Infinity),
    distB: new Float64Array(N).fill(Infinity),
    prevA: new Int32Array(N).fill(-1),
    prevB: new Int32Array(N).fill(-1),
    settledA: new Uint8Array(N),
    settledB: new Uint8Array(N),
    heapA: new MinHeap(),
    heapB: new MinHeap(),
    turn: "A",
    bestTotal: Infinity,
    bestMeet: -1,
    path: [],
    pathIdx: 0,
  };
  solver.distA[state.start] = 0;
  solver.distB[state.end] = 0;
  solver.heapA.push({ key: 0, node: state.start });
  solver.heapB.push({ key: 0, node: state.end });
}

/** Drop already-settled (stale) entries, then return the heap's true top. */
function peekFresh(heap, settled) {
  while (heap.size > 0 && settled[heap.peek().node]) heap.pop();
  return heap.size > 0 ? heap.peek() : null;
}

function considerMeeting(v) {
  if (solver.distA[v] === Infinity || solver.distB[v] === Infinity) return;
  const total = solver.distA[v] + solver.distB[v];
  if (total < solver.bestTotal) {
    solver.bestTotal = total;
    solver.bestMeet = v;
  }
}

const NEIGHBOR_BUF = new Int32Array(4);

function neighborsOf(i, out) {
  const r = rowOf(i);
  const c = colOf(i);
  let n = 0;
  if (r > 0) out[n++] = i - COLS;
  if (r < ROWS - 1) out[n++] = i + COLS;
  if (c > 0) out[n++] = i - 1;
  if (c < COLS - 1) out[n++] = i + 1;
  return n;
}

/** Settle exactly one node on `side`, relaxing its neighbors. */
function settleNext(side) {
  const A = side === "A";
  const heap = A ? solver.heapA : solver.heapB;
  const dist = A ? solver.distA : solver.distB;
  const prev = A ? solver.prevA : solver.prevB;
  const settled = A ? solver.settledA : solver.settledB;

  const u = heap.pop().node; // fresh: caller peeked via peekFresh
  settled[u] = 1;

  // Mark the wave (first side to settle a cell owns its color)
  if (state.visitedSide[u] === 0) {
    state.visitedSide[u] = A ? 1 : 2;
    paintCell(u);
  }
  considerMeeting(u);

  const count = neighborsOf(u, NEIGHBOR_BUF);
  for (let k = 0; k < count; k++) {
    const v = NEIGHBOR_BUF[k];
    if (state.walls[v] || settled[v]) continue;
    const nd = dist[u] + COST;
    if (nd < dist[v]) {
      dist[v] = nd;
      prev[v] = u;
      heap.push({ key: nd, node: v });
      considerMeeting(v);
    }
  }
}

/** One animation step of the search. Returns 'running' | 'found' | 'nopath'. */
function searchTick() {
  const topA = peekFresh(solver.heapA, solver.settledA);
  const topB = peekFresh(solver.heapB, solver.settledB);
  const keyA = topA ? topA.key : Infinity;
  const keyB = topB ? topB.key : Infinity;

  // Stop once no future meeting can beat the best one already found
  if (solver.bestTotal < Infinity && keyA + keyB >= solver.bestTotal) return "found";

  // A frontier ran dry without any meeting → the regions are disconnected
  if (!topA || !topB) return solver.bestTotal < Infinity ? "found" : "nopath";

  // Alternate sides so both waves grow at the same visible pace
  settleNext(solver.turn);
  solver.turn = solver.turn === "A" ? "B" : "A";
  return "running";
}

/** Stitch A→meet (via prevA) and meet→B (via prevB) into one path. */
function buildPath(meet) {
  const path = [];
  for (let v = meet; v !== -1; v = solver.prevA[v]) path.push(v);
  path.reverse(); // start ... meet
  for (let v = solver.prevB[meet]; v !== -1; v = solver.prevB[v]) path.push(v); // ... end
  return path;
}

/* ---------------- 7. Animation loop ---------------- */

let rafId = 0;
let lastFrameTime = 0;
let stepCarry = 0;

function startLoop() {
  lastFrameTime = 0;
  stepCarry = 0;
  rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function frame(now) {
  if (lastFrameTime === 0) lastFrameTime = now;
  const elapsed = now - lastFrameTime;
  lastFrameTime = now;

  const msPerStep =
    state.phase === "search" ? SPEEDS[state.speed].search : SPEEDS[state.speed].path;
  stepCarry += elapsed / msPerStep;
  let steps = Math.min(Math.floor(stepCarry), 500); // cap catch-up after tab switches
  stepCarry -= steps;

  while (steps-- > 0) {
    if (state.phase === "search" && !runSearchStep()) break;
    else if (state.phase === "path" && !runPathStep()) break;
  }

  if (isLocked()) rafId = requestAnimationFrame(frame);
}

/** Returns false when the search phase ended this step. */
function runSearchStep() {
  const result = searchTick();
  if (result === "running") return true;

  if (result === "nopath") {
    state.phase = "nopath";
    setStatus("No path found — the two waves never met.", "error");
    unlockUI();
    return false;
  }

  // Path confirmed: reveal the meeting point and start drawing the path
  solver.path = buildPath(solver.bestMeet);
  state.meet = solver.bestMeet;
  state.pathLength = solver.bestTotal; // edge count == total distance (unit weights)
  paintCell(state.meet);
  showCallout(state.meet, state.pathLength);
  setStatus(`Path found — length: <strong>${state.pathLength}</strong>. Drawing it…`);
  state.phase = "path";
  stepCarry = 0;
  return false;
}

/** Returns false when the path drawing finished this step. */
function runPathStep() {
  if (solver.pathIdx < solver.path.length) {
    const i = solver.path[solver.pathIdx++];
    state.onPath[i] = 1;
    paintCell(i);
    return true;
  }
  state.phase = "done";
  setStatus(
    `Path found — length: <strong>${state.pathLength}</strong> steps from A to B.`,
    "success"
  );
  unlockUI();
  return false;
}

/* ---------------- 8. Toolbar wiring & status ---------------- */

function lockUI() {
  els.board.classList.add("is-locked");
  els.solve.disabled = true;
  els.clear.disabled = true;
  els.algoSelect.disabled = true;
  for (const b of els.modeBtns) b.disabled = true;
}

function unlockUI() {
  els.board.classList.remove("is-locked");
  els.clear.disabled = false;
  els.algoSelect.disabled = false;
  for (const b of els.modeBtns) b.disabled = false;
  updateSolveEnabled();
  if (rafId) stopLoop();
}

function updateSolveEnabled() {
  // A and B always exist in this editor, but keep the guard honest
  els.solve.disabled = isLocked() || state.start < 0 || state.end < 0;
}

/** Wipe the search overlay (waves, path, meeting callout). Walls stay. */
function clearOverlay(announce = true) {
  if (isLocked()) {
    stopLoop();
    unlockUI();
  }
  state.visitedSide.fill(0);
  state.onPath.fill(0);
  state.meet = -1;
  state.pathLength = 0;
  state.phase = "idle";
  solver = null;
  hideCallout();
  renderAll();
  updateSolveEnabled();
  if (announce) setStatus("Path cleared — edit away, then <strong>Solve</strong> again.");
}

function solve() {
  if (isLocked() || state.start < 0 || state.end < 0) return;
  if (!state.algorithm) {
    setStatus("No algorithm selected — pick one from the <strong>Algorithm</strong> menu.", "error");
    return;
  }
  clearOverlay(false);
  initSolver();
  state.phase = "search";
  lockUI();
  setStatus("Solving — two waves expanding from A and B…");
  startLoop();
}

/** Fill the dropdown from the registry: a placeholder + one option per algorithm. */
function buildAlgoSelect() {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose an algorithm…";
  els.algoSelect.appendChild(placeholder);
  for (const [key, algo] of Object.entries(ALGORITHMS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = algo.label;
    opt.disabled = !algo.ready;
    els.algoSelect.appendChild(opt);
  }
}

function selectAlgorithm(key) {
  state.algorithm = key;
  const algo = ALGORITHMS[key];
  // Show the "learn" link only for the picked algorithm (e.g. Dijkstra)
  if (algo && algo.learn) {
    els.learnLink.href = algo.learn.url;
    els.learnLink.textContent = algo.learn.text;
    els.learnLink.hidden = false;
  } else {
    els.learnLink.hidden = true;
  }
  if (algo && !isLocked()) {
    setStatus(`<strong>${algo.label}</strong> selected — draw walls, then hit <strong>Solve</strong>.`);
  }
}

function selectMode(mode) {
  state.mode = mode;
  for (const b of els.modeBtns) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
}

function selectSpeed(speed) {
  state.speed = speed;
  for (const b of els.speedBtns) {
    b.setAttribute("aria-pressed", String(b.dataset.speed === speed));
  }
}

function init() {
  buildBoard();
  buildAlgoSelect();
  renderAll();
  fitBoard();

  // Board input (pointer events cover mouse + touch + pen)
  els.board.addEventListener("pointerdown", onPointerDown);
  els.board.addEventListener("pointermove", onPointerMove);
  els.board.addEventListener("pointerup", onPointerUp);
  els.board.addEventListener("pointercancel", onPointerUp);

  // Toolbar
  els.algoSelect.addEventListener("change", () => selectAlgorithm(els.algoSelect.value));
  for (const b of els.modeBtns) b.addEventListener("click", () => selectMode(b.dataset.mode));
  for (const b of els.speedBtns) b.addEventListener("click", () => selectSpeed(b.dataset.speed));
  els.solve.addEventListener("click", solve);
  els.resetPath.addEventListener("click", () => clearOverlay());
  els.clear.addEventListener("click", () => {
    state.walls.fill(0);
    clearOverlay(false);
    setStatus("Board cleared — walls removed, A and B stay put.");
  });

  window.addEventListener("resize", fitBoard);
  updateSolveEnabled();
}

init();
