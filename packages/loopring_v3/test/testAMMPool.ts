import BN = require("bn.js");
import { Constants, Signature } from "loopringV3.js";
import { expectThrow } from "./expectThrow";
import { BlockCallback, ExchangeTestUtil } from "./testExchangeUtil";
import { AuthMethod, OrderInfo, SpotTrade } from "./types";
import * as sigUtil from "eth-sig-util";
import { SignatureType, sign, verifySignature } from "../util/Signature";

const AgentRegistry = artifacts.require("AgentRegistry");

export enum PoolTransactionType {
  NOOP,
  JOIN,
  EXIT
}

export interface PoolJoin {
  txType?: "Join";
  owner: string;
  fromLayer2: boolean;
  poolAmountOut: BN;
  maxAmountsIn: BN[];
  signature?: string;
}

export interface PoolExit {
  txType?: "Exit";
  owner: string;
  toLayer2: boolean;
  poolAmountIn: BN;
  minAmountsOut: BN[];
  signature?: string;
}

export interface PoolTransaction {
  txType: number;
  data: string;
  signature: string;
}

export interface AuxiliaryData {
  poolTransactions: PoolTransaction[];
}

export interface JoinOptions {
  authMethod?: AuthMethod;
}

export interface ExitOptions {
  authMethod?: AuthMethod;
}

type TxType = PoolJoin | PoolExit;

export namespace PoolJoinUtils {
  export function toTypedData(join: PoolJoin, verifyingContract: string) {
    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" }
        ],
        PoolJoin: [
          { name: "owner", type: "address" },
          { name: "fromLayer2", type: "bool" },
          { name: "poolAmountOut", type: "uint256" },
          { name: "maxAmountsIn", type: "uint256[]" }
        ]
      },
      primaryType: "PoolJoin",
      domain: {
        name: "AMM Pool",
        version: "1.0.0",
        chainId: new BN(/*await web3.eth.net.getId()*/ 1),
        verifyingContract
      },
      message: {
        owner: join.owner,
        fromLayer2: join.fromLayer2,
        poolAmountOut: join.poolAmountOut,
        maxAmountsIn: join.maxAmountsIn
      }
    };
    return typedData;
  }

  export function getHash(join: PoolJoin, verifyingContract: string) {
    const typedData = this.toTypedData(join, verifyingContract);
    return sigUtil.TypedDataUtils.sign(typedData);
  }
}

export namespace PoolExitUtils {
  export function toTypedData(exit: PoolExit, verifyingContract: string) {
    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" }
        ],
        PoolExit: [
          { name: "owner", type: "address" },
          { name: "toLayer2", type: "bool" },
          { name: "poolAmountIn", type: "uint256" },
          { name: "minAmountsOut", type: "uint256[]" }
        ]
      },
      primaryType: "PoolExit",
      domain: {
        name: "AMM Pool",
        version: "1.0.0",
        chainId: new BN(/*await web3.eth.net.getId()*/ 1),
        verifyingContract
      },
      message: {
        owner: exit.owner,
        toLayer2: exit.toLayer2,
        poolAmountIn: exit.poolAmountIn,
        minAmountsOut: exit.minAmountsOut
      }
    };
    return typedData;
  }

  export function getHash(exit: PoolExit, verifyingContract: string) {
    const typedData = this.toTypedData(exit, verifyingContract);
    return sigUtil.TypedDataUtils.sign(typedData);
  }
}

export class AmmPool {
  public ctx: ExchangeTestUtil;
  public contract: any;

  public feeBips: number;
  public tokens: string[];
  public weights: BN[];

  public BASE: BN = new BN(web3.utils.toWei("1", "ether"));
  public INITIAL_SUPPLY: BN = new BN(web3.utils.toWei("100", "ether"));

  public totalSupply: BN;

  public queue: TxType[];
  constructor(ctx: ExchangeTestUtil) {
    this.ctx = ctx;
    this.queue = [];
  }

  public async setupPool(tokens: string[], weights: BN[], feeBips: number) {
    this.feeBips = feeBips;
    this.tokens = tokens;
    this.weights = weights;

    this.totalSupply = new BN(0);

    const AmmPool = artifacts.require("AmmPool");
    this.contract = await AmmPool.new();

    // Create the AMM account
    const owner = this.contract.address;
    const deposit = await this.ctx.deposit(
      this.ctx.testContext.orderOwners[0],
      owner,
      "ETH",
      new BN(1),
      { autoSetKeys: false }
    );

    const tokenAddress: string[] = [];
    for (const token of tokens) {
      tokenAddress.push(this.ctx.getTokenAddress(token));
    }

    await this.contract.setupPool(
      this.ctx.exchange.address,
      deposit.accountID,
      tokenAddress,
      weights,
      feeBips
    );
  }

