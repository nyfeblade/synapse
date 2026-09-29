// The home page: the lead Bot snaps together once when the crew first comes into view (silent; a click
// replays it with the app's click sound), and the app demo plays its short task on a loop while on screen.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- the snap (snap.js, the app's own launch animation) ---- */
  const crew = document.getElementById("crew"), lead = document.getElementById("snapBot"), cv = document.getElementById("snap");
  const ctx = cv && cv.getContext("2d");
  if (crew && lead && ctx && window.Snap && !reduced) {
    const BODY = "#ec7431", INK = "#111110";
    // The canvas is 3x the Bot's box; 5/3 makes the canvas Bot the same size as the SVG one it hands over to.
    const K = 5 / 3;
    const draw = (frame) => {
      const d = devicePixelRatio || 1, r = cv.getBoundingClientRect(), W = r.width, H = r.height;
      if (cv.width !== Math.round(W * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      if (!frame) return;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.translate(W / 2, H / 2); ctx.scale(K, K); ctx.translate(-W / 2, -H / 2);
      Snap.drawLaunch(ctx, frame, { width: W, height: H, background: "rgba(0,0,0,0)", body: BODY, ink: INK, edge: null, accent: BODY });
    };
    let raf = 0, playing = false;
    const HOLD = 790; // rest on the whole Bot before the app's own fade-out
    const settle = () => {
      playing = false; draw(null); lead.classList.remove("pre");
      crew.classList.remove("cheer"); void crew.offsetWidth; crew.classList.add("cheer");
      setTimeout(() => crew.classList.remove("cheer"), 1200);
    };
    const play = (withSound) => {
      cancelAnimationFrame(raf); playing = true; lead.classList.add("pre");
      const sim = Snap.createLaunchSim();
      if (withSound) {
        const ac = Snap.openSnapAudio();
        if (ac) { const go = () => Snap.scheduleSnapClicks(ac, 0, Snap.snapClicks()); ac.state === "running" ? go() : ac.resume().then(go, () => {}); }
      }
      const t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(now - t0, HOLD);
        while (sim.t < t) sim.step(Math.min(50, t - sim.t + 0.01));
        if (t >= HOLD) return settle();
        draw(sim.frame()); raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    // Apart until it comes into view.
    lead.classList.add("pre"); draw(Snap.createLaunchSim().frame());
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { io.disconnect(); setTimeout(() => play(false), 350); } }, { threshold: 0.6 });
    io.observe(crew);
    lead.addEventListener("click", () => { if (!playing) play(true); });
    addEventListener("resize", () => { if (!playing && lead.classList.contains("pre")) draw(Snap.createLaunchSim().frame()); });
  }

  /* ---- the demo: a short task, on a loop, only while it's on screen ---- */
  const demo = document.getElementById("demo");
  if (!demo) return;
  const $ = (s) => demo.querySelector(s), $$ = (s) => [...demo.querySelectorAll(s)];
  const status = $("[data-status]"), side = $("[data-side]"), allow = $(".approve .a1");
  const setStatus = (text, cls) => { status.textContent = text; status.className = `status${cls ? " " + cls : ""}`; side.textContent = text; };
  if (reduced) { allow.classList.add("press"); setStatus("Done", "done"); return; }

  demo.classList.add("js");
  const step = (n) => demo.querySelector(`[data-step="${n}"]`);
  const li = (n) => step(n);
  const show = (n) => step(n).classList.add("show");
  const run = (n) => { show(n); li(n).classList.add("run"); };
  const ok = (n) => { li(n).classList.remove("run"); li(n).classList.add("ok"); };
  const reset = () => {
    $$("[data-step]").forEach((el) => el.classList.remove("show", "run", "ok"));
    allow.classList.remove("press"); demo.classList.remove("fade"); setStatus("Working");
  };
  const SCRIPT = [
    [0, reset],
    [500, () => show(0)],
    [1200, () => run(1)],
    [2000, () => { ok(1); run(2); }],
    [2900, () => { ok(2); run(3); }],
    [3800, () => { ok(3); run(4); }],
    [4700, () => ok(4)],
    [5100, () => { show(5); setStatus("Waiting for you", "wait"); }],
    [6900, () => allow.classList.add("press")],
    [7400, () => setStatus("Working")],
    [8000, () => { show(6); setStatus("Opened PR #482", "done"); }],
    [12500, () => demo.classList.add("fade")],
  ];
  const LOOP = 13000;
  let t = 0, next = 0, last = 0, onScreen = false, raf = 0;
  const frame = (now) => {
    t += Math.min(100, now - last); last = now;
    while (next < SCRIPT.length && SCRIPT[next][0] <= t) SCRIPT[next++][1]();
    if (t >= LOOP) { t = 0; next = 0; }
    raf = requestAnimationFrame(frame);
  };
  const resume = () => { if (onScreen && !document.hidden && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  const pause = () => { cancelAnimationFrame(raf); raf = 0; };
  new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; onScreen ? resume() : pause(); }, { threshold: 0.25 }).observe(demo);
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));
})();
