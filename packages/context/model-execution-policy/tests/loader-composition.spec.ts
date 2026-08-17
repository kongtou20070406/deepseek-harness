/** Real Loader proof for the shipped function-plugin YAML row. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ExecutionPolicy from '@deepseek-ai/dsh-model-execution-policy'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-model-policy-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '  config:',
    '    persona: You are {{model}}.',
    '- id: model-execution-policy',
    "  name: '@deepseek-ai/dsh-model-execution-policy'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-model-execution-policy', ExecutionPolicy],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('model execution policy real composition', () => {
  it('loads the shipped zero-config row into the shared prompt', async () => {
    const ctx = await loadComposition()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: 'model:execution-policy',
      text: expect.stringContaining('Once the user resolves an ambiguity, do not ask it again.'),
    }))
    expect('default' in ExecutionPolicy).toBe(false)
  })
})
