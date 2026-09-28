declare module "@novnc/novnc" {
  const RFB: new (target: HTMLElement, url: string, options?: { shared?: boolean }) => unknown;
  export default RFB;
}
