import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-research-context'
import { ResearchContextDetails } from './ResearchContextDetails.tsx'
import { en, zh, type ResearchContextLocaleKey } from './locales.ts'

export { ResearchContextDetails } from './ResearchContextDetails.tsx'

/** Legacy component contract retained for source compatibility; no dock is registered. */
export interface ResearchCommandInjected {
  runResearchCommand: (line: string) => Promise<string | null>
}

/** Legacy board contract retained for source compatibility; no sidebar launcher is registered. */
export interface RootResearchCommandInjected {
  runResearchCommand: (sessionId: SessionId, line: string) => Promise<string | null>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Research-context assembly labels. */
    'research-context': ResearchContextLocaleKey
  }
}

export const inject = ['slots', 'locale']

/** Register the research assembly section in the existing ContextMeter detail slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('research-context', { zh, en }), 'ui-research-context: dictionaries')
  ctx.slots.inject('conversation.context.details', () => ctx.slots.register({
    name: 'conversation.context.details',
    id: 'research-context',
    order: 10,
    locale: 'research-context',
  }, ResearchContextDetails))
}
