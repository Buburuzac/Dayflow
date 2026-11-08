import type { DayflowApi } from '../../shared/types.ts'

declare global {
  interface Window {
    dayflow: DayflowApi
  }
}
