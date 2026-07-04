import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Page } from "puppeteer";
import { Wallet, JsonRpcProvider, getBytes } from "ethers";
import type { ChainConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSeed(): string {
  const p = resolve(__dirname, "..", ".wallets", "seed.txt");
  if (!existsSync(p)) throw new Error("No wallet seed. Run: pnpm gen:wallet");
  return readFileSync(p, "utf8").trim();
}

// Build the page-injection as a PLAIN JS STRING (not a TS function) so the bundler can't
// inject helpers (e.g. esbuild's __name) that would be undefined in the page. Runs before the
// dapp's scripts: an EIP-1193 provider announced via EIP-6963 that reports our address + the
// given chainId and forwards everything else to Node (window.__forkRpc).
function buildInjectSource(address: string, chainIdHex: string): string {
  return `(function(){
  var listeners = {};
  var address = ${JSON.stringify(address)};
  var chainIdHex = ${JSON.stringify(chainIdHex)};
  var rpc = function(m, p){ return window.__forkRpc(m, p || []); };
  var eth = {
    isMetaMask: true,
    _metamask: { isUnlocked: function(){ return Promise.resolve(true); } },
    selectedAddress: address,
    chainId: chainIdHex,
    request: function(a){
      var method = a.method, params = a.params;
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': return Promise.resolve([address]);
        case 'eth_chainId': return Promise.resolve(chainIdHex);
        case 'net_version': return Promise.resolve(String(parseInt(chainIdHex, 16)));
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain': return Promise.resolve(null);
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions': return Promise.resolve([{ parentCapability: 'eth_accounts' }]);
        case 'wallet_getCapabilities': return Promise.resolve({});
        case 'wallet_watchAsset': return Promise.resolve(true);
        default: return rpc(method, params || []);
      }
    },
    on: function(e, cb){ (listeners[e] = listeners[e] || []).push(cb); return this; },
    removeListener: function(e, cb){ listeners[e] = (listeners[e] || []).filter(function(x){ return x !== cb; }); return this; },
    enable: function(){ return Promise.resolve([address]); }
  };
  window.ethereum = eth;
  var info = { uuid: '11111111-1111-1111-1111-111111111111', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', rdns: 'io.metamask' };
  var announce = function(){ window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info, provider: eth }) })); };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;
}

// Attach an injected virtual wallet to a page: no browser extension, no popups. The provider
// reports `chainId` and proxies signing + reads to `rpcUrl`; the page's own JSON-RPC POSTs are
// also redirected there so a dapp UI that reads chain state via RPC sees the configured chain.
export async function setupInjectedWallet(
  page: Page,
  cfg: ChainConfig,
): Promise<{ address: string }> {
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const wallet = Wallet.fromPhrase(readSeed()).connect(provider);
  const chainIdHex = "0x" + cfg.chainId.toString(16);

  const forkRpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    if (method === "eth_sendTransaction") {
      const t = (params[0] || {}) as {
        to?: string;
        data?: string;
        value?: string;
        gas?: string;
      };
      const sent = await wallet.sendTransaction({
        to: t.to,
        data: t.data,
        value: t.value ? BigInt(t.value) : 0n,
        ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}),
      });
      return sent.hash;
    }
    if (method === "personal_sign") return wallet.signMessage(getBytes(params[0] as string));
    if (method === "eth_sign") return wallet.signMessage(getBytes(params[1] as string));
    if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1] as string) : (params[1] as Record<string, unknown>);
      const types = { ...(typed.types as Record<string, unknown>) };
      delete (types as Record<string, unknown>).EIP712Domain;
      return wallet.signTypedData(typed.domain, types as never, typed.message as never);
    }
    return provider.send(method, params as never[]);
  };

  await page.exposeFunction("__forkRpc", forkRpc);
  await page.evaluateOnNewDocument(buildInjectSource(wallet.address, chainIdHex));

  // Redirect the page's on-chain JSON-RPC reads to the configured chain.
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    try {
      const pd = req.method() === "POST" ? req.postData() : null;
      if (pd && /"method"\s*:\s*"(eth_|net_|web3_|debug_|trace_|erigon_)/.test(pd)) {
        const r = await fetch(cfg.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: pd,
        });
        await req.respond({ status: 200, contentType: "application/json", body: await r.text() });
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await req.continue();
    } catch {
      /* already handled */
    }
  });

  return { address: wallet.address };
}