  public async deposit(owner: string, amounts: BN[]) {
    let value = new BN(0);
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      const amount = amounts[i];
      if (amount.gt(0)) {
        if (token !== Constants.zeroAddress) {
          const Token = await this.ctx.getTokenContract(token);
          await Token.setBalance(owner, amount);
          await Token.approve(this.contract.address, amount, { from: owner });
        } else {
          value = value.add(web3.utils.toBN(amount));
        }
      }
    }
    await this.contract.deposit(amounts, { value, from: owner });
  }

  public async join(
    owner: string,
    poolAmountOut: BN,
    maxAmountsIn: BN[],
    fromLayer2: boolean,
    options: JoinOptions = {}
  ) {
    // Fill in defaults
    const authMethod =
      options.authMethod !== undefined ? options.authMethod : AuthMethod.ECDSA;

    const poolJoin: PoolJoin = {
      txType: "Join",
      owner,
      fromLayer2,
      poolAmountOut,
      maxAmountsIn
    };

    if (authMethod === AuthMethod.APPROVE) {
      await this.contract.joinPool(poolAmountOut, maxAmountsIn, {
        from: owner
      });
    } else if (authMethod === AuthMethod.ECDSA) {
      const hash = PoolJoinUtils.getHash(poolJoin, this.contract.address);
      poolJoin.signature = await sign(owner, hash, SignatureType.EIP_712);
      await verifySignature(owner, hash, poolJoin.signature);
    }

    this.queue.push(poolJoin);
  }

  public async exit(
    owner: string,
    poolAmountIn: BN,
    minAmountsOut: BN[],
    toLayer2: boolean,
    options: ExitOptions = {}
  ) {
    // Fill in defaults
    const authMethod =
      options.authMethod !== undefined ? options.authMethod : AuthMethod.ECDSA;

    const poolExit: PoolExit = {
      txType: "Exit",
      owner,
      toLayer2,
      poolAmountIn,
      minAmountsOut
    };

    if (authMethod === AuthMethod.APPROVE) {
      await this.contract.exitPool(poolAmountIn, minAmountsOut, toLayer2, {
        from: owner
      });
    } else if (authMethod === AuthMethod.ECDSA) {
      const hash = PoolExitUtils.getHash(poolExit, this.contract.address);
      poolExit.signature = await sign(owner, hash, SignatureType.EIP_712);
      await verifySignature(owner, hash, poolExit.signature);
    }

    this.queue.push(poolExit);
  }

  public async depositAndJoin(
    owner: string,
    poolAmountOut: BN,
    maxAmountsIn: BN[]
  ) {
    await this.deposit(owner, maxAmountsIn);
    await this.join(owner, poolAmountOut, maxAmountsIn, false, {
      authMethod: AuthMethod.APPROVE
    });
  }

  public async process() {
    // To make things easy always start a new block and finalize state
    await this.ctx.submitTransactions();
    await this.ctx.submitPendingBlocks();

    const owner = this.contract.address;

    const ammBalancesInAccount: BN[] = [];
    const ammBalances: BN[] = [];
    for (let i = 0; i < this.tokens.length; i++) {
      await this.ctx.requestAmmUpdate(
        owner,
        this.tokens[i],
        this.feeBips,
        /*this.weights[i]*/ new BN(0),
        { authMethod: AuthMethod.NONE }
      );
      ammBalancesInAccount.push(
        await this.ctx.getOffchainBalance(owner, this.tokens[i])
      );
      ammBalances.push(
        await this.ctx.getOffchainBalance(owner, this.tokens[i])
      );
    }

    const poolTransactions: PoolTransaction[] = [];

    // Process work in the queue
    for (const item of this.queue) {
      if (item.txType === "Join") {
        const join = item;

        // Calculate expected amounts for specified liquidity tokens
        const poolTotal = this.totalSupply;
        let ratio = this.BASE;
        if (poolTotal.gt(new BN(0))) {
          ratio = join.poolAmountOut.mul(this.BASE).div(poolTotal);
        } else {
          assert(
            join.poolAmountOut.eq(this.INITIAL_SUPPLY),
            "INITIAL_SUPPLY_UNEXPECTED"
          );
        }

        for (let i = 0; i < this.tokens.length; i++) {
          let amount = ammBalances[i].mul(ratio).div(this.BASE);
          if (poolTotal.eq(new BN(0))) {
            amount = join.maxAmountsIn[i];
          }
          if (join.fromLayer2) {
            await this.ctx.transfer(
              join.owner,
              owner,
              this.tokens[i],
              amount,
              this.tokens[i],
              new BN(0),
              { authMethod: AuthMethod.NONE, amountToDeposit: new BN(0) }
            );
            ammBalancesInAccount[i] = ammBalancesInAccount[i].add(amount);
          }
          ammBalances[i] = ammBalances[i].add(amount);
          console.log(
            "pool join: " +
              amount.toString(10) +
              " (L" +
              (join.fromLayer2 ? 2 : 1) +
              ")"
          );
        }
        poolTransactions.push({
          txType: PoolTransactionType.JOIN,
          data: this.getPoolJoinAuxData(join),
          signature: join.signature
        });
        poolTotal.iadd(join.poolAmountOut);
      } else if (item.txType === "Exit") {
        const exit = item;

        const poolTotal = this.totalSupply;
        const ratio = exit.poolAmountIn.mul(this.BASE).div(poolTotal);

        for (let i = 0; i < this.tokens.length; i++) {
          const amount = ammBalances[i].mul(ratio).div(this.BASE);
          if (exit.toLayer2) {
            await this.ctx.transfer(
              owner,
              exit.owner,
              this.tokens[i],
              amount,
              this.tokens[i],
              new BN(0),
              {
                authMethod: AuthMethod.NONE,
                amountToDeposit: new BN(0),
                transferToNew: true
              }
            );
            ammBalancesInAccount[i] = ammBalancesInAccount[i].sub(amount);
          }
          ammBalances[i] = ammBalances[i].sub(amount);
          console.log("pool exit: " + amount.toString(10));
        }
        poolTransactions.push({
          txType: PoolTransactionType.EXIT,
          data: this.getPoolExitAuxData(exit),
          signature: exit.signature
        });
      }
    }

    // Deposit/Withdraw to/from the AMM account when necessary
    for (let i = 0; i < this.tokens.length; i++) {
      if (ammBalances[i].gt(ammBalancesInAccount[i])) {
        const amount = ammBalances[i].sub(ammBalancesInAccount[i]);
        await this.ctx.requestDeposit(owner, this.tokens[i], amount);
        console.log("pool deposit: " + amount.toString(10));
      } else if (ammBalances[i].lt(ammBalancesInAccount[i])) {
        const amount = ammBalancesInAccount[i].sub(ammBalances[i]);
        await this.ctx.requestWithdrawal(
          owner,
          this.tokens[i],
          amount,
          this.tokens[i],
          new BN(0),
          { authMethod: AuthMethod.NONE, minGas: 0 }
        );
        console.log("pool withdraw: " + amount.toString(10));
      }
    }

    // Re-enable weights
    for (let i = 0; i < this.tokens.length; i++) {
      await this.ctx.requestAmmUpdate(
        owner,
        this.tokens[i],
        this.feeBips,
        this.weights[i],
        { authMethod: AuthMethod.NONE }
      );
    }

    this.queue = [];

    console.log(poolTransactions);
    const auxiliaryData = this.getAuxiliaryData(poolTransactions);
    //console.log(auxiliaryData);
    const blockCallbacks: BlockCallback[] = [];
    blockCallbacks.push({
      target: owner,
      blockIdx: 0,
      txIdx: 0,
      auxiliaryData
    });
    await this.ctx.submitTransactions();
    await this.ctx.submitPendingBlocks(blockCallbacks);
  }

  public getPoolJoinAuxData(join: PoolJoin) {
    const amounts: string[] = [];
    for (const amount of join.maxAmountsIn) {
      amounts.push(amount.toString(10));
    }
    return web3.eth.abi.encodeParameter(
      "tuple(address,bool,uint256,uint256[])",
      [join.owner, join.fromLayer2, join.poolAmountOut.toString(10), amounts]
    );
  }

  public getPoolExitAuxData(exit: PoolExit) {
    const amounts: string[] = [];
    for (const amount of exit.minAmountsOut) {
      amounts.push(amount.toString(10));
    }
    return web3.eth.abi.encodeParameter(
      "tuple(address,bool,uint256,uint256[])",
      [exit.owner, exit.toLayer2, exit.poolAmountIn.toString(10), amounts]
    );
  }

  public getAuxiliaryData(txs: PoolTransaction[]) {
    const auxiliaryData: any[] = [];
    for (const tx of txs) {
      auxiliaryData.push([
        tx.txType,
        web3.utils.hexToBytes(tx.data),
        web3.utils.hexToBytes(tx.signature ? tx.signature : "0x")
      ]);
    }
    return web3.eth.abi.encodeParameter(
      "tuple(uint256,bytes,bytes)[]",
      auxiliaryData
    );
  }
}

