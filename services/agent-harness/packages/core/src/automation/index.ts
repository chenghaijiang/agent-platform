/** Automation (design doc §10, mechanism 5) — schedule expressions, persistent store, scheduler. */
export {
  parseSchedule,
  nextRunAt,
  nextRunAtFrom,
  describeSchedule,
  ScheduleError,
  type ParsedSchedule,
  type ScheduleErrorCode,
  type ScheduleKind,
} from "./schedule.js";
export {
  AutomationStore,
  AutomationStoreError,
  type AutomationRecord,
  type AutomationStoreErrorCode,
  type AutomationStoreOptions,
} from "./store.js";
export {
  AutomationScheduler,
  AutomationError,
  type AutomationErrorCode,
  type AutomationInput,
  type AutomationRunResult,
  type AutomationSchedulerOptions,
  type AutomationStatus,
  type RuntimeFactory,
} from "./scheduler.js";
