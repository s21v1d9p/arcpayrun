// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, getAddress, pad, toEventSelector, TransactionReceiptNotFoundError } from 'viem'
import {
  assertMatchesReviewedBatch,
  connectWallet,
  loadPayment,
  matchingRun,
  preparePayment,
  prepareSafePayment,
  publicClient,
  sendPayment,
} from './chain'
import { ARC_BATCH_RUNTIME_CODE } from './contractCode'
import { validatePayouts } from './payouts'

const sender = '0x1111111111111111111111111111111111111111' as const
const recipient = '0x2222222222222222222222222222222222222222' as const
const contract = '0x3333333333333333333333333333333333333333' as const
const batch = validatePayouts([{ address: recipient, amount: '1' }])

describe('receipt vs reviewed batch', () => {
  it('accepts only the exact ordered recipient and amount list', () => {
    expect(() =>
      assertMatchesReviewedBatch(
        [{ recipient, amount: 1_000_000_000_000_000_000n, index: 0 }],
        batch,
      ),
    ).not.toThrow()
    expect(() => assertMatchesReviewedBatch([], batch)).toThrow('do not match')
    expect(() =>
      assertMatchesReviewedBatch(
        [{ recipient: sender, amount: 1_000_000_000_000_000_000n, index: 0 }],
        batch,
      ),
    ).toThrow('do not match')
    expect(() =>
      assertMatchesReviewedBatch([{ recipient, amount: 1n, index: 0 }], batch),
    ).toThrow('do not match')
  })

  it('picks the payout that matches the reviewed batch out of several in one transaction', () => {
    const other = [{ recipient: sender, amount: 5n, index: 0 }]
    const ours = [{ recipient, amount: 1_000_000_000_000_000_000n, index: 0 }]
    expect(matchingRun([other, ours], batch)).toEqual(ours)
    expect(() => matchingRun([other], batch)).toThrow('do not match')
  })
})

afterEach(() => {
  delete window.ethereum
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Arc wallet setup', () => {
  it('adds Arc only when the wallet reports it unknown, then switches to chain 5042', async () => {
    const methods: string[] = []
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method }: { method: string }) => {
          methods.push(method)
          if (method === 'eth_requestAccounts') return [sender]
          if (method === 'wallet_switchEthereumChain' && methods.filter((m) => m === method).length === 1) {
            throw Object.assign(new Error('unknown chain'), { code: 4902 })
          }
          if (method === 'wallet_addEthereumChain' || method === 'wallet_switchEthereumChain') return null
          throw new Error(`Unexpected RPC: ${method}`)
        },
      },
    })

    await expect(connectWallet()).resolves.toBe(sender)
    expect(methods).toEqual([
      'eth_requestAccounts',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ])
  })

  it('does not hide a rejected network change', async () => {
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') return [sender]
          throw Object.assign(new Error('User rejected network switch'), { code: 4001 })
        },
      },
    })
    await expect(connectWallet()).rejects.toThrow('User rejected network switch')
  })
})

