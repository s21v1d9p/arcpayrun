import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { formatUnits, getAddress, isAddress } from 'viem'
import type { Address, Hash } from 'viem'
import {
  arcMainnet,
  configuredContract,
  connectWallet,
  explorerTransaction,
  loadPayment,
  matchingRun,
  preparePayment,
  prepareSafePayment,
  sendPayment,
} from './lib/chain'
import type { Quote, SafeQuote } from './lib/chain'
import { parseCsvRows, validatePayouts } from './lib/payouts'
import type { Batch, PayoutInput } from './lib/payouts'
import { RevertedPaymentError } from './lib/receipts'
import {
  completeSafePayment,
  detectSafe,
  forgetPendingPayout,
  duplicateStatus,
  proposeSafePayment,
  refreshPendingPayouts,
  rememberPendingPayout,
  restoreBatch,
  SafeCancelledError,
  SafePendingError,
} from './lib/safe'
import type { SafeProgress, SafeSession } from './lib/safe'
import './App.css'

type PaymentResult = Awaited<ReturnType<typeof loadPayment>>
type Stage = 'idle' | 'connecting' | 'reviewing' | 'signing' | 'confirming' | 'loading'
type Mode = 'manual' | 'csv'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function usdc(value: bigint): string {
  return formatUnits(value, 18)
}

