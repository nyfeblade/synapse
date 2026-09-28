// The package's exports map only allows the bare specifier (it points at ./core/rfb.js internally).
import RFB from "@novnc/novnc";

export interface RfbLike {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  focusOnClick: boolean;
  background: string;
  disconnect(): void;
  focus(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
  addEventListener(type: string, cb: (e: CustomEvent) => void): void;
  removeEventListener(type: string, cb: (e: CustomEvent) => void): void;
}

/** The only file that imports noVNC directly; tests mock this module. */
export function createRfb(target: HTMLElement, url: string): RfbLike {
  const rfb = new RFB(target, url, { shared: true }) as unknown as RfbLike;
  // Task 30 fuzz: noVNC logs an error when disconnect() hits an RFB that is already disconnected; make it idempotent.
  let gone = false;
  rfb.addEventListener("disconnect", () => { gone = true; });
  const disconnect = rfb.disconnect.bind(rfb);
  rfb.disconnect = () => {
    if (gone) return;
    gone = true;
    disconnect();
  };
  return rfb;
}
