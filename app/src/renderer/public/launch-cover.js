// The launch cover's backstop (index.html #launch-cover). If the launch snap hasn't lifted the cover
// within 2 s of the window's FIRST FRAME, it fades out anyway, so a broken start can never leave the
// window covered. Counted from the first frame, not from page load: the page can spend seconds
// loading before the window draws or is shown, and a clock started at load had already run out by then.
// A plain script, separate from the app bundle, so it still runs if the bundle fails.
(function () {
  requestAnimationFrame(function () {
    setTimeout(function () {
      var c = document.getElementById("launch-cover");
      if (!c) return;
      c.className = "gone";
      setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 400);
    }, 2000);
  });
})();
