// Deploys SponsoredExecutor + DeskGuestbook with SPONSOR_PRIVATE_KEY (testnet only)
// and writes deployments/<network>.json plus a ready-to-edit policy file.
import fs from 'node:fs';
import { createWalletClient, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadNetwork, makeChain, publicClientFor, txUrl } from '../src/chain.js';
import { isoUtc } from '../src/ledger.js';

const netName = process.env.PHAROS_NETWORK ?? 'atlantic-testnet';
if (netName !== 'atlantic-testnet') throw new Error('deploy.ts is testnet-only by design');
const net = loadNetwork(netName);
const key = process.env.SPONSOR_PRIVATE_KEY as Hex;
if (!key) throw new Error('SPONSOR_PRIVATE_KEY not set');
const account = privateKeyToAccount(key);
const pub = publicClientFor(net);
const wallet = createWalletClient({ account, chain: makeChain(net), transport: http(net.rpcUrl) });

const chainId = await pub.getChainId();
if (chainId !== net.chainId) throw new Error(`RPC chainId ${chainId} != expected ${net.chainId}`);

async function deploy(name: string) {
  const art = JSON.parse(fs.readFileSync(`contracts/build/${name}.json`, 'utf8'));
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [] });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
  console.log(`${name}: ${r.contractAddress}  tx ${txUrl(net, hash)}`);
  return { address: getAddress(r.contractAddress), txHash: hash, blockNumber: r.blockNumber.toString() };
}

const executor = await deploy('SponsoredExecutor');
const guestbook = await deploy('DeskGuestbook');
fs.mkdirSync('deployments', { recursive: true });
const dep = { network: net.name, chainId, deployer: account.address, deployedAt: isoUtc(Date.now()), SponsoredExecutor: executor, DeskGuestbook: guestbook };
fs.writeFileSync(`deployments/${net.name}.json`, JSON.stringify(dep, null, 2));
const policy = JSON.parse(fs.readFileSync('assets/policy.example.json', 'utf8'));
policy.executor = executor.address;
policy.allowlist = [{ address: guestbook.address, label: 'DeskGuestbook (demo)', methods: ['checkIn(string)'] }];
fs.writeFileSync('examples/policy.atlantic.json', JSON.stringify(policy, null, 2));
console.log('wrote deployments/' + net.name + '.json and examples/policy.atlantic.json');