describe('mainnet payout quote', () => {
  it('floors max gas price at 20 Gwei and reserves enough USDC for payout plus gas', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    vi.spyOn(publicClient, 'getChainId').mockResolvedValue(5042)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    vi.spyOn(publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(2_000_000_000_000_000_000n)

    const quote = await preparePayment(batch, sender)
    expect(quote.maxFeePerGas).toBe(21_000_000_000n)
    expect(quote.maxPriorityFeePerGas).toBe(1_000_000_000n)
    expect(quote.gasLimit).toBe(120_001n)
    expect(quote.maxNetworkFee).toBe(2_520_021_000_000_000n)
  })

  it('rejects mismatched chains, undeployed contracts, and insufficient USDC', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const chainId = vi.spyOn(publicClient, 'getChainId').mockResolvedValue(1)
    await expect(preparePayment(batch, sender)).rejects.toThrow('not connected to Arc mainnet')
    chainId.mockResolvedValue(5042)
    const code = vi.spyOn(publicClient, 'getCode').mockResolvedValue(undefined)
    await expect(preparePayment(batch, sender)).rejects.toThrow('not deployed')
    code.mockResolvedValue('0x6000')
    await expect(preparePayment(batch, sender)).rejects.toThrow('verified payout contract bytecode')
    code.mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    vi.spyOn(publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 0n,
    })
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(1_000_000_000_000_000_000n)
    await expect(preparePayment(batch, sender)).rejects.toThrow('Insufficient Arc USDC')
  })

  it('passes the reviewed recipients, exact value, gas limit, and both fee caps to the wallet', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    vi.spyOn(publicClient, 'getChainId').mockResolvedValue(5042)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    vi.spyOn(publicClient, 'estimateFeesPerGas').mockResolvedValue({
      maxFeePerGas: 21_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(2_000_000_000_000_000_000n)
    vi.spyOn(publicClient, 'waitForTransactionReceipt').mockRejectedValue(
      new Error('Stopped after wallet broadcast'),
    )

    let sent: unknown
    const hash = `0x${'f'.repeat(64)}`
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_accounts') return [sender]
          if (method === 'wallet_switchEthereumChain') return null
          if (method === 'eth_chainId') return '0x13b2'
          if (method === 'eth_sendTransaction') {
            sent = params
            return hash
          }
          throw new Error(`Unexpected wallet RPC: ${method}`)
        },
      },
    })

    const onSubmitted = vi.fn()
    const quote = await preparePayment(batch, sender)
    await expect(sendPayment(batch, quote, onSubmitted)).rejects.toThrow(
      'Stopped after wallet broadcast',
    )
    expect(onSubmitted).toHaveBeenCalledWith(hash)
    expect(sent).toEqual([
      expect.objectContaining({
        from: sender,
        to: contract,
        value: '0xde0b6b3a7640000',
        gas: '0x1d4c1',
        maxFeePerGas: '0x4e3b29200',
        maxPriorityFeePerGas: '0x3b9aca00',
      }),
    ])
  })
})

describe('Safe payout quote', () => {
  const safe = '0x4444444444444444444444444444444444444444' as const

  it('dry-runs the payout from the Safe and only needs the Safe to hold the total', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    vi.spyOn(publicClient, 'getChainId').mockResolvedValue(5042)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(1_000_000_000_000_000_000n)
    const dryRun = vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)

    await expect(prepareSafePayment(batch, safe)).resolves.toEqual({
      account: safe,
      contract,
      balance: 1_000_000_000_000_000_000n,
    })
    expect(dryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        account: safe,
        address: contract,
        functionName: 'pay',
        args: [[recipient], [1_000_000_000_000_000_000n]],
        value: 1_000_000_000_000_000_000n,
      }),
    )
  })

  it('rejects a wrong chain, unverified code and a Safe that cannot cover the total', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const chainId = vi.spyOn(publicClient, 'getChainId').mockResolvedValue(1)
    await expect(prepareSafePayment(batch, safe)).rejects.toThrow('not connected to Arc mainnet')
    chainId.mockResolvedValue(5042)
    const code = vi.spyOn(publicClient, 'getCode').mockResolvedValue('0x6000')
    await expect(prepareSafePayment(batch, safe)).rejects.toThrow('verified payout contract bytecode')
    code.mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getBalance').mockResolvedValue(999_999_999_999_999_999n)
    const dryRun = vi.spyOn(publicClient, 'estimateContractGas').mockResolvedValue(100_000n)
    await expect(prepareSafePayment(batch, safe)).rejects.toThrow(
      'Insufficient Arc USDC in the Safe: need 1 USDC, Safe has 0.999999999999999999 USDC',
    )
    expect(dryRun).not.toHaveBeenCalled()
  })
})

