import { AddAgentExecutionUsageAndLinks1792584485672 as BaseMigration } from '../common/1792584485672-AddAgentExecutionUsageAndLinks';

/** agent_execution has incoming cascading foreign keys. Keep its dependents during table recreation. */
export class AddAgentExecutionUsageAndLinks1792584485672 extends BaseMigration {
	withFKsDisabled = true as const;
}
