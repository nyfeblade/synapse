#!/bin/sh
# Records the README demo from the real app (FUZZ local host, isolated data, temp HOME) and builds
# docs/media/demo.gif and docs/media/demo.mp4 from it. Needs ffmpeg. Run from the repo root.
set -eu
FRAMES="$(mktemp -d)"
trap 'rm -rf "$FRAMES"' EXIT
(cd app && README_DEMO="$FRAMES" npx playwright test -c e2e/playwright.config.ts readme-demo-shots)
node -e '
const fs = require("fs"); const dir = process.argv[1];
const f = JSON.parse(fs.readFileSync(dir + "/frames.json", "utf8"));
const out = f.map((x, i) => `file ${x.file}\nduration ${(i + 1 < f.length ? f[i + 1].t - x.t : 1.8).toFixed(4)}`);
out.push(`file ${f.at(-1).file}`);
fs.writeFileSync(dir + "/list.txt", out.join("\n") + "\n");
' "$FRAMES"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$FRAMES/list.txt" \
  -vf "fps=15,scale=1320:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 docs/media/demo.gif
ffmpeg -loglevel error -y -f concat -safe 0 -i "$FRAMES/list.txt" \
  -vf "fps=30,scale=1320:-2:flags=lanczos,format=yuv420p" -c:v libx264 -crf 24 -preset slow -movflags +faststart -an docs/media/demo.mp4
ls -l docs/media/demo.gif docs/media/demo.mp4
