// User side: build and sign a sponsorship request. Runs wherever the user's key lives
// (wallet, the user's own agent). The desk never sees the user's private key.
import {
  encodeFunctionData,
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type Abi,
} from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import type { Call, SignedAuth, SponsorRequest } from './types.js';

export const EXECUTE_TYPES = {
  Call: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
  Execute: [
    { name: 'calls', type: 'Call[]' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export function executeDomain(chainId: number, account: Address) {
  return { name: 'SponsorDeskExecutor', version: '1', chainId, verifyingContract: account } as const;
}

function typedMessage(calls: Call[], nonce: bigint, deadline: number) {
  return {
    calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value || '0'), data: c.data })),
    nonce,
    deadline: BigInt(deadline),
  };
}

export function executeDigest(chainId: number, account: Address, calls: Call[], nonce: bigint, deadline: number): Hex {
  return hashTypedData({
    domain: executeDomain(chainId, account),
    types: EXECUTE_TYPES,
    primaryType: 'Execute',
    message: typedMessage(calls, nonce, deadline),
  });
}

export async function recoverRequestSigner(req: SponsorRequest): Promise<Address> {
  return recoverTypedDataAddress({
    domain: executeDomain(req.chainId, req.account),
    types: EXECUTE_TYPES,
    primaryType: 'Execute',
    message: typedMessage(req.calls, BigInt(req.nonce), req.deadline),
    signature: req.signature,
  });
}

export async function recoverAuthSigner(a: SignedAuth): Promise<Address> {
  return recoverAuthorizationAddress({
    authorization: { address: a.address, contractAddress: a.address, chainId: a.chainId, nonce: a.nonce, r: a.r, s: a.s, yParity: a.yParity } as any,
  });
}

export function encodeCall(to: Address, abi: Abi, functionName: string, args: unknown[]): Call {
  return { to, value: '0', data: encodeFunctionData({ abi, functionName, args } as any) };
}

export interface BuildOpts {
  user: LocalAccount;
  chainId: number;
  executor: Address;
  calls: Call[];
  executorNonce: bigint; // read from executor.nonce() on the account (0 if not delegated yet)
  accountTxNonce: number; // eth_getTransactionCount(account) - needed for the 7702 authorization
  needsAuthorization: boolean;
  ttlSec?: number;
  nowSec?: number;
  label?: string;
}

export async function buildSponsorRequest(o: BuildOpts): Promise<SponsorRequest> {
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const deadline = now + (o.ttlSec ?? 600);
  const signature = await o.user.signTypedData({
    domain: executeDomain(o.chainId, o.user.address),
    types: EXECUTE_TYPES,
    primaryType: 'Execute',
    message: typedMessage(o.calls, o.executorNonce, deadline),
  });
  let authorization: SignedAuth | null = null;
  if (o.needsAuthorization) {
    if (!o.user.signAuthorization) throw new Error('account cannot sign EIP-7702 authorizations');
    const a = await o.user.signAuthorization({ address: o.executor, contractAddress: o.executor, chainId: o.chainId, nonce: o.accountTxNonce } as any);
    authorization = {
      address: o.executor,
      chainId: o.chainId,
      nonce: o.accountTxNonce,
      r: a.r,
      s: a.s,
      yParity: Number(a.yParity ?? (a as any).v - 27n),
    };
  }
  return {
    version: 1,
    chainId: o.chainId,
    account: o.user.address,
    calls: o.calls,
    nonce: o.executorNonce.toString(),
    deadline,
    signature,
    authorization,
    label: o.label,
  };
}
