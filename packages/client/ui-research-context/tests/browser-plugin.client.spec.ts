import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ResearchContextDetails } from '../src/client/ResearchContextDetails.tsx'
import { apply, inject } from '../src/client/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.context.details': { kind: 'list', scope: 'session' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots }
}

describe('ui-research-context browser apply', () => {
  it('keeps only the on-demand ContextMeter details surface', async () => {
    expect(inject).toEqual(['slots', 'locale'])
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(b.slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(b.slots.entries('conversation.context.details')[0]!.component).toBe(ResearchContextDetails)

    await fiber.dispose()
    expect(b.slots.entries('conversation.context.details')).toHaveLength(0)
  })
})
