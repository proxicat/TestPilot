// Execute a REAL Uniswap v3 swap (ETH -> USDC) on the Anvil mainnet fork, via Uniswap's
// SwapRouter02 with our controllable wallet. Uses real mainnet pool liquidity (from the
// fork), verified by the USDC balance increase. Proves the fork + wallet can do real swaps
// even though Uniswap's production UI can't see a local fork.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Wallet, JsonRpcProvider, Contract, Interface } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANVIL = "http://127.0.0.1:8545";
const SEED = readFileSync(resolve(root, ".wallets", "seed.txt"), "utf8").trim();

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // Uniswap SwapRouter02 (mainnet)
const FEE = 500; // WETH/USDC 0.05% pool (most liquid)
const AMOUNT_IN = 10_000_000_000_000_000n; // 0.01 ETH

const provider = new JsonRpcProvider(ANVIL, 1);
const wallet = Wallet.fromPhrase(SEED).connect(provider);

const routerAbi = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const usdcBalance = async () => {
  const data = erc20.encodeFunctionData("balanceOf", [wallet.address]);
  const r = await provider.send("eth_call", [{ to: USDC, data }, "latest"]);
  return BigInt(r);
};

const chainId = (await provider.getNetwork()).chainId;
const ethBefore = await provider.getBalance(wallet.address);
const usdcBefore = await usdcBalance();
console.log(JSON.stringify({ stage: "before", address: wallet.address, chainId: Number(chainId), ethBefore: ethBefore.toString(), usdcBefore: usdcBefore.toString() }));

const router = new Contract(ROUTER, routerAbi, wallet);
const params = {
  tokenIn: WETH,
  tokenOut: USDC,
  fee: FEE,
  recipient: wallet.address,
  amountIn: AMOUNT_IN,
  amountOutMinimum: 0n,
  sqrtPriceLimitX96: 0n,
};

const tx = await router.exactInputSingle(params, { value: AMOUNT_IN });
console.log(JSON.stringify({ stage: "sent", hash: tx.hash }));
const receipt = await tx.wait();

const usdcAfter = await usdcBalance();
const delta = usdcAfter - usdcBefore;
console.log(JSON.stringify({
  stage: "done",
  txHash: tx.hash,
  status: receipt.status,
  block: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  usdcBefore: usdcBefore.toString(),
  usdcAfter: usdcAfter.toString(),
  usdcReceived: (Number(delta) / 1e6).toFixed(6) + " USDC",
}));
process.exit(0);
