/**
 * Compatibility wrapper — agent registry behavior now lives in FleetService.
 */
export { FleetService as AgentService } from './fleet.service';
export type { Agent, AgentWithKey } from './fleet.service';
