// Shot timing for the promo, shared by capture.mjs and cut.mjs (sheet.py mirrors it).
//
// storyboard.music.grid is the list of beat times (seconds) in the EDITED 60 s track, measured with librosa from
// the real recording (its tempo drifts a little, so the beats are listed, not computed from one bpm). A shot is
// `beats` beats long: it starts where the one before ended and ends on the beat that many beats on, so every cut
// lands on a beat. The first shot starts at 0; the last one runs to music.length. Without a grid, bpm is used.
// Card times (card.in / card.out) and P.beats are counted in beats from the shot's start, so they land on beats too.

export function timeline(board) {
  const m = board.music ?? {};
  const grid = m.grid ?? null;
  const beat = 60 / board.bpm;
  const length = m.length ?? board.shots.reduce((n, s) => n + s.beats, 0) * beat;
  const at = (k) => {
    if (!grid) return Math.min(length, k * beat);
    if (k <= 0) return 0;
    if (k >= grid.length) return length;
    const i = Math.floor(k), f = k - i;
    const a = grid[i], b = i + 1 < grid.length ? grid[i + 1] : length;
    return a + (b - a) * f;
  };
  let k = 0;
  return board.shots.map((s, n) => {
    const k0 = k;
    k += s.beats;
    const start = n === 0 ? 0 : at(k0);
    const end = n === board.shots.length - 1 ? length : at(k);
    // Beat times inside the shot, relative to its start (for P.beats: shells, launches, hits).
    const beats = [];
    for (let j = Math.ceil(k0); j <= k; j++) { const t = at(j) - start; if (t >= 0 && t <= end - start) beats.push(+t.toFixed(4)); }
    const rel = (b) => at(k0 + b) - start;
    return { shot: s, id: s.id, k0, start, end, dur: end - start, beats, rel };
  });
}
