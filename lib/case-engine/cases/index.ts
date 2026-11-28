// lib/case-engine/cases/index.ts
// 加案子＝加一个文件并在这里登记；引擎代码不动。

import type { CasePackage } from "../types";
import { EXIT9_INVALID_NODS } from "./exit9_invalid_nods";

export const CASES: CasePackage[] = [EXIT9_INVALID_NODS];

export function getCasePackage(caseId: string): CasePackage | undefined {
    return CASES.find((c) => c.id === caseId);
}