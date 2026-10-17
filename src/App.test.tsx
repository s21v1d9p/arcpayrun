// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as chain from './lib/chain'
import { validatePayouts } from './lib/payouts'
import { RevertedPaymentError } from './lib/receipts'
import * as safeApp from './lib/safe'
import App from './App'

const alice = '0x1111111111111111111111111111111111111111'
const bob = '0x2222222222222222222222222222222222222222' as const
const safeAddress = '0x4444444444444444444444444444444444444444' as const
const owner = '0x5555555555555555555555555555555555555555' as const
const payoutContract = '0x3333333333333333333333333333333333333333' as const

function safeSession(overrides: Partial<safeApp.SafeSession> = {}): safeApp.SafeSession {
  return {
    sdk: { safe: { getInfo: vi.fn() }, txs: { send: vi.fn(), getBySafeTxHash: vi.fn() } },
    address: safeAddress,
    chainId: 5042,
    threshold: 1,
    readOnly: false,
    ...overrides,
  }
}

function useSafe(session: safeApp.SafeSession) {
  vi.spyOn(safeApp, 'detectSafe').mockResolvedValue(session)
  vi.spyOn(chain, 'configuredContract').mockReturnValue(payoutContract)
  vi.spyOn(chain, 'prepareSafePayment').mockResolvedValue({
    account: safeAddress,
    contract: payoutContract,
    balance: 2_000_000_000_000_000_000n,
  })
}

function enterBobForOne() {
  fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), { target: { value: bob } })
  fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), { target: { value: '1' } })
}

const safeReceipt = (hash: `0x${string}`) => ({
  hash,
  sender: safeAddress,
  executor: owner,
  payments: [{ recipient: bob, amount: 1_000_000_000_000_000_000n, index: 0 }],
  runs: [[{ recipient: bob, amount: 1_000_000_000_000_000_000n, index: 0 }]],
  blockNumber: 12n,
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
})

