import { describe, expect, it } from 'vitest'
import { createOpenAICodexModels } from '../src/codex-account.ts'
import { HarnessPiAiCredentialStore } from '../src/codex-credentials.ts'

describe('OpenAI Codex account models', () => {
  it('registers the OAuth provider before the account Remote starts login', () => {
    const models = createOpenAICodexModels(new HarnessPiAiCredentialStore())

    expect(models.getProvider('openai-codex')?.id).toBe('openai-codex')
    expect(models.getModels('openai-codex').length).toBeGreaterThan(0)
  })
})
