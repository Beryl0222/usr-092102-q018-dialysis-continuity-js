/** 领域错误：携带稳定 code 与建议 HTTP 状态，便于接口层映射。 */
export class DomainError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const ErrorCodes = Object.freeze({
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PLAN_NOT_FOUND: "PLAN_NOT_FOUND",
  PRESCRIPTION_LOCKED: "PRESCRIPTION_LOCKED",
  RESOURCE_SHORTFALL: "RESOURCE_SHORTFALL",
  SESSION_STATE: "SESSION_STATE",
  UNREACHABLE_ALTERNATIVE: "UNREACHABLE_ALTERNATIVE",
  HANDOFF_STATE: "HANDOFF_STATE",
  MINIMAL_RECORD_INCOMPLETE: "MINIMAL_RECORD_INCOMPLETE",
  OCCURRENCE_NOT_FOUND: "OCCURRENCE_NOT_FOUND",
  RECONCILIATION_REJECTED: "RECONCILIATION_REJECTED",
  SETTLEMENT_ERROR: "SETTLEMENT_ERROR",
  VERSION_CONFLICT: "VERSION_CONFLICT",
});
