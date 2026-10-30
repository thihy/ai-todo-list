import { getAutomationScheduler } from './service';
import { installLocalSkill } from '../skills/install';
import type { AutomationInput } from '../../shared/automation-types';

/** Share scheduler semantics with UI; DSH owns tool dispatch and permissions. */
export function assistantToolDefinitions() {
  return [
    { name: 'automation_list', description: 'List real automation definitions and recent runs. Query before editing or removing; never invent IDs.', parameters: {},
      execute: async () => getAutomationScheduler().snapshot() },
    { name: 'automation_save', description: `Create or edit recurring AI work ONLY for an explicit user request. Never invent timing; ask if essential time is missing. System timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Query automation_list before editing. scheduleJson: {"kind":"interval","minutes":60}, {"kind":"calendar","frequency":"daily|weekly|monthly","time":"09:00","day":1} (weekly 0=Sunday, monthly 1..31), or {"kind":"cron","expression":"0 9 * * 1-5"}. Runs only while app is open. Return actual nextRunAt to the user.`,
      parameters: { name: { type: 'string', required: true }, prompt: { type: 'string', required: true }, timezone: { type: 'string', required: true }, scheduleJson: { type: 'string', required: true }, enabled: { type: 'boolean', required: true }, id: { type: 'string' } },
      execute: async (args: { name: string; prompt: string; timezone: string; scheduleJson: string; enabled: boolean; id?: string }) => getAutomationScheduler().save({ name: args.name, prompt: args.prompt, timezone: args.timezone, enabled: args.enabled, schedule: JSON.parse(args.scheduleJson) as AutomationInput['schedule'] }, args.id) },
    { name: 'automation_remove', description: 'Remove automation at the user request. Query automation_list for its real ID first.', parameters: { id: { type: 'string', required: true } },
      execute: async (args: { id: string }) => { getAutomationScheduler().remove(args.id); return { removed: true }; } },
    { name: 'skill_install', description: 'Install a user-requested local Skill folder containing SKILL.md into ~/.agents/skills, without overwriting or executing scripts. source must be a real absolute user-supplied directory, never invented. DSH natively discovers and loads the result.', parameters: { source: { type: 'string', required: true } },
      execute: async (args: { source: string }) => installLocalSkill(args.source) },
  ];
}
