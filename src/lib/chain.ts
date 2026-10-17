import {
  createPublicClient,
  createWalletClient,
  custom,
  formatTransactionReceipt,
  formatUnits,
  getAddress,
  isAddress,
  numberToHex,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from 'viem'
import type { Address, Hash, TransactionReceipt } from 'viem'
import type { Batch } from './payouts'
import { batchAbi, parsePaidReceipt, parsePaidRuns, payerOf } from './receipts'
import type { ConfirmedPayment } from './receipts'
import { ARC_BATCH_RUNTIME_CODE } from './contractCode'
import { arcFeeCaps } from './fees'
import { arcMainnet } from './networks'
import { arcMainnetTransport } from './rpc'
import { connectToChain, injectedWallet, selectChain } from './wallet'

export { arcMainnet }

export const publicClient = createPublicClient({ chain: arcMainnet, transport: arcMainnetTransport() })

export type Quote = {
  account: Address
  contract: Address
  balance: bigint
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  maxNetworkFee: bigint
}

export type SafeQuote = {
  account: Address
  contract: Address
  balance: bigint
}

export function payArgs(batch: Batch) {
  return [
    batch.payouts.map((payout) => payout.address),
    batch.payouts.map((payout) => payout.units),
  ] as const
}

function matchesReviewedBatch(payments: readonly ConfirmedPayment[], batch: Batch): boolean {
  return (
    payments.length === batch.payouts.length &&
    payments.every(
      (payment, index) =>
        payment.index === index &&
        payment.recipient.toLowerCase() === batch.payouts[index].address.toLowerCase() &&
        payment.amount === batch.payouts[index].units,
    )
  )
}

export function assertMatchesReviewedBatch(payments: readonly ConfirmedPayment[], batch: Batch): void {
  if (!matchesReviewedBatch(payments, batch)) {
    throw new Error('Confirmed payment events do not match the reviewed batch')
  }
}

export function matchingRun(runs: readonly (readonly ConfirmedPayment[])[], batch: Batch): ConfirmedPayment[] {
  const run = runs.find((candidate) => matchesReviewedBatch(candidate, batch))
  if (!run) throw new Error('Confirmed payment events do not match the reviewed batch')
  return [...run]
}

export function configuredContract(): Address {
  const address = import.meta.env.VITE_ARC_BATCH_ADDRESS
  if (!address || !isAddress(address) || address.toLowerCase() === zeroAddress) {
    throw new Error('Arc mainnet contract address is not configured yet')
  }
  return getAddress(address)
}

export async function connectWallet(): Promise<Address> {
  return connectToChain(arcMainnet)
}

async function assertPayoutContract(address: Address): Promise<void> {
  const code = await publicClient.getCode({ address })
  if (!code || code === '0x') throw new Error('Configured contract is not deployed on Arc mainnet')
  if (code.toLowerCase() !== ARC_BATCH_RUNTIME_CODE.toLowerCase()) {
    throw new Error('Configured contract does not match the verified payout contract bytecode')
  }
}

async function checkedContract(): Promise<Address> {
  const contract = configuredContract()
  if ((await publicClient.getChainId()) !== arcMainnet.id) {
    throw new Error('RPC is not connected to Arc mainnet')
  }
  await assertPayoutContract(contract)
  return contract
}

export async function preparePayment(batch: Batch, account: Address): Promise<Quote> {
  const contract = await checkedContract()
  const gasEstimate = await publicClient.estimateContractGas({
    account,
    address: contract,
    abi: batchAbi,
    functionName: 'pay',
    args: payArgs(batch),
    value: batch.total,
  })
  const gasLimit = (gasEstimate * 120n) / 100n + 1n
  const { maxFeePerGas, maxPriorityFeePerGas } = arcFeeCaps(
    await publicClient.estimateFeesPerGas({ type: 'eip1559' }),
  )
  const maxNetworkFee = gasLimit * maxFeePerGas
  const balance = await publicClient.getBalance({ address: account })
  if (balance < batch.total + maxNetworkFee) {
    throw new Error(
      `Insufficient Arc USDC: need up to ${formatUnits(batch.total + maxNetworkFee, 18)} USDC including gas, wallet has ${formatUnits(balance, 18)} USDC`,
    )
  }
  return { account, contract, balance, gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNetworkFee }
}

// The Safe owner who executes the transaction pays the gas, so the Safe only needs the total.
export async function prepareSafePayment(batch: Batch, safe: Address): Promise<SafeQuote> {
  const contract = await checkedContract()
  const balance = await publicClient.getBalance({ address: safe })
  if (balance < batch.total) {
    throw new Error(
      `Insufficient Arc USDC in the Safe: need ${formatUnits(batch.total, 18)} USDC, Safe has ${formatUnits(balance, 18)} USDC`,
    )
  }
  await publicClient.estimateContractGas({
    account: safe,
    address: contract,
    abi: batchAbi,
    functionName: 'pay',
    args: payArgs(batch),
    value: batch.total,
  })
  return { account: safe, contract, balance }
}

export async function sendPayment(
  batch: Batch,
  quote: Quote,
  onSubmitted: (hash: Hash) => void,
) {
  const provider = injectedWallet()
  const client = createWalletClient({ chain: arcMainnet, transport: custom(provider) })
  const [activeAccount] = await client.getAddresses()
  if (activeAccount?.toLowerCase() !== quote.account.toLowerCase()) {
    throw new Error('Wallet account changed. Reconnect and review the payout again.')
  }
  await selectChain(arcMainnet)
  const currentQuote = await preparePayment(batch, quote.account)
  if (currentQuote.contract !== quote.contract) {
    throw new Error('Payout contract changed. Review the payout again.')
  }
  const hash = await client.writeContract({
    account: quote.account,
    chain: arcMainnet,
    address: quote.contract,
    abi: batchAbi,
    functionName: 'pay',
    args: payArgs(batch),
    value: batch.total,
    gas: currentQuote.gasLimit,
    maxFeePerGas: currentQuote.maxFeePerGas,
    maxPriorityFeePerGas: currentQuote.maxPriorityFeePerGas,
  })
  onSubmitted(hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  const payments = parsePaidReceipt(receipt, quote.contract, quote.account)
  assertMatchesReviewedBatch(payments, batch)
  return {
    hash,
    sender: quote.account,
    executor: null,
    payments,
    runs: [payments],
    blockNumber: receipt.blockNumber,
  }
}

// undefined: Arc Explorer could not be reached. null: it answered but has no block for the transaction,
// because it is unknown or still pending.
async function explorerBlockNumber(hash: Hash): Promise<bigint | null | undefined> {
  try {
    const response = await fetch(`${arcMainnet.blockExplorers.default.url}/api/v2/transactions/${hash}`)
    if (response.status === 404) return null
    if (!response.ok) return undefined
    const { block_number: block } = (await response.json()) as { block_number?: unknown }
    return typeof block === 'number' && Number.isSafeInteger(block) && block > 0 ? BigInt(block) : null
  } catch {
    return undefined
  }
}

// Arc's public RPC does not always find older transactions by hash. Older receipts are still served per block, so the
// block comes from the receipt link or from Arc Explorer, and the receipt itself is still read from Arc RPC.
async function findReceipt(hash: Hash, block?: bigint): Promise<TransactionReceipt> {
  try {
    return await publicClient.getTransactionReceipt({ hash })
  } catch (cause) {
    if (!(cause instanceof TransactionReceiptNotFoundError)) throw cause
    const blockNumber = block ?? (await explorerBlockNumber(hash))
    if (blockNumber === null) throw cause
    if (blockNumber === undefined) {
      throw new Error(
        "No receipt found on Arc RPC. The transaction may still be pending. If it is older, check it on Arc Explorer, because Arc's public RPC does not always find older transactions by hash",
      )
    }
    const receipts = await publicClient.request({ method: 'eth_getBlockReceipts', params: [numberToHex(blockNumber)] })
    const receipt = receipts?.find((candidate) => candidate.transactionHash.toLowerCase() === hash.toLowerCase())
    if (!receipt) throw new Error(`Block ${blockNumber} on Arc does not contain this transaction`)
    return formatTransactionReceipt(receipt)
  }
}

// The payer is read from the pinned contract's Paid events, so payouts sent through a Safe verify too.
export async function loadPayment(hash: Hash, payer?: Address, block?: bigint) {
  const contract = configuredContract()
  await assertPayoutContract(contract)
  const receipt = await findReceipt(hash, block)
  const sender = payerOf(receipt, contract, payer)
  const runs = parsePaidRuns(receipt, contract, sender)
  const executor = getAddress(receipt.from)
  return {
    hash,
    sender,
    executor: executor === sender ? null : executor,
    payments: runs.flat().map((payment, index) => ({ ...payment, index })),
    runs,
    blockNumber: receipt.blockNumber,
  }
}

export function explorerTransaction(hash: Hash): string {
  return `${arcMainnet.blockExplorers.default.url}/tx/${hash}`
}