contract("AMM Pool", (accounts: string[]) => {
  let ctx: ExchangeTestUtil;

  let agentRegistry: any;
  let registryOwner: string;

  before(async () => {
    ctx = new ExchangeTestUtil();
    await ctx.initialize(accounts);
  });

  after(async () => {
    await ctx.stop();
  });

  beforeEach(async () => {
    // Fresh Exchange for each test
    await ctx.createExchange(ctx.testContext.stateOwners[0], {
      setupTestState: true
    });

    // Create the agent registry
    registryOwner = accounts[7];
    agentRegistry = await AgentRegistry.new({ from: registryOwner });

    // Register it on the exchange contract
    const wrapper = await ctx.contracts.ExchangeV3.at(ctx.operator.address);
    await wrapper.setAgentRegistry(agentRegistry.address, {
      from: ctx.exchangeOwner
    });
  });

  describe("AMM", function() {
    this.timeout(0);

    it.only("Successful swap (AMM maker)", async () => {
      const ownerA = ctx.testContext.orderOwners[10];
      const ownerB = ctx.testContext.orderOwners[11];

      const feeBipsAMM = 30;
      const tokens = ["WETH", "GTO"];
      const weights = [
        new BN(web3.utils.toWei("1", "ether")),
        new BN(web3.utils.toWei("1", "ether"))
      ];

      for (const token of tokens) {
        await ctx.deposit(
          ownerB,
          ownerB,
          token,
          new BN(
            web3.utils.toWei(token === "WETH" ? "10000" : "20000", "ether")
          )
        );
      }

      const pool = new AmmPool(ctx);
      await pool.setupPool(tokens, weights, feeBipsAMM);

      await agentRegistry.registerUniversalAgent(pool.contract.address, true, {
        from: registryOwner
      });

      /*await pool.depositAndJoin(
        ownerA,
        new BN(web3.utils.toWei("1", "ether")),
        [
          new BN(web3.utils.toWei("10000", "ether")),
          new BN(web3.utils.toWei("20000", "ether"))
        ]
      );*/
      await pool.join(
        ownerB,
        new BN(web3.utils.toWei("100", "ether")),
        [
          new BN(web3.utils.toWei("10000", "ether")),
          new BN(web3.utils.toWei("20000", "ether"))
        ],
        true,
        { authMethod: AuthMethod.ECDSA }
      );
      await pool.process();

      const ring: SpotTrade = {
        orderA: {
          owner: pool.contract.address,
          tokenS: "WETH",
          tokenB: "GTO",
          amountS: new BN(web3.utils.toWei("98", "ether")),
          amountB: new BN(web3.utils.toWei("200", "ether")),
          feeBips: 0,
          amm: true
        },
        orderB: {
          tokenS: "GTO",
          tokenB: "WETH",
          amountS: new BN(web3.utils.toWei("200", "ether")),
          amountB: new BN(web3.utils.toWei("98", "ether"))
        },
        expected: {
          orderA: { filledFraction: 1.0, spread: new BN(0) },
          orderB: { filledFraction: 1.0 }
        }
      };
      await ctx.setupRing(ring, true, true, false, true);

      await ctx.deposit(
        ctx.exchangeOperator,
        ctx.exchangeOperator,
        ring.orderA.tokenB,
        ring.orderA.amountB
      );

      await ctx.sendRing(ring);
      await ctx.submitTransactions();
      await ctx.submitPendingBlocks();

      await pool.exit(
        ownerB,
        new BN(web3.utils.toWei("60", "ether")),
        [
          new BN(web3.utils.toWei("5000", "ether")),
          new BN(web3.utils.toWei("10000", "ether"))
        ],
        true,
        { authMethod: AuthMethod.ECDSA }
      );
      await pool.process();
    });
  });
});
