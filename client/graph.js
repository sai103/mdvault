// グラフビュー: ノートを点、[[リンク]] を線で表示する（canvas に描画。外部ライブラリなし）
import { api } from "./api.js";
import { navigate } from "./notes.js";
import { resolveLink, state } from "./state.js";
import { $, basename, stripMd } from "./util.js";

let sim = null;

export async function openGraph() {
  $("#graph").showModal();
  const { links } = await api("GET", "/api/links");
  const edges = [];
  const seen = new Set();
  for (const l of links) {
    const dst = resolveLink(l.dst);
    if (!dst || dst === l.src) continue;
    const key = [l.src, dst].sort().join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([l.src, dst]);
  }
  const local = $("#graph-local").checked && state.current;
  let paths = state.notes.map((n) => n.path);
  if (local) {
    // 開いているノートから 2 段階までつながっているノート
    const near = new Set([state.current.path]);
    for (let i = 0; i < 2; i++) for (const [a, b] of edges) { if (near.has(a)) near.add(b); if (near.has(b)) near.add(a); }
    paths = paths.filter((p) => near.has(p));
  }
  start(paths, edges.filter(([a, b]) => paths.includes(a) && paths.includes(b)));
}

function start(paths, edges) {
  sim?.stop();
  const canvas = $("#graph-canvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  };
  resize();
  const index = new Map(paths.map((p, i) => [p, i]));
  const degree = new Array(paths.length).fill(0);
  for (const [a, b] of edges) { degree[index.get(a)]++; degree[index.get(b)]++; }
  const nodes = paths.map((p, i) => {
    const angle = (i / Math.max(paths.length, 1)) * Math.PI * 2;
    return { path: p, label: stripMd(basename(p)), x: Math.cos(angle) * 200 + Math.random(), y: Math.sin(angle) * 200 + Math.random(), vx: 0, vy: 0, r: 4 + Math.min(degree[i], 10) };
  });
  const links = edges.map(([a, b]) => [nodes[index.get(a)], nodes[index.get(b)]]);
  const view = { x: 0, y: 0, k: 1 };
  let alpha = 1, raf = 0, dragging = null, panning = null, hover = null;
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim() || "#888";

  const step = () => {
    // 反発（全ペア）・リンクのばね・中心への引力
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = (2000 / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const [a, b] of links) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 80) / d) * 0.05 * alpha;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.002 * alpha; n.vy -= n.y * 0.002 * alpha;
      if (n === dragging) { n.vx = n.vy = 0; continue; }
      n.x += n.vx; n.y += n.vy;
      n.vx *= 0.6; n.vy *= 0.6;
    }
    alpha = Math.max(alpha * 0.985, 0.02);
  };

  const draw = () => {
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(view.k * dpr, 0, 0, view.k * dpr, w / 2 + view.x * dpr, h / 2 + view.y * dpr);
    const neighbors = new Set(hover ? links.filter(([a, b]) => a === hover || b === hover).flatMap((l) => l) : []);
    ctx.lineWidth = 1 / view.k;
    for (const [a, b] of links) {
      ctx.strokeStyle = hover && (a === hover || b === hover) ? color("--accent") : color("--border");
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.font = `${12 / view.k}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const n of nodes) {
      const current = n.path === state.current?.path;
      ctx.fillStyle = current || n === hover ? color("--accent") : neighbors.has(n) ? color("--link") : color("--muted");
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      // 名前は、拡大したとき・近くにマウスがあるとき・ノートが少ないときだけ出す
      if (view.k > 0.8 || n === hover || neighbors.has(n) || current || nodes.length < 40) {
        ctx.fillStyle = color("--text");
        ctx.fillText(n.label, n.x, n.y + n.r + 12 / view.k);
      }
    }
  };

  // 配置が落ち着いたら計算を止める（ノートが多いと重いため）。ドラッグすると再開する
  const loop = () => { if (alpha > 0.021 || dragging) step(); draw(); raf = requestAnimationFrame(loop); };
  loop();

  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  };
  const hit = (e) => { const p = toWorld(e); return nodes.find((n) => (n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= (n.r + 4) ** 2) ?? null; };
  let moved = false;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    moved = false;
    dragging = hit(e);
    if (!dragging) panning = { x: e.clientX - view.x, y: e.clientY - view.y };
  };
  canvas.onpointermove = (e) => {
    if (dragging) { const p = toWorld(e); dragging.x = p.x; dragging.y = p.y; alpha = Math.max(alpha, 0.3); moved = true; }
    else if (panning) { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; moved = true; }
    else { hover = hit(e); canvas.style.cursor = hover ? "pointer" : "grab"; }
  };
  canvas.onpointerup = (e) => {
    if (dragging && !moved) { $("#graph").close(); navigate(dragging.path); }
    dragging = null; panning = null;
    canvas.releasePointerCapture(e.pointerId);
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    view.k = Math.min(4, Math.max(0.2, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
  };
  window.addEventListener("resize", resize);
  $("#graph-info").textContent = `ノート ${nodes.length} 件・リンク ${links.length} 本`;
  sim = { stop: () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); } };
}

export function setupGraph() {
  $("#open-graph").onclick = () => openGraph().catch((e) => alert(e.message));
  $("#graph-local").onchange = () => openGraph();
  $("#graph").addEventListener("close", () => sim?.stop());
}
