import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ mocked: true })))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { spawnDialogWorker } from '../src/win32-dialog-host.ts'

describe('win32 dialog host', () => {
  beforeEach(() => { spawnMock.mockClear() })

  it('keeps the worker GUI visible so IFileOpenDialog can be selected', () => {
    spawnDialogWorker({ title: 'Select Workspace Directory' })

    const options = spawnMock.mock.calls[0]?.[2]
    expect(options).toMatchObject({
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: expect.objectContaining({ DSH_DIALOG_TITLE: 'Select Workspace Directory' }),
    })
    expect(options).not.toHaveProperty('windowsHide')
  })
})
