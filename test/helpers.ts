// Test-only in-memory chain. Hashes it returns are synthetic and are never presented as real.
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainClient, Fees, Receipt, SponsorTx } from '../src/chain.js';
import type { Policy } from '../src/types.js';

export const EXECUTOR = '0x00000000000000000000000000000000000E8ec0' as Address;
export const GUESTBOOK = '0x0000000000000000000000000000000000600D00' as Address;
export const OTHER = '0x000000000000000000000000000000000000BAd0' as Address;
export const CHAIN_ID = 688689;

// Deterministic throwaway test keys (well-known Anvil/Hardhat dev keys; never fund these).
export const SPONSOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
export const USER_KEYS: Hex[] = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
];
export const user = (i: number) => privateKeyToAccount(USER_KEYS[i]);

export function testPolicy(over: Partial<Policy> = {}): Policy {
  return {
    network: 'atlantic-testnet',
    executor: EXECUTOR,
    allowlist: [{ address: GUESTBOOK, label: 'DeskGuestbook', methods: ['checkIn(string)'] }],
    perAddressDaily: { maxTx: 1, maxGasWei: (10n ** 15n).toString() },
    globalDaily: { maxGasWei: (10n ** 16n).toString() },
    maxGasPerTx: 300000,
    maxCallsPerRequest: 4,
    maxDeadlineSec: 3600,
    allowValue: false,
    heuristics: {
      newAddressWindowSec: 600,
      maxNewAddressesPerWindow: 5,
      freshNonceThreshold: 1,
      burstWindowSec: 60,
      maxRequestsPerBurst: 3,
      failureWindowSec: 86400,
      maxFailures: 3,
    },
    ...over,
  };
}

export class MockChain implements ChainClient {
  chainId = CHAIN_ID;
  sponsor = privateKeyToAccount(SPONSOR_KEY).address;
  code = new Map<string, Hex>();
  txCount = new Map<string, number>();
  execNonce = new Map<string, bigint>();
  sent: SponsorTx[] = [];
  estimateGas = 80_000n;
  failEstimate: string | null = null;
  revertNext = false;
  fee: Fees = { maxFeePerGas: 1_200_000_000n, maxPriorityFeePerGas: 0n };
  private receipts = new Map<string, Receipt>();

  async getTxCount(a: Address) {
    return this.txCount.get(a.toLowerCase()) ?? 0;
  }
  async getCode(a: Address) {
    return this.code.get(a.toLowerCase()) ?? '0x';
  }
  async getBalance() {
    return 0n;
  }
  async readExecutorNonce(a: Address) {
    return this.execNonce.get(a.toLowerCase()) ?? 0n;
  }
  async fees() {
    return this.fee;
  }
  async estimate() {
    if (this.failEstimate) throw new Error(this.failEstimate);
    return this.estimateGas;
  }
  async send(tx: SponsorTx) {
    this.sent.push(tx);
    const acct = tx.to.toLowerCase();
    if (tx.authorization) {
      this.code.set(acct, ('0xef0100' + tx.authorization.address.slice(2).toLowerCase()) as Hex);
      this.txCount.set(acct, (this.txCount.get(acct) ?? 0) + 1);
    }
    const hash = keccak256(toHex(`mock-tx-${this.sent.length}`));
    const ok = !this.revertNext;
    this.revertNext = false;
    if (ok) this.execNonce.set(acct, (this.execNonce.get(acct) ?? 0n) + 1n);
    this.receipts.set(hash, { status: ok ? 'success' : 'reverted', gasUsed: 60_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: 1n, type: tx.authorization ? 'eip7702' : 'eip1559' });
    return hash;
  }
  async wait(hash: Hex) {
    return this.receipts.get(hash)!;
  }
}
