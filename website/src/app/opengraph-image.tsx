import { ImageResponse } from "next/og";

export const alt = "Synapse: your own team of AI Bots, on your Mac.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#f4f2ec",
          color: "#1c1b17",
          padding: "80px",
        }}
      >
        <div style={{ display: "flex", fontSize: 28, letterSpacing: 2, color: "#5c574f", textTransform: "uppercase" }}>
          Mac app
        </div>
        <div style={{ display: "flex", fontSize: 88, fontWeight: 600, letterSpacing: -2, marginTop: 18 }}>Synapse</div>
        <div style={{ display: "flex", fontSize: 36, color: "#4f4a43", marginTop: 18, maxWidth: 860 }}>
          Your own team of AI Bots, on your Mac.
        </div>
      </div>
    ),
    { ...size },
  );
}
