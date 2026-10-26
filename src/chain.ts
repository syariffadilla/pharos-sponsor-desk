import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SignedAuth } from './types.js';

export interface NetworkInfo {
  name: string;
  rpcUrl: string;
  chainId: number;
  explorerUrl: string;
  nativeToken: string;
  mcpUrl?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadNetwork(name?: string): NetworkInfo {
  const file = path.resolve(here, '..', 'assets', 'networks.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const n = cfg.networks.find((x: NetworkInfo) => x.name === (name ?? cfg.defaultNetwork));
  if (!n) throw new Error(`unknown network ${name}; known: ${cfg.networks.map((x: NetworkInfo) => x.name).join(', ')}`);
  if (process.env.PHAROS_RPC_URL) n.rpcUrl = process.env.PHAROS_RPC_URL;
  return n;
}

export const txUrl = (n: NetworkInfo, h: string) => `${n.explorerUrl.replace(/\/$/, '')}/tx/${h}`;
export const addrUrl = (n: NetworkInfo, a: string) => `${n.explorerUrl.replace(/\/$/, '')}/address/${a}`;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface SponsorTx {
  to: Address;
  data: Hex;
  gas: bigint;
  authorization?: SignedAuth | null;
  fees: Fees;
}

export interface Receipt {
  status: 'success' | 'reverted';
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: bigint;
  type: string;
}

/** Everything the desk needs from a chain. Tests implement this with an in-memory mock. */
export interface ChainClient {
  chainId: number;
  sponsor: Address;
  getTxCount(a: Address): Promise<number>;
  getCode(a: Address): Promise<Hex>;
  getBalance(a: Address): Promise<bigint>;
  readExecutorNonce(account: Address, executor: Address): Promise<bigint>;
  fees(): Promise<Fees>;
  /** Simulate the sponsor tx. Returns a gas estimate or throws with a reason. */
  estimate(tx: Omit<SponsorTx, 'gas' | 'fees'>): Promise<bigint>;
  send(tx: SponsorTx): Promise<Hex>;
  wait(hash: Hex): Promise<Receipt>;
}

export function makeChain(net: NetworkInfo) {
  return defineChain({
    id: net.chainId,
    name: `Pharos ${net.name}`,
    nativeCurrency: { name: net.nativeToken, symbol: net.nativeToken, decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
    blockExplorers: { default: { name: 'PharosScan', url: net.explorerUrl } },
  });
}

export function publicClientFor(net: NetworkInfo) {
  return createPublicClient({ chain: makeChain(net), transport: http(net.rpcUrl, { retryCount: 2, timeout: 30_000 }) });
}

const NONCE_ABI = [{ type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;

/** Delegation designator per EIP-7702: 0xef0100 || address */
export function delegatedTo(code: Hex): Address | null {
  if (code && code.toLowerCase().startsWith('0xef0100') && code.length === 2 + 46) return ('0x' + code.slice(8)) as Address;
  return null;
}

export class ViemChain implements ChainClient {
  chainId: number;
  sponsor: Address;
  private pub;
  private wallet;
  private account: PrivateKeyAccount;

  constructor(public net: NetworkInfo, sponsorKey: Hex) {
    this.chainId = net.chainId;
    this.account = privateKeyToAccount(sponsorKey);
    this.sponsor = this.account.address;
    const chain = makeChain(net);
    this.pub = publicClientFor(net);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(net.rpcUrl, { retryCount: 2, timeout: 30_000 }) });
  }

  getTxCount(a: Address) {
    return this.pub.getTransactionCount({ address: a, blockTag: 'latest' });
  }
  async getCode(a: Address) {
    return ((await this.pub.getCode({ address: a })) ?? '0x') as Hex;
  }
  getBalance(a: Address) {
    return this.pub.getBalance({ address: a });
  }
  async readExecutorNonce(account: Address, executor: Address) {
    const d = delegatedTo(await this.getCode(account));
    if (!d || d.toLowerCase() !== executor.toLowerCase()) return 0n;
    return this.pub.readContract({ address: account, abi: NONCE_ABI, functionName: 'nonce' });
  }
  async fees(): Promise<Fees> {
    const f = await this.pub.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
  }
  private authList(a?: SignedAuth | null) {
    if (!a) return undefined;
    return [{ address: a.address, contractAddress: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity }] as any;
  }
  async estimate(tx: Omit<SponsorTx, 'gas' | 'fees'>) {
    return this.pub.estimateGas({
      account: this.account,
      to: tx.to,
      data: tx.data,
      authorizationList: this.authList(tx.authorization),
    } as any);
  }
  async send(tx: SponsorTx) {
    const base: any = {
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.fees.maxFeePerGas,
      maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
    };
    if (tx.authorization) {
      base.authorizationList = this.authList(tx.authorization);
      base.type = 'eip7702';
    }
    const req = await this.wallet.prepareTransactionRequest(base);
    const raw = await this.wallet.signTransaction(req as any);
    return this.pub.sendRawTransaction({ serializedTransaction: raw });
  }
  async wait(hash: Hex): Promise<Receipt> {
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return { status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber, type: r.type };
  }
}