describe('Arc Payrun interface', () => {
  it('shows exact CSV payout preview while keeping signing unavailable without deployment', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByRole('heading', { name: /batch payouts in usdc/i })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /paste csv/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /payout csv/i }), {
      target: { value: `address,amount\n${alice},1.25\n${bob},0.000001` },
    })
    expect(screen.getByText(/2 recipients/i)).toBeTruthy()
    expect(screen.getByText('1.250001')).toBeTruthy()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByText(/contract address is not configured/i)).toBeTruthy()
    expect(screen.getByText(/addresses and amounts become public/i)).toBeTruthy()
  })

  it('shows row errors and does not allow signing an invalid batch', () => {
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), {
      target: { value: alice },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), {
      target: { value: '0.0000001' },
    })
    expect(screen.getByText(/row 1: amount must be positive/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('reports missing browser wallet instead of pretending to connect', async () => {
    render(<App />)
    await userEvent.setup().click(screen.getByRole('button', { name: /connect wallet/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/No browser wallet detected/i)
  })

  it('rejects an invalid share link before any RPC lookup', () => {
    window.history.replaceState(null, '', '/?tx=not-a-hash')
    render(<App />)
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid transaction hash/i)
  })

  it('does not allow duplicate signing after a submitted transaction times out', async () => {
    const contract = '0x3333333333333333333333333333333333333333' as const
    const address = '0x1111111111111111111111111111111111111111' as const
    const hash = `0x${'a'.repeat(64)}` as const
    vi.spyOn(chain, 'configuredContract').mockReturnValue(contract)
    vi.spyOn(chain, 'connectWallet').mockResolvedValue(address)
    vi.spyOn(chain, 'preparePayment').mockResolvedValue({
      account: address,
      contract,
      balance: 3_000_000_000_000_000_000n,
      gasLimit: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
      maxNetworkFee: 2_000_000_000_000_000n,
    })
    vi.spyOn(chain, 'sendPayment').mockImplementation(async (_batch, _quote, onSubmitted) => {
      onSubmitted(hash)
      throw new Error('Timed out waiting for confirmation')
    })

    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), {
      target: { value: alice },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), {
      target: { value: '1' },
    })
    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /confirm & pay/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not verified yet/i))
    expect(screen.queryByRole('button', { name: /confirm & pay/i })).toBeNull()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByRole('button', { name: /retry receipt/i })).toBeTruthy()
    vi.spyOn(chain, 'loadPayment').mockResolvedValue({
      hash,
      sender: address,
      executor: null,
      payments: [{ recipient: bob, amount: 1_000_000_000_000_000_000n, index: 0 }],
      runs: [[{ recipient: bob, amount: 1_000_000_000_000_000_000n, index: 0 }]],
      blockNumber: 1n,
    })
    await user.click(screen.getByRole('button', { name: /retry receipt/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/do not match the reviewed batch/i))
    expect(screen.queryByText(/All payments confirmed/i)).toBeNull()
  })

  it('allows a fresh batch only after a transaction is confirmed reverted', async () => {
    const hash = `0x${'b'.repeat(64)}`
    window.history.replaceState(null, '', `/?tx=${hash}`)
    vi.spyOn(chain, 'loadPayment').mockRejectedValue(new RevertedPaymentError())
    render(<App />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reverted/i))
    expect(screen.getByText(/Transaction failed\. No payouts were sent\./i)).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: /start new batch/i }))
    expect(window.location.search).toBe('')
  })

  it('does not suggest retrying receipt when the submitted batch reverted', async () => {
    const contract = '0x3333333333333333333333333333333333333333' as const
    const address = '0x1111111111111111111111111111111111111111' as const
    const hash = `0x${'c'.repeat(64)}` as const
    vi.spyOn(chain, 'configuredContract').mockReturnValue(contract)
    vi.spyOn(chain, 'connectWallet').mockResolvedValue(address)
    vi.spyOn(chain, 'preparePayment').mockResolvedValue({
      account: address,
      contract,
      balance: 3_000_000_000_000_000_000n,
      gasLimit: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
      maxNetworkFee: 2_000_000_000_000_000n,
    })
    vi.spyOn(chain, 'sendPayment').mockImplementation(async (_batch, _quote, onSubmitted) => {
      onSubmitted(hash)
      throw new RevertedPaymentError()
    })
    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: /recipient address 1/i }), {
      target: { value: alice },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /amount in usdc 1/i }), {
      target: { value: '1' },
    })
    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /confirm & pay/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reverted/i))
    expect(screen.getByRole('alert').textContent).not.toMatch(/retry receipt/i)
    expect(screen.getByRole('button', { name: /start new batch/i })).toBeTruthy()
  })

  it('shows a confirmed receipt from a share link with correct singular wording', async () => {
    const hash = `0x${'d'.repeat(64)}` as const
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    window.history.replaceState(null, '', `/?tx=${hash}`)
    vi.spyOn(chain, 'loadPayment').mockResolvedValue({
      hash,
      sender: '0x1111111111111111111111111111111111111111',
      executor: null,
      payments: [{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }],
      runs: [[{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }]],
      blockNumber: 42n,
    })
    render(<App />)

    expect(await screen.findByRole('heading', { name: /all payments confirmed/i })).toBeTruthy()
    expect(screen.getByText(/confirmed on arc mainnet, block 42/i)).toBeTruthy()
    expect(screen.getByText(/paid 1 recipient in one transaction/i)).toBeTruthy()
    expect(screen.getByText('1. 0x2222...2222')).toBeTruthy()
    expect(screen.getByText('0.01 USDC')).toBeTruthy()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('verifies the payer named in a receipt link, and rejects a malformed one', async () => {
    const hash = `0x${'e'.repeat(64)}` as const
    window.history.replaceState(null, '', `/?tx=${hash}&payer=${safeAddress}`)
    const load = vi.spyOn(chain, 'loadPayment').mockResolvedValue({
      hash,
      sender: safeAddress,
      executor: owner,
      payments: [{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }],
      runs: [[{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }]],
      blockNumber: 5n,
    })
    render(<App />)
    expect(await screen.findByRole('heading', { name: /all payments confirmed/i })).toBeTruthy()
    expect(load).toHaveBeenCalledWith(hash, safeAddress, undefined)
    cleanup()

    window.history.replaceState(null, '', `/?tx=${hash}&payer=nope`)
    render(<App />)
    expect(screen.getByRole('alert').textContent).toMatch(/invalid payer/i)
  })

  it('uses the block in a receipt link and keeps it in the copied link', async () => {
    const hash = `0x${'d'.repeat(64)}` as const
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    window.history.replaceState(null, '', `/?tx=${hash}&block=42`)
    const load = vi.spyOn(chain, 'loadPayment').mockResolvedValue({
      hash,
      sender: alice,
      executor: null,
      payments: [{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }],
      runs: [[{ recipient: bob, amount: 10_000_000_000_000_000n, index: 0 }]],
      blockNumber: 42n,
    })
    render(<App />)

    expect(await screen.findByRole('heading', { name: /all payments confirmed/i })).toBeTruthy()
    expect(load).toHaveBeenCalledWith(hash, undefined, 42n)
    fireEvent.click(screen.getByRole('button', { name: /copy receipt link/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?tx=${hash}&block=42`))
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('rejects a malformed block number in a receipt link before any lookup', () => {
    window.history.replaceState(null, '', `/?tx=0x${'d'.repeat(64)}&block=12abc`)
    const load = vi.spyOn(chain, 'loadPayment')
    render(<App />)
    expect(screen.getByRole('alert').textContent).toMatch(/invalid block number/i)
    expect(load).not.toHaveBeenCalled()
  })

  it('does not carry the payer or block from a receipt link over to a new payout', async () => {
    const linked = `0x${'c'.repeat(64)}` as const
    const sent = `0x${'a'.repeat(64)}` as const
    window.history.replaceState(null, '', `/?tx=${linked}&payer=${safeAddress}&block=42`)
    vi.spyOn(chain, 'configuredContract').mockReturnValue(payoutContract)
    vi.spyOn(chain, 'connectWallet').mockResolvedValue(alice)
    vi.spyOn(chain, 'preparePayment').mockResolvedValue({
      account: alice,
      contract: payoutContract,
      balance: 3_000_000_000_000_000_000n,
      gasLimit: 100_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
      maxNetworkFee: 2_000_000_000_000_000n,
    })
    vi.spyOn(chain, 'sendPayment').mockImplementation(async (_batch, _quote, onSubmitted) => {
      onSubmitted(sent)
      throw new Error('Timed out waiting for confirmation')
    })
    const load = vi.spyOn(chain, 'loadPayment').mockResolvedValue(safeReceipt(linked))

    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /start new batch/i }))
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /confirm & pay/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not verified yet/i))

    await user.click(screen.getByRole('button', { name: /retry receipt/i }))
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(sent, undefined, undefined))
  })

  it('states plainly where recipient data goes', () => {
    render(<App />)
    expect(screen.getByRole('link', { name: /arc payrun home/i })).toBeTruthy()
    expect(screen.getByText(/sent through this site's RPC proxy to Arc for the gas estimate/i)).toBeTruthy()
    expect(screen.getByText(/pays each recipient in the same transaction/i)).toBeTruthy()
    expect(screen.queryByText(/never leaves your browser|nothing is uploaded|without trusting/i)).toBeNull()
  })
})

describe('Arc Payrun inside a Safe', () => {
  it('pays from the Safe: proposes once, then shows the receipt with the owner who executed it', async () => {
    const hash = `0x${'9'.repeat(64)}` as const
    useSafe(safeSession())
    const walletQuote = vi.spyOn(chain, 'preparePayment')
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe')
    const complete = vi
      .spyOn(safeApp, 'completeSafePayment')
      .mockImplementation(async (_session, _batch, _contract, _safeTxHash, { onProgress, onExecuted }) => {
        onProgress('awaiting-execution')
        onExecuted(hash)
        return safeReceipt(hash)
      })
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('button', { name: /safe 0x4444\.\.\.4444/i })).toBeTruthy()
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    expect(screen.getByText(/safe balance/i)).toBeTruthy()
    expect(screen.getByText(/paid by the owner who executes it/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))

    expect(await screen.findByRole('heading', { name: /all payments confirmed/i })).toBeTruthy()
    expect(screen.getByText(/executed by 0x5555\.\.\.5555/i)).toBeTruthy()
    expect(propose).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ address: safeAddress }),
      expect.objectContaining({ total: 1_000_000_000_000_000_000n }),
      payoutContract,
      '0x5afe',
      expect.anything(),
    )
    expect(walletQuote).not.toHaveBeenCalled()
    expect(window.location.search).toBe(`?tx=${hash}&payer=${safeAddress}`)
  })

  it('never proposes the same payout twice while the Safe owners have not executed it', async () => {
    const hash = `0x${'8'.repeat(64)}` as const
    useSafe(safeSession({ threshold: 2 }))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe')
    const complete = vi
      .spyOn(safeApp, 'completeSafePayment')
      .mockRejectedValueOnce(new safeApp.SafePendingError())
      .mockResolvedValueOnce(safeReceipt(hash))
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('button', { name: /safe 0x4444\.\.\.4444/i })
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))

    expect(await screen.findByRole('heading', { name: /waiting for the safe owners/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /propose in safe/i })).toBeNull()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByRole('button', { name: /check again/i }))

    expect(await screen.findByRole('heading', { name: /all payments confirmed/i })).toBeTruthy()
    expect(propose).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1][3]).toBe('0x5afe')
  })

  it('refuses a Safe on another network', async () => {
    useSafe(safeSession({ chainId: 1 }))
    render(<App />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/not on Arc mainnet/i)
    enterBobForOne()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(true)
  })

  it('clears a cancelled Safe payout so it can be fixed and proposed again', async () => {
    useSafe(safeSession())
    vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe')
    vi.spyOn(safeApp, 'completeSafePayment').mockRejectedValue(new safeApp.SafeCancelledError())
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('button', { name: /safe 0x4444\.\.\.4444/i })
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/i)
    expect(screen.queryByRole('heading', { name: /waiting for the safe owners/i })).toBeNull()
    expect(screen.getByRole('button', { name: /review batch/i }).hasAttribute('disabled')).toBe(false)
    expect(safeApp.pendingPayoutsFor(safeAddress)).toEqual([])
  })

  it('remembers a payout still waiting in the Safe after a reload and refuses to propose it again', async () => {
    const waiting = safeSession({ threshold: 2 })
    waiting.sdk.txs.getBySafeTxHash = vi.fn(async () => ({ txStatus: 'AWAITING_CONFIRMATIONS' }))
    useSafe(waiting)
    safeApp.rememberPendingPayout(safeAddress, '0x5afe', validatePayouts([{ address: bob, amount: '1' }]))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe2')
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('heading', { name: /waiting for the safe owners/i })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /start a different payout/i }))
    expect(screen.queryByRole('heading', { name: /waiting for the safe owners/i })).toBeNull()
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/already waiting in your Safe/i)
    expect(propose).not.toHaveBeenCalled()
  })

  it('lets the saver forget a restored proposal that no longer exists in the Safe', async () => {
    const waiting = safeSession({ threshold: 2 })
    waiting.sdk.txs.getBySafeTxHash = vi.fn(async () => ({ txStatus: 'AWAITING_CONFIRMATIONS' }))
    useSafe(waiting)
    safeApp.rememberPendingPayout(safeAddress, '0x5afe', validatePayouts([{ address: bob, amount: '1' }]))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe2')
    vi.spyOn(safeApp, 'completeSafePayment').mockRejectedValue(new safeApp.SafePendingError())
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: /waiting for the safe owners/i })
    await user.click(screen.getByRole('button', { name: /forget this proposal/i }))
    expect(safeApp.pendingPayoutsFor(safeAddress)).toEqual([])
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1))
  })

  it('checks with the Safe again before refusing a payout it remembers', async () => {
    const session = safeSession({ threshold: 2 })
    const lookup = vi.fn(async () => ({ txStatus: 'AWAITING_CONFIRMATIONS' } as { txStatus: string; txHash?: string }))
    session.sdk.txs.getBySafeTxHash = lookup
    useSafe(session)
    safeApp.rememberPendingPayout(safeAddress, '0x5afe', validatePayouts([{ address: bob, amount: '1' }]))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe2')
    vi.spyOn(safeApp, 'completeSafePayment').mockRejectedValue(new safeApp.SafePendingError())
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: /waiting for the safe owners/i })
    await user.click(screen.getByRole('button', { name: /start a different payout/i }))
    lookup.mockResolvedValue({ txStatus: 'SUCCESS', txHash: `0x${'7'.repeat(64)}` })
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1))
  })

  it('refuses when Safe cannot confirm whether a remembered identical payout is still waiting', async () => {
    const session = safeSession({ threshold: 2 })
    const lookup = vi.fn(async () => ({ txStatus: 'AWAITING_CONFIRMATIONS' } as { txStatus: string; txHash?: string }))
    session.sdk.txs.getBySafeTxHash = lookup
    useSafe(session)
    safeApp.rememberPendingPayout(safeAddress, '0x5afe', validatePayouts([{ address: bob, amount: '1' }]))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe2')
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('heading', { name: /waiting for the safe owners/i })
    await user.click(screen.getByRole('button', { name: /start a different payout/i }))
    lookup.mockRejectedValue(new Error('503'))
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    await user.click(screen.getByRole('button', { name: /propose in safe/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not confirm/i)
    expect(propose).not.toHaveBeenCalled()
    expect(safeApp.pendingPayoutsFor(safeAddress)).toHaveLength(1)
  })

  it('ignores a second click while it is still checking with Safe', async () => {
    const session = safeSession({ threshold: 2 })
    const waiting: Array<(value: { txStatus: string }) => void> = []
    const answer = (value: { txStatus: string }) => waiting.splice(0).forEach((resolve) => resolve(value))
    session.sdk.txs.getBySafeTxHash = vi.fn(() => new Promise<{ txStatus: string }>((resolve) => { waiting.push(resolve) }))
    useSafe(session)
    safeApp.rememberPendingPayout(safeAddress, '0xother', validatePayouts([{ address: alice, amount: '2' }]))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment').mockResolvedValue('0x5afe2')
    vi.spyOn(safeApp, 'completeSafePayment').mockRejectedValue(new safeApp.SafePendingError())
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('button', { name: /safe 0x4444\.\.\.4444/i })
    answer({ txStatus: 'AWAITING_CONFIRMATIONS' })
    await screen.findByRole('heading', { name: /waiting for the safe owners/i })
    await user.click(screen.getByRole('button', { name: /start a different payout/i }))
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    const button = screen.getByRole('button', { name: /propose in safe/i })
    await user.click(button)
    await user.click(button)
    answer({ txStatus: 'AWAITING_CONFIRMATIONS' })
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1))
  })

  it('lets a read-only Safe review a payout but not propose it', async () => {
    useSafe(safeSession({ readOnly: true }))
    const propose = vi.spyOn(safeApp, 'proposeSafePayment')
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('button', { name: /safe 0x4444\.\.\.4444/i })
    expect(screen.getByText(/opened this Safe read-only/i)).toBeTruthy()
    enterBobForOne()
    await user.click(screen.getByRole('button', { name: /review batch/i }))
    expect(screen.getByRole('button', { name: /propose in safe/i }).hasAttribute('disabled')).toBe(true)
    expect(propose).not.toHaveBeenCalled()
  })
})
