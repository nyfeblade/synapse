import type { ConformanceCheck } from "../types";
import { ct01, ct02, ct03, ct04, ct05, ct06 } from "./group-a";
import { ct07, ct08, ct09, ct10, ct11, ct12 } from "./group-b";
import { ct13, ct14, ct15, ct16, ct17, ct18, ct19 } from "./group-c";
import { ct20 } from "./ct20-skills";

/** Order matters: later checks override earlier flags (CT-16 can downgrade CT-02's approvalPath). */
export const ALL_CHECKS: ConformanceCheck[] = [ct01, ct02, ct03, ct04, ct05, ct06, ct07, ct08, ct09, ct10, ct11, ct12, ct13, ct14, ct15, ct16, ct17, ct18, ct19, ct20];
