// Compiles contracts/*.sol with solc-js and writes ABI + bytecode to contracts/build/.
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const dir = path.resolve('contracts');
const sources: Record<string, { content: string }> = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sol'))) {
  sources[f] = { content: fs.readFileSync(path.join(dir, f), 'utf8') };
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: any) => e.severity === 'error');
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries<any>(out.contracts[file])) {
    const artifact = { contractName: name, compiler: solc.version(), evmVersion: 'paris', abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
    fs.writeFileSync(path.join(dir, 'build', `${name}.json`), JSON.stringify(artifact, null, 2));
    console.log(`compiled ${name} (${c.evm.bytecode.object.length / 2} bytes)`);
  }
}
