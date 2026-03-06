export interface QualityCheck {
  name: string;
  passed: boolean;
  detail: string;
  category:
    | "lint"
    | "test"
    | "type"
    | "build"
    | "diff"
    | "security"
    | "format"
    | "domain"
    | "custom"
    | "other";
}

export interface QualityResult {
  passed: boolean;
  checks: QualityCheck[];
}