function recipientCount(count: number): string {
  return `${count} ${count === 1 ? 'recipient' : 'recipients'}`
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialTx = params.get('tx')
  const initialPayer = params.get('payer')
  const initialBlock = params.get('block')
  const payerValid = !initialPayer || isAddress(initialPayer)
  const blockValid = !initialBlock || /^[1-9][0-9]{0,15}$/.test(initialBlock)
  const linkedHash = initialTx && /^0x[0-9a-fA-F]{64}$/.test(initialTx) && payerValid && blockValid ? initialTx as Hash : null
  const linkedPayer = initialPayer && isAddress(initialPayer) ? getAddress(initialPayer) : undefined
  const linkedBlock = initialBlock && blockValid ? BigInt(initialBlock) : undefined
  const [mode, setMode] = useState<Mode>('manual')
  const [rows, setRows] = useState<PayoutInput[]>([{ address: '', amount: '' }])
  const [csv, setCsv] = useState('')
  const [account, setAccount] = useState<Address | null>(null)
  const [quote, setQuote] = useState<Quote | SafeQuote | null>(null)
  const [quoteFor, setQuoteFor] = useState('')
  const [stage, setStage] = useState<Stage>(linkedHash ? 'loading' : 'idle')
  const [error, setError] = useState(
    !payerValid
      ? 'Invalid payer address in share link'
      : !blockValid
      ? 'Invalid block number in share link'
      : initialTx && !linkedHash
      ? 'Invalid transaction hash in share link'
      : '',
  )
  const [hash, setHash] = useState<Hash | null>(linkedHash)
  const [payment, setPayment] = useState<PaymentResult | null>(null)
  const [failed, setFailed] = useState(false)
  const resultRef = useRef<HTMLElement>(null)
  // Shared receipt links open far above the result, so bring it into view once it settles.
  const scrollLinkResult = useRef(Boolean(initialTx))
  const proposing = useRef(false)
  const [submittedBatch, setSubmittedBatch] = useState<Batch | null>(null)
  const [safe, setSafe] = useState<SafeSession | null>(null)
  const [safeIssue, setSafeIssue] = useState('')
  const [safeTxHash, setSafeTxHash] = useState<string | null>(null)
  const [safeProgress, setSafeProgress] = useState<SafeProgress | null>(null)

  const contractState = useMemo(() => {
    try {
      return { address: configuredContract(), error: '' }
    } catch (cause) {
      return { address: null, error: errorMessage(cause) }
    }
  }, [])

  const draftKey = JSON.stringify({ mode, rows, csv, account })
  const calculation = useMemo(() => {
    try {
      if (mode === 'manual' && rows.length === 1 && !rows[0].address && !rows[0].amount) {
        return { batch: null, error: '' }
      }
      const inputs = mode === 'csv' ? parseCsvRows(csv) : rows
      return { batch: validatePayouts(inputs, contractState.address ?? undefined), error: '' }
    } catch (cause) {
      return { batch: null, error: errorMessage(cause) }
    }
  }, [mode, rows, csv, contractState.address])

  useEffect(() => {
    if (!linkedHash) return
    let active = true
    loadPayment(linkedHash, linkedPayer, linkedBlock)
      .then((result) => {
        if (active) {
          setPayment(result)
          setStage('idle')
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          if (cause instanceof RevertedPaymentError) setFailed(true)
          setError(`Could not verify receipt: ${errorMessage(cause)}`)
          setStage('idle')
        }
      })
    return () => {
      active = false
    }
  }, [linkedHash, linkedPayer, linkedBlock])

  useEffect(() => {
    let active = true
    // Outside Safe{Wallet}, or if it never answers, the normal wallet flow stays in place.
    detectSafe()
      .then(async (session) => {
        if (!active || !session) return
        if (session.chainId !== arcMainnet.id) {
          setSafeIssue('This Safe is not on Arc mainnet. Open a Safe on Arc (chain 5042) to pay from it.')
          return
        }
        setSafe(session)
        setAccount(session.address)
        const waiting = (await refreshPendingPayouts(session)).at(-1)
        if (active && waiting) {
          setSafeTxHash(waiting.safeTxHash)
          setSubmittedBatch(restoreBatch(waiting))
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!payment && !(scrollLinkResult.current && (error || failed))) return
    scrollLinkResult.current = false
    resultRef.current?.scrollIntoView?.({ block: 'start' })
  }, [payment, error, failed])

  const busy = stage !== 'idle'
  const reviewed = !hash && !safeTxHash && quote && quoteFor === draftKey && calculation.batch

  function newBatch() {
    if (!payment && !failed) return
    window.history.replaceState(null, '', window.location.pathname)
    setHash(null)
    setPayment(null)
    setFailed(false)
    setQuote(null)
    setSubmittedBatch(null)
    setSafeTxHash(null)
    setSafeProgress(null)
    setRows([{ address: '', amount: '' }])
    setCsv('')
    setMode('manual')
    setError('')
  }

  function changeRow(index: number, key: keyof PayoutInput, value: string) {
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)))
    setQuote(null)
    setError('')
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    try {
      if (file.size > 64 * 1024) throw new Error('CSV file exceeds 64 KB')
      const text = await file.text()
      parseCsvRows(text)
      setCsv(text)
      setMode('csv')
      setQuote(null)
    } catch (cause) {
      setError(`CSV import failed: ${errorMessage(cause)}`)
    }
    event.target.value = ''
  }

  async function connect() {
    setError('')
    setQuote(null)
    setAccount(null)
    setStage('connecting')
    try {
      setAccount(await connectWallet())
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setStage('idle')
    }
  }

  async function review() {
    if (!account || !calculation.batch) return
    setStage('reviewing')
    setError('')
    try {
      const nextQuote = safe
        ? await prepareSafePayment(calculation.batch, safe.address)
        : await preparePayment(calculation.batch, account)
      setQuote(nextQuote)
      setQuoteFor(draftKey)
    } catch (cause) {
      setError(`Could not prepare payout: ${errorMessage(cause)}`)
    } finally {
      setStage('idle')
    }
  }

  async function confirm() {
    if (!reviewed || !quote) return
    if (safe) return proposeInSafe(safe, reviewed, quote)
    if (!('maxNetworkFee' in quote)) return
    setStage('signing')
    setError('')
    let submittedHash: Hash | null = null
    try {
      const result = await sendPayment(reviewed, quote, (transactionHash) => {
        submittedHash = transactionHash
        setHash(transactionHash)
        setQuote(null)
        setSubmittedBatch(reviewed)
        window.history.replaceState(null, '', `?tx=${transactionHash}`)
        setStage('confirming')
      })
      setPayment(result)
      setQuote(null)
    } catch (cause) {
      if (cause instanceof RevertedPaymentError) setFailed(true)
      setError(
        cause instanceof RevertedPaymentError
          ? `Payment failed: ${errorMessage(cause)}. Check Arc Explorer before starting a new batch.`
          : submittedHash
          ? `Transaction submitted but not verified yet: ${errorMessage(cause)}. Use Retry receipt below.`
          : `Payment not submitted: ${errorMessage(cause)}`,
      )
    } finally {
      setStage('idle')
    }
  }

  async function proposeInSafe(session: SafeSession, batch: Batch, safeQuote: SafeQuote) {
    if (proposing.current) return
    proposing.current = true
    setStage('signing')
    setError('')
    try {
      const duplicate = await duplicateStatus(session, batch)
      if (duplicate !== 'none') {
        setError(
          duplicate === 'pending'
            ? 'This exact payout is already waiting in your Safe. Sign it in the Safe queue instead of proposing it again.'
            : 'Could not confirm with Safe whether this exact payout is still waiting. Try again in a moment, or use Forget this proposal if you deleted it in Safe.',
        )
        setStage('idle')
        return
      }
      let proposed: string
      try {
        proposed = await proposeSafePayment(session, batch, safeQuote)
      } catch (cause) {
        setError(`Payout not proposed: ${errorMessage(cause)}`)
        setStage('idle')
        return
      }
      rememberPendingPayout(session.address, proposed, batch)
      setSafeTxHash(proposed)
      setQuote(null)
      setSubmittedBatch(batch)
      await followSafePayment(session, proposed, batch, safeQuote.contract)
    } finally {
      proposing.current = false
    }
  }

  function clearSafeProposal() {
    setSafeTxHash(null)
    setSafeProgress(null)
    setSubmittedBatch(null)
    setError('')
  }

  async function followSafePayment(session: SafeSession, proposed: string, batch: Batch, contract: Address) {
    setStage('confirming')
    setError('')
    let executedHash: Hash | null = null
    try {
      const result = await completeSafePayment(session, batch, contract, proposed, {
        onProgress: setSafeProgress,
        onExecuted: (transactionHash) => {
          executedHash = transactionHash
          setHash(transactionHash)
          window.history.replaceState(null, '', `?tx=${transactionHash}&payer=${session.address}`)
        },
      })
      forgetPendingPayout(proposed)
      setPayment(result)
    } catch (cause) {
      if (cause instanceof RevertedPaymentError || cause instanceof SafeCancelledError) forgetPendingPayout(proposed)
      if (cause instanceof RevertedPaymentError) setFailed(true)
      if (cause instanceof SafeCancelledError) {
        clearSafeProposal()
        setError(`${errorMessage(cause)}. You can review the payout and propose it again.`)
        return
      }
      setError(
        cause instanceof RevertedPaymentError
          ? `Payment failed: ${errorMessage(cause)}. Check Arc Explorer before starting a new batch.`
          : cause instanceof SafePendingError
          ? `${errorMessage(cause)}. Use Check again after they do, or open the receipt link from the Safe's transaction history later.`
          : executedHash
          ? `Transaction executed but not verified yet: ${errorMessage(cause)}. Use Retry receipt below.`
          : `Could not follow the Safe transaction: ${errorMessage(cause)}`,
      )
    } finally {
      setStage('idle')
    }
  }

  async function retryReceipt() {
    if (!hash) return
    setStage('loading')
    setError('')
    try {
      const linked = hash === linkedHash
      const result = await loadPayment(hash, safe?.address ?? (linked ? linkedPayer : undefined), linked ? linkedBlock : undefined)
      const payments = submittedBatch ? matchingRun(result.runs, submittedBatch) : result.payments
      if (safeTxHash) forgetPendingPayout(safeTxHash)
      setPayment({ ...result, payments })
    } catch (cause) {
      if (cause instanceof RevertedPaymentError) setFailed(true)
      setError(`Could not verify receipt: ${errorMessage(cause)}`)
    } finally {
      setStage('idle')
    }
  }

  async function copyReceiptLink() {
    if (!hash) return
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${window.location.pathname}?tx=${hash}${payment?.executor ? `&payer=${payment.sender}` : ''}${payment ? `&block=${payment.blockNumber}` : ''}`,
      )
    } catch (cause) {
      setError(`Could not copy receipt link: ${errorMessage(cause)}`)
    }
  }

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Arc Payrun home">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>arc<span className="brand-weight">payrun</span><span className="brand-dot">.</span></span>
        </a>
        <nav className="header-nav" aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="https://docs.arc.io/" target="_blank" rel="noreferrer">Arc docs</a>
        </nav>
        <button className="wallet-button" type="button" onClick={connect} disabled={busy || !!safe}>
          <span className="status-light" aria-hidden="true" />
          {safe ? `Safe ${shortAddress(safe.address)}` : account ? shortAddress(account) : stage === 'connecting' ? 'Connecting...' : 'Connect wallet'}
        </button>
      </header>

      <main>
        <section className="hero-panel" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow">Runs on Arc mainnet (chain 5042)</div>
            <h1 id="hero-title">Batch payouts{' '}<br /><em>in USDC</em></h1>
            <p>Send USDC to up to 25 wallets in one Arc transaction. Once it confirms, you get a receipt link that anyone can check against the chain.</p>
            <a href="#workspace" className="hero-link">Start a payout <span aria-hidden="true">-&gt;</span></a>
          </div>
          <div className="hero-graphic" aria-hidden="true">
            <div className="graphic-node graphic-node-source">You</div>
            <div className="graphic-path path-top" />
            <div className="graphic-path path-middle" />
            <div className="graphic-path path-bottom" />
            <div className="graphic-node graphic-node-one">A</div>
            <div className="graphic-node graphic-node-two">B</div>
            <div className="graphic-node graphic-node-three">C</div>
          </div>
        </section>

        <section id="workspace" className="workspace" aria-labelledby="workspace-heading">
          <div className="section-intro">
            <h2 id="workspace-heading">Create a payout</h2>
            <p>{safe ? 'Add recipients, check the total, then propose one Arc transaction to your Safe.' : 'Add recipients, check the total, then approve one Arc transaction in your own wallet.'}</p>
          </div>

          <div className="workspace-grid">
            <div className="editor-card">
              <div className="card-topline">
                <h3>Recipients</h3>
              </div>
              <div className="mode-tabs" role="group" aria-label="Input method">
                <button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => { setMode('manual'); setQuote(null) }} disabled={busy}>Add manually</button>
                <button type="button" className={mode === 'csv' ? 'active' : ''} onClick={() => { setMode('csv'); setQuote(null) }} disabled={busy}>Paste CSV</button>
              </div>
              {mode === 'manual' ? (
                <div className="manual-input">
                  <div className="input-heading"><span>Wallet address</span><span>Amount (USDC)</span></div>
                  {rows.map((row, index) => (
                    <div className="recipient-row" key={index}>
                      <span className="row-number">{index + 1}</span>
                      <input
                        aria-label={`Recipient address ${index + 1}`}
                        placeholder="0x..."
                        spellCheck={false}
                        value={row.address}
                        onChange={(event) => changeRow(index, 'address', event.target.value)}
                        disabled={busy}
                      />
                      <div className="amount-field">
                        <input
                          aria-label={`Amount in USDC ${index + 1}`}
                          inputMode="decimal"
                          placeholder="0.00"
                          value={row.amount}
                          onChange={(event) => changeRow(index, 'amount', event.target.value)}
                          disabled={busy}
                        />
                        <span>USDC</span>
                      </div>
                      <button
                        type="button"
                        className="remove-row"
                        aria-label={`Remove recipient ${index + 1}`}
                        disabled={busy || rows.length === 1}
                        onClick={() => { setRows((current) => current.filter((_, rowIndex) => rowIndex !== index)); setQuote(null) }}
                      >x</button>
                    </div>
                  ))}
                  <button className="add-row" type="button" disabled={busy || rows.length >= 25} onClick={() => { setRows((current) => [...current, { address: '', amount: '' }]); setQuote(null) }}>
                    <span aria-hidden="true">+</span> Add recipient
                  </button>
                </div>
              ) : (
                <div className="csv-input">
                  <label htmlFor="csv-text">Payout CSV</label>
                  <p>One recipient per line as address,amount. A header row is optional. Up to 25 recipients.</p>
                  <textarea
                    id="csv-text"
                    value={csv}
                    onChange={(event) => { setCsv(event.target.value); setQuote(null); setError('') }}
                    placeholder={'address,amount\n0xYourRecipientAddress,1.25'}
                    spellCheck={false}
                    disabled={busy}
                  />
                </div>
              )}
              <div className="editor-footer">
                <label className="file-picker">
                  <input type="file" accept=".csv,text/csv" onChange={importCsv} disabled={busy} />
                  Import a CSV file
                </label>
                <span>Up to 25 recipients</span>
              </div>
              {calculation.error && <p className="validation-message">{calculation.error}</p>}
            </div>

            <aside className="review-card" aria-label="Payout summary">
              <div className="card-topline">
                <h3>Summary</h3>
              </div>
              <div className="summary-count">
                <span>Batch size</span>
                <strong>{recipientCount(calculation.batch?.payouts.length ?? 0)}</strong>
              </div>
              <div className="ledger-lines">
                {calculation.batch ? calculation.batch.payouts.map((payout, index) => (
                  <div className="ledger-line" key={payout.address}>
                    <span><i>{index + 1}.</i> {shortAddress(payout.address)}</span>
                    <b>{payout.amount}</b>
                  </div>
                )) : <p className="empty-ledger">Your payout preview will appear here when recipients are valid.</p>}
              </div>
              <div className="total-line">
                <span>Total to send</span>
                <strong>{calculation.batch ? usdc(calculation.batch.total) : '0.00'} <small>USDC</small></strong>
              </div>
              {quote && quoteFor === draftKey && ('maxNetworkFee' in quote ? (
                <div className="gas-detail">
                  <span>Wallet balance <b>{usdc(quote.balance)} USDC</b></span>
                  <span>Max estimated network fee <b>{usdc(quote.maxNetworkFee)} USDC</b></span>
                </div>
              ) : (
                <div className="gas-detail">
                  <span>Safe balance <b>{usdc(quote.balance)} USDC</b></span>
                  <span>Network fee <b>paid by the owner who executes it</b></span>
                </div>
              ))}
              <div className="review-actions">
                {reviewed ? (
                  <button type="button" className="primary-button" onClick={confirm} disabled={busy || !!safe?.readOnly}>
                    {safe
                      ? stage === 'signing' ? 'Confirm in Safe...' : 'Propose in Safe'
                      : stage === 'signing' ? 'Approve in your wallet...' : 'Confirm & pay'} <span aria-hidden="true">-&gt;</span>
                  </button>
                ) : (
                  <button type="button" className="primary-button" onClick={review} disabled={busy || !!hash || !!safeTxHash || !calculation.batch || !account || !contractState.address}>
                    {stage === 'reviewing' ? 'Checking Arc...' : 'Review batch'} <span aria-hidden="true">-&gt;</span>
                  </button>
                )}
                <p>Your {safe ? 'Safe' : 'wallet'} sends the total to the payout contract, which pays each recipient in the same transaction. If any payment fails, the whole batch reverts.</p>
              </div>
              {safeIssue && <p className="configuration-message" role="alert">{safeIssue}</p>}
              {safe?.readOnly && (
                <p className="configuration-message">{'Safe{Wallet} opened this Safe read-only. Connect an owner wallet in Safe{Wallet} to propose payouts.'}</p>
              )}
              {contractState.error && <p className="configuration-message">{contractState.error}. Deploy and set VITE_ARC_BATCH_ADDRESS to enable payments.</p>}
            </aside>
          </div>
        </section>

        {(error || hash || payment || safeTxHash) && (
          <section className="result-area" aria-live="polite" ref={resultRef}>
            {error && <div className="error-banner" role="alert">{error}</div>}
            {safeTxHash && !hash && !payment && (
              <div className="pending-card">
                <span className="tiny-label">Proposed in your Safe</span>
                <h2>{safeProgress === 'awaiting-execution' ? 'Signed. Waiting for an owner to execute it.' : 'Waiting for the Safe owners to sign.'}</h2>
                <p>The receipt appears here once the transaction runs on Arc. Do not propose this payout again.</p>
                <div className="result-actions">
                  <button
                    type="button"
                    onClick={() => safe && submittedBatch && contractState.address && followSafePayment(safe, safeTxHash, submittedBatch, contractState.address)}
                    disabled={busy}
                  >Check again</button>
                  <button type="button" onClick={clearSafeProposal} disabled={busy}>Start a different payout</button>
                  <button type="button" onClick={() => { forgetPendingPayout(safeTxHash); clearSafeProposal() }} disabled={busy}>Forget this proposal</button>
                </div>
              </div>
            )}
            {hash && !payment && (
              <div className="pending-card">
                <span className="tiny-label">{failed ? 'Transaction reverted' : 'Transaction submitted'}</span>
                <h2>{failed ? 'Transaction failed. No payouts were sent.' : stage === 'confirming' || stage === 'loading' ? 'Checking the chain...' : 'Receipt not verified yet.'}</h2>
                <p>{failed ? 'Your wallet only paid the transaction gas. Check the explorer before trying a new batch.' : 'Do not retry the payment unless you confirm this transaction failed. A pending transaction is not a successful payout.'}</p>
                <div className="result-actions">
                  <a href={explorerTransaction(hash)} target="_blank" rel="noreferrer">View transaction</a>
                  {failed ? <button type="button" onClick={newBatch}>Start new batch</button> : <button type="button" onClick={retryReceipt} disabled={busy}>Retry receipt</button>}
                </div>
              </div>
            )}
            {payment && (
              <div className="receipt-card" id="receipt">
                <span className="tiny-label">Confirmed on Arc mainnet, block {payment.blockNumber.toString()}</span>
                <h2>All payments confirmed</h2>
                <p>Sender {shortAddress(payment.sender)} paid {recipientCount(payment.payments.length)} in one transaction.{payment.executor ? ` Executed by ${shortAddress(payment.executor)}.` : ''}</p>
                <div className="receipt-list">
                  {payment.payments.map((item) => (
                    <div key={item.index}>
                      <span>{item.index + 1}. {shortAddress(item.recipient)}</span>
                      <strong>{usdc(item.amount)} USDC</strong>
                    </div>
                  ))}
                </div>
                <div className="result-actions">
                  <a href={explorerTransaction(payment.hash)} target="_blank" rel="noreferrer">Verify on Arc Explorer</a>
                  <button type="button" onClick={copyReceiptLink}>Copy receipt link</button>
                  <button type="button" onClick={newBatch}>Start new batch</button>
                </div>
              </div>
            )}
          </section>
        )}

        <section id="how-it-works" className="explainer">
          <div className="section-intro">
            <h2>How it works</h2>
          </div>
          <div className="explainer-grid">
            <div><h3>Add recipients</h3><p>Type them in or paste a CSV. The app doesn't store your list. It is sent through this site's RPC proxy to Arc for the gas estimate (or straight to Arc's public RPC if the proxy is down), and addresses and amounts become public once the payout is sent.</p></div>
            <div><h3>Approve one transaction</h3><p>You see the total and the gas estimate before your wallet asks you to sign. If any transfer fails, the whole batch is reverted.</p></div>
            <div><h3>Share the receipt</h3><p>The receipt link reads the payment events from Arc RPC and links to Arc Explorer, so anyone can check the payout there.</p></div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <div className="footer-brand">arc<span>payrun</span>.</div>
        <span>Batch USDC payouts on Arc mainnet</span>
        <nav className="footer-links" aria-label="Footer">
          <a href="https://github.com/s21v1d9p/arcpayrun" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://explorer.arc.io" target="_blank" rel="noreferrer">Arc Explorer</a>
        </nav>
      </footer>
    </div>
  )
}

export default App
