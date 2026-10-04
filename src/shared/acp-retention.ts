/**
 * ACP identifies the program and its model choices, not the connected account's
 * retention agreement. An agent process on this device can still call a hosted
 * model. Never reuse a direct-API policy or infer ZDR from model/agent names.
 */
export interface AcpRetentionNotice {
  label: string
  detail: string
}

export const ACP_RETENTION_NOTICE: Readonly<AcpRetentionNotice> = {
  label: 'ZDR not verified',
  detail:
    'Zero data retention has not been verified for this agent route. The agent’s signed-in account and upstream model provider determine retention and training. Running the agent on this device does not mean its model runs locally. Review the agent’s data policy and account controls before sharing sensitive content.',
}