describe('shared receipt verification', () => {
  it('refuses receipts from a configured address that is not the verified payout contract', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'e'.repeat(64)}` as const
    vi.spyOn(publicClient, 'getTransaction').mockResolvedValue({ to: contract, from: sender } as never)
    const code = vi.spyOn(publicClient, 'getCode').mockResolvedValue('0x6000')
    const receipt = vi
      .spyOn(publicClient, 'getTransactionReceipt')
      .mockResolvedValue({ status: 'success', logs: [], blockNumber: 1n } as never)

    await expect(loadPayment(hash)).rejects.toThrow('verified payout contract bytecode')
    expect(receipt).not.toHaveBeenCalled()
    code.mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    await expect(loadPayment(hash)).rejects.toThrow('No payout events')
  })

  it('accepts a payout executed through a Safe and reports who executed it', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'c'.repeat(64)}` as const
    const safe = '0x4444444444444444444444444444444444444444' as const
    const owner = '0x5555555555555555555555555555555555555555' as const
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getTransactionReceipt').mockResolvedValue({
      status: 'success',
      blockNumber: 9n,
      from: owner,
      to: safe,
      logs: [
        {
          address: contract,
          topics: [
            toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)'),
            pad(safe),
            pad(recipient),
          ],
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 0n]),
        },
      ],
    } as never)

    const result = await loadPayment(hash)
    expect(result.sender).toBe(safe)
    expect(result.executor).toBe(owner)
    expect(result.payments).toEqual([{ recipient, amount: 1n, index: 0 }])
    expect(result.runs).toEqual([[{ recipient, amount: 1n, index: 0 }]])
    expect(result.blockNumber).toBe(9n)
  })

  it('keeps a shared receipt verifiable when a recipient contract pays others from inside the payout', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'b'.repeat(64)}` as const
    const reenterer = '0x5555555555555555555555555555555555555555' as const
    const paidTopic = toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)')
    const log = (from: `0x${string}`, index: bigint) => ({
      address: contract,
      topics: [paidTopic, pad(from), pad(recipient)],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, index]),
    })
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getTransactionReceipt').mockResolvedValue({
      status: 'success',
      blockNumber: 3n,
      from: sender,
      to: contract,
      logs: [log(sender, 0n), log(reenterer, 0n), log(sender, 1n)],
    } as never)

    const result = await loadPayment(hash)
    expect(result.sender).toBe(sender)
    expect(result.executor).toBeNull()
    expect(result.payments).toEqual([
      { recipient, amount: 7n, index: 0 },
      { recipient, amount: 7n, index: 1 },
    ])
  })

  it('verifies the payer named in a share link when a transaction holds payouts from several senders', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'a'.repeat(64)}` as const
    const safe = '0x4444444444444444444444444444444444444444' as const
    const wrapper = '0x5555555555555555555555555555555555555555' as const
    const paidTopic = toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)')
    const log = (from: `0x${string}`, amount: bigint) => ({
      address: contract,
      topics: [paidTopic, pad(from), pad(recipient)],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, 0n]),
    })
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getTransactionReceipt').mockResolvedValue({
      status: 'success',
      blockNumber: 4n,
      from: sender,
      to: wrapper,
      logs: [log(safe, 500n), log(wrapper, 1n)],
    } as never)

    await expect(loadPayment(hash)).rejects.toThrow('more than one sender')
    const result = await loadPayment(hash, safe)
    expect(result.sender).toBe(safe)
    expect(result.payments).toEqual([{ recipient, amount: 500n, index: 0 }])
  })

  it('returns a checksummed sender for shareable receipts', async () => {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    const hash = `0x${'d'.repeat(64)}` as const
    const lowercaseSender = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getTransactionReceipt').mockResolvedValue({
      status: 'success',
      blockNumber: 1n,
      from: lowercaseSender,
      to: contract,
      logs: [
        {
          address: contract,
          topics: [
            toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)'),
            pad(lowercaseSender),
            pad(recipient),
          ],
          data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 0n]),
        },
      ],
    } as never)

    const result = await loadPayment(hash)
    expect(result.sender).toBe(getAddress(lowercaseSender))
    expect(result.executor).toBeNull()
  })
})

