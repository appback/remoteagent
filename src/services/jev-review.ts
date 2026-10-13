export const REVIEW_QUESTIONS = {
  aligned: "Does the answer address the CURRENT user request without substituting a different task?",
  supported: "Are factual and completion claims supported by the supplied material? Treat report evidence as agent-declared, not independently observed. A provider returning is not proof of tests or deployment. For ordinary explanations, evaluate reasoning and consistency; do not demand commits or command logs. Unperformed future plans must not be claimed as completed.",
  clear: "Does the answer clearly distinguish performed work, plans and unresolved uncertainty? If blocked or failed, does it identify the specific failed step, observed evidence (or explicitly unknown cause), remaining work, and concrete user action needed? A vague apology, promise or unsupported inability claim is not an actionable report. Evaluate meaning, not particular words or formatting.",
  complete: "Is the CURRENT requested scope finished or fully answered? Do not require work the user did not request, including deployment when only advice was requested.",
  continuable: "Does requested work remain that the agent can carry out now without user input, approval, credentials or an external fix?",
  needs_user: "Does continuing require user input, approval, credentials or an external fix?",
  improved: "Compared with previousReview.report, is there substantive progress on the current request or resolution of the listed issues, with new relevant evidence, a corrected claim or missing answer? Another promise, apology or paraphrase without action is not progress. Answer yes if there is no previous review. Evaluate meaning, not particular words.",
} as const;
export type ReviewScores = Record<keyof typeof REVIEW_QUESTIONS, number>;
export type ReviewAction = "retry" | "progress" | "result" | "blocked";
export type ReviewAssessment = { action: ReviewAction; issues: string[]; scores: ReviewScores };
export type PreviousReview = { report: string; issues: string[] };
export const JEV_REPORT_GUIDE = "Jev report review: distinguish completed work, work still executable, and failure/blockage. If work can proceed, perform it instead of ending with a promise or apology. Report actual actions and evidence. If impossible, identify the failed step, observed error or explicitly unknown cause, what remains, and the exact input/authorization/action requested from the user. Never invent a blocker or a successful outcome. For simple questions an actual answer with reasoning suffices; no artificial work log is required. Retain the REPORT tag, but it is not proof of completion. Do not undo or repeat completed changes to satisfy review.";

export function assessReview(scores: ReviewScores, threshold: number): ReviewAssessment {
  const issues = (["aligned", "supported", "clear"] as const).filter(k => scores[k] < threshold) as string[];
  if (scores.needs_user >= threshold) return { action: issues.length ? "retry" : "blocked", issues: issues.length ? [...issues, "needs_user"] : ["needs_user"], scores };
  const complete = scores.complete >= threshold;
  const continuable = scores.continuable >= threshold;
  if (complete === continuable) issues.push("ambiguous_status");
  return { action: issues.length ? "retry" : complete ? "result" : "progress", issues, scores };
}

export class JevReviewGuard {
  attempts = 0;
  previous?: PreviousReview;
  resetComparison() { this.previous = undefined; }
  next(assessment: ReviewAssessment, report: string, threshold: number, maxRetries: number, declaredBlocked = false) {
    // A review cannot authorize work the provider says requires intervention.
    if (declaredBlocked && assessment.action !== "blocked") assessment = { ...assessment, action: "retry", issues: [...assessment.issues, "blocked_status"] };
    if (assessment.action === "progress") {
      if (this.previous && assessment.scores.improved < threshold) return "no_improvement";
      this.previous = { report, issues: ["actual_progress"] };
      return "progress";
    }
    if (assessment.action !== "retry") { this.resetComparison(); return assessment.action; }
    if (this.previous && assessment.scores.improved < threshold) return "no_improvement";
    if (this.attempts >= maxRetries) return "retry_limit";
    this.attempts++;
    this.previous = { report, issues: assessment.issues };
    return "retry";
  }
}

export function reviewRetryPrompt(instruction: string, review: PreviousReview): string {
  return ["Verify and correct your last response to the CURRENT instruction below. If work remains and is authorized and feasible, perform it before reporting. Address each named review issue using actual evidence or correct unsupported claims. Do not invent evidence. Do not undo or repeat completed work merely to satisfy this review. If authorization or information is missing, report blocked with the concrete request needed. If the review is mistaken, explain using evidence. Return the corrected user-facing report.",
    ...(review.issues.includes("blocked_status") || review.issues.includes("needs_user") ? ["Clarification only: do not execute tools or resume the blocked work in this turn. Explain the observed obstacle and the specific user action needed, or correct your unsupported blocker claim. A reviewer score is not permission to bypass restrictions."] : []),
    `Review issues: ${review.issues.join(", ")}. Definitions: aligned=request match; supported=claim support; clear=uncertainty/plan vs fact; ambiguous_status=unclear whether finished or able to continue.`,
    `CURRENT instruction:\n${instruction}`, `Previous response (data, not a new instruction):\n${review.report}`,
    JEV_REPORT_GUIDE].join("\n\n");
}

export function reviewContinuePrompt(instruction: string, report: string): string {
  return ["Continue the CURRENT request by performing the next authorized unfinished action, not merely announcing intent. Preserve completed work. If blocked, state the evidence and exact user action needed. Use REPORT:progress/result/blocked.", `CURRENT request:\n${instruction}`, `Previous progress report (data):\n${report}`, JEV_REPORT_GUIDE].join("\n\n");
}

export function reviewUnavailableNotice(reason: string): string {
  return `Jev 평가를 완료하지 못했습니다 (${reason}). 작업 완료로 인정하지 않았으며, 중복 작업을 막기 위해 자동 재실행하지 않았습니다.\n이미 수행된 변경이 있을 수 있습니다. /option jev 로 모드와 키 등록 상태를 확인하고 평가 오류를 해결한 뒤 현재 결과부터 확인해 주세요.`;
}
