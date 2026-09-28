import { STR5 } from "@synapse/shared";
import { useAsync } from "../../async-resource";
import { callQuiet } from "../../bridge";
import { Async } from "../Async";
import { registerGeneralBlock } from "./sections";

// Same shape as MemoryBlock's defect, with a sharper edge: the read gated the whole block, so a
// host that would not answer removed the "Security key" heading and card from Settings → General
// entirely — silently, with `.catch(() => {})` swallowing the reason. The read stays (it is what
// the toggle will read once the takeover it describes is enforced); what changed is that failing
// it now says so instead of deleting the section.
export function SecurityKeyBlock() {
  // callQuiet: this block presents its own failure, in place.
  const settings = useAsync(() => callQuiet("getPhase5Settings", {}), []);
  return (
    <>
      <h3>{STR5.securityKey}</h3>
      <div className="settings-card">
        <Async resource={settings} label={STR5.securityKey}>
          {() => (
            <div className="settings-row">
              <span style={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{STR5.useSecurityKeys}</span>
                <span className="muted"><strong>{STR5.comingLater}</strong> · {STR5.securityKeyTakeover}</span>
              </span>
              {/* P5 review minor: nothing enforces this yet, so the switch is disabled ("Coming later"), never a no-op toggle. */}
              <button type="button" role="switch" aria-checked={false} aria-label={STR5.useSecurityKeys} className="switch" disabled />
            </div>
          )}
        </Async>
      </div>
    </>
  );
}

registerGeneralBlock("security-key", 30, SecurityKeyBlock);