describe('receipts that Arc RPC does not find by hash', () => {
  const hash = `0x${'f'.repeat(64)}` as const
  const otherHash = `0x${'1'.repeat(64)}` as const
  const blockHash = `0x${'9'.repeat(64)}` as const
  const rpcReceipt = (transactionHash: `0x${string}`) => ({
    transactionHash,
    blockHash,
    blockNumber: '0x171774e',
    transactionIndex: '0x0',
    from: sender,
    to: contract,
    status: '0x1',
    type: '0x2',
    gasUsed: '0x1',
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logsBloom: '0x',
    logs: [
      {
        address: contract,
        topics: [
          toEventSelector('event Paid(address indexed sender, address indexed recipient, uint256 amount, uint256 index)'),
          pad(sender),
          pad(recipient),
        ],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 0n]),
        blockHash,
        blockNumber: '0x171774e',
        logIndex: '0x0',
        transactionHash,
        transactionIndex: '0x0',
        removed: false,
      },
    ],
  })

  function lookupMissesHash(blockReceipts: unknown[]) {
    vi.stubEnv('VITE_ARC_BATCH_ADDRESS', contract)
    vi.spyOn(publicClient, 'getCode').mockResolvedValue(ARC_BATCH_RUNTIME_CODE)
    vi.spyOn(publicClient, 'getTransactionReceipt').mockRejectedValue(new TransactionReceiptNotFoundError({ hash }))
    return vi.spyOn(publicClient, 'request').mockImplementation((async ({ method }: { method: string }) => {
      if (method === 'eth_getBlockReceipts') return blockReceipts
      throw new Error(`Unexpected RPC: ${method}`)
    }) as never)
  }

  it('reads the receipt from the block named in the link and checks it as usual', async () => {
    const request = lookupMissesHash([rpcReceipt(otherHash), rpcReceipt(hash)])
    const explorer = vi.fn()
    vi.stubGlobal('fetch', explorer)

    const result = await loadPayment(hash, undefined, 24213326n)
    expect(request).toHaveBeenCalledWith({ method: 'eth_getBlockReceipts', params: ['0x171774e'] })
    expect(explorer).not.toHaveBeenCalled()
    expect(result.sender).toBe(sender)
    expect(result.executor).toBeNull()
    expect(result.payments).toEqual([{ recipient, amount: 10n, index: 0 }])
    expect(result.blockNumber).toBe(24213326n)
  })

  it('asks Arc Explorer only for the block number when the link has none', async () => {
    lookupMissesHash([rpcReceipt(hash)])
    const explorer = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ block_number: 24213326 }) })
    vi.stubGlobal('fetch', explorer)

    const result = await loadPayment(hash)
    expect(explorer).toHaveBeenCalledWith(`https://explorer.arc.io/api/v2/transactions/${hash}`)
    expect(result.payments).toEqual([{ recipient, amount: 10n, index: 0 }])
  })

  it('does not accept a block that does not hold the transaction', async () => {
    const request = lookupMissesHash([rpcReceipt(otherHash)])
    await expect(loadPayment(hash, undefined, 24213326n)).rejects.toThrow(/block 24213326 on arc does not contain this transaction/i)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ block_number: 24213326 }) }))
    await expect(loadPayment(hash)).rejects.toThrow(/block 24213326 on arc does not contain this transaction/i)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps the plain not-found error when Arc Explorer has no block for the transaction', async () => {
    const request = lookupMissesHash([rpcReceipt(hash)])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ message: 'Not found' }) }))
    await expect(loadPayment(hash)).rejects.toBeInstanceOf(TransactionReceiptNotFoundError)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ block_number: null }) }))
    await expect(loadPayment(hash)).rejects.toBeInstanceOf(TransactionReceiptNotFoundError)
    expect(request).not.toHaveBeenCalled()
  })

  it('says the transaction may be pending or older when Arc Explorer cannot be reached', async () => {
    const request = lookupMissesHash([])
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const failure = loadPayment(hash)
    await expect(failure).rejects.toThrow(/may still be pending/i)
    await expect(failure).rejects.toThrow(/does not always find older transactions by hash/i)
    expect(request).not.toHaveBeenCalled()
  })
})
