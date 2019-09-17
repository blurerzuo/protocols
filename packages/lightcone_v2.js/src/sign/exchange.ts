import { EdDSA } from "../lib/sign/eddsa";
import { ethereum } from "../lib/wallet";
import { performance } from "perf_hooks";
import * as fm from "../lib/wallet/common/formatter";
import config from "../lib/wallet/config";
import Transaction from "../lib/wallet/ethereum/transaction";
import { WalletAccount } from "../lib/wallet/ethereum/walletAccount";
import {
  CancelRequest,
  GetAPIKeyRequest,
  GetDexNonceRequest,
  GetOrderDetailRequest,
  GetOrderIdRequest,
  GetOrdersRequest,
  GetUserActionsRequest,
  GetUserBalanceRequest,
  GetUserFeeRateRequest,
  GetUserTradesRequest,
  GetUserTransactionsRequest,
  OrderRequest,
  WithdrawalRequest
} from "../model/types";
import * as Poseidon from "../lib/sign/poseidon";

const assert = require("assert");

export class Exchange {
  private currentWalletAccount: WalletAccount;

  public createOrUpdateAccount(
    wallet: WalletAccount,
    password: string,
    nonce: number,
    gasPrice: number
  ) {
    try {
      const keyPair = EdDSA.generateKeyPair(wallet.getAddress() + password);
      this.currentWalletAccount = wallet;
      const transaction = this.createAccountAndDeposit(
        keyPair.publicKeyX,
        keyPair.publicKeyY,
        "",
        "0",
        nonce,
        gasPrice
      );
      return {
        rawTx: transaction,
        keyPair: keyPair
      };
    } catch (err) {
      console.error("Failed in method updateAccount. Error: ", err);
      throw err;
    }
  }

  private createAccountAndDeposit(
    publicX: string,
    publicY: string,
    symbol: string,
    amount: string,
    nonce: number,
    gasPrice: number
  ) {
    try {
      let address, value: string;
      const token = config.getTokenBySymbol(symbol);

      if (JSON.stringify(token) === "{}") {
        address = "0x0";
        value = "0";
      } else {
        address = token.address;
        value = fm.toHex(fm.toBig(amount).times("1e" + token.digits));
      }

      const data = ethereum.abi.Contracts.ExchangeContract.encodeInputs(
        "updateAccountAndDeposit",
        {
          pubKeyX: fm.toHex(fm.toBN(publicX)),
          pubKeyY: fm.toHex(fm.toBN(publicY)),
          tokenAddress: address,
          amount: value
        }
      );

      return new Transaction({
        to: config.getExchangeAddress(),
        value: fm.toHex(config.getFeeByType("create").feeInWEI),
        data: data,
        chainId: config.getChainId(),
        nonce: fm.toHex(nonce),
        gasPrice: fm.toHex(fm.fromGWEI(gasPrice)),
        gasLimit: fm.toHex(config.getGasLimitByType("create").gasInWEI)
      });
    } catch (err) {
      console.error("Failed in method createOrUpdateAccount. Error: ", err);
      throw err;
    }
  }

  public deposit(
    wallet: WalletAccount,
    symbol: string,
    amount: string,
    nonce: number,
    gasPrice: number
  ) {
    let to, value, data: string;
    try {
      const token = config.getTokenBySymbol(symbol);
      const fee = config.getFeeByType("deposit").feeInWEI;
      value = fm.toBig(amount).times("1e" + token.digits);

      if (wallet.getAddress()) {
        this.currentWalletAccount = wallet;
        if (symbol === "ETH") {
          to = "0x0";
          data = ethereum.abi.Contracts.ExchangeContract.encodeInputs(
            "deposit",
            {
              tokenAddress: to,
              amount: fm.toHex(value)
            }
          );
          value = value.plus(fee);
        } else {
          to = token.address;
          data = ethereum.abi.Contracts.ExchangeContract.encodeInputs(
            "deposit",
            {
              tokenAddress: to,
              amount: fm.toHex(value)
            }
          );
          value = fee;
        }

        return new Transaction({
          to: config.getExchangeAddress(),
          value: fm.toHex(value),
          data: data,
          chainId: config.getChainId(),
          nonce: fm.toHex(nonce),
          gasPrice: fm.toHex(fm.fromGWEI(gasPrice)),
          gasLimit: fm.toHex(config.getGasLimitByType("depositTo").gasInWEI)
        });
      }
    } catch (err) {
      console.error("Failed in method deposit. Error: ", err);
      throw err;
    }
  }

  public withdraw(
    wallet: WalletAccount,
    symbol: string,
    amount: string,
    nonce: number,
    gasPrice: number
  ) {
    let to, value, data: string;
    try {
      const token = config.getTokenBySymbol(symbol);
      const fee = config.getFeeByType("withdraw").feeInWEI;
      value = fm.toBig(amount).times("1e" + token.digits);

      if (wallet.getAddress()) {
        this.currentWalletAccount = wallet;
        to = symbol === "ETH" ? "0x0" : token.address;
        data = ethereum.abi.Contracts.ExchangeContract.encodeInputs(
          "withdraw",
          {
            tokenAddress: to,
            amount: fm.toHex(value)
          }
        );
        value = fee;
        return new Transaction({
          to: config.getExchangeAddress(),
          value: fm.toHex(value),
          data: data,
          chainId: config.getChainId(),
          nonce: fm.toHex(nonce),
          gasPrice: fm.toHex(fm.fromGWEI(gasPrice)),
          gasLimit: fm.toHex(
            config.getGasLimitByType("onchainWithdrawal").gasInWEI
          )
        });
      }
    } catch (err) {
      console.error("Failed in method withdraw. Error: ", err);
      throw err;
    }
  }

  public submitWithdrawal(withdrawal: WithdrawalRequest) {
    let token, feeToken;
    if (!withdrawal.token.startsWith("0x")) {
      token = config.getTokenBySymbol(withdrawal.token);
    } else {
      token = config.getTokenByAddress(withdrawal.token);
    }
    if (!withdrawal.feeToken.startsWith("0x")) {
      feeToken = config.getTokenBySymbol(withdrawal.feeToken);
    } else {
      feeToken = config.getTokenByAddress(withdrawal.feeToken);
    }
    let bigNumber = fm.toBig(withdrawal.amount).times("1e" + token.digits);
    withdrawal.tokenId = token.id;
    withdrawal.token = token.symbol;
    withdrawal.amountInBN = fm.toBN(bigNumber);

    bigNumber = fm.toBig(withdrawal.fee).times("1e" + feeToken.digits);
    withdrawal.feeTokenId = token.id;
    withdrawal.feeToken = feeToken.symbol;
    withdrawal.feeInBN = fm.toBN(bigNumber);

    withdrawal.label =
      withdrawal.label !== undefined ? withdrawal.label : config.getLabel();
    return this.signWithdrawal(withdrawal);
  }

  public signWithdrawal(withdrawal: WithdrawalRequest) {
    if (withdrawal.signature !== undefined) {
      return;
    }
    const account = withdrawal.account;
    const hasher = Poseidon.createHash(9, 6, 53);

    // Calculate hash
    const inputs = [
      config.getExchangeId(),
      account.accountId,
      withdrawal.tokenId,
      withdrawal.amountInBN,
      withdrawal.feeTokenId,
      withdrawal.feeInBN,
      withdrawal.label,
      account.nonce
    ];
    const hash = hasher(inputs).toString(10);

    // Create signature
    withdrawal.hash = hash;
    withdrawal.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, withdrawal.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return withdrawal;
  }

  public signOrder(order: OrderRequest) {
    if (order.signature !== undefined) {
      return;
    }
    const account = order.account;
    const hasher = Poseidon.createHash(14, 6, 53);

    // Calculate hash
    const startHash = performance.now();
    const inputs = [
      config.getExchangeId(),
      order.orderId,
      account.accountId,
      order.tokenSId,
      order.tokenBId,
      order.amountSInBN,
      order.amountBInBN,
      order.allOrNone ? 1 : 0,
      order.validSince,
      order.validUntil,
      order.maxFeeBips,
      order.buy ? 1 : 0,
      order.label
    ];
    order.hash = hasher(inputs).toString(10);
    const endHash = performance.now();
    console.log("Hash order time: " + (endHash - startHash));

    // Create signature
    const startSign = performance.now();
    order.signature = EdDSA.sign(account.keyPair.secretKey, order.hash);
    const endSign = performance.now();
    console.log("Sign order time: " + (endSign - startSign));

    // Verify signature
    const startVerify = performance.now();
    const success = EdDSA.verify(order.hash, order.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    const endVerify = performance.now();
    console.log("Verify order signature time: " + (endVerify - startVerify));
    return order;
  }

  public setupOrder(order: OrderRequest) {
    let tokenBuy, tokenSell;
    if (!order.tokenS.startsWith("0x")) {
      tokenSell = config.getTokenBySymbol(order.tokenS);
    } else {
      tokenSell = config.getTokenByAddress(order.tokenS);
    }
    if (!order.tokenB.startsWith("0x")) {
      tokenBuy = config.getTokenBySymbol(order.tokenB);
    } else {
      tokenBuy = config.getTokenByAddress(order.tokenB);
    }
    order.tokenS = tokenSell.address;
    order.tokenB = tokenBuy.address;
    order.tokenSId = tokenSell.id;
    order.tokenBId = tokenBuy.id;

    let bigNumber = fm.toBig(order.amountS).times("1e" + tokenSell.digits);
    order.amountSInBN = fm.toBN(bigNumber);
    bigNumber = fm.toBig(order.amountB).times("1e" + tokenBuy.digits);
    order.amountBInBN = fm.toBN(bigNumber);

    order.exchangeId =
      order.exchangeId !== undefined
        ? order.exchangeId
        : config.getExchangeId();
    order.buy = order.buy !== undefined ? order.buy : false;

    order.maxFeeBips =
      order.maxFeeBips !== undefined
        ? order.maxFeeBips
        : config.getMaxFeeBips();
    order.allOrNone = order.allOrNone ? order.allOrNone : false;

    order.feeBips =
      order.feeBips !== undefined ? order.feeBips : order.maxFeeBips;
    order.rebateBips = order.rebateBips !== undefined ? order.rebateBips : 0;
    order.label = order.label !== undefined ? order.label : config.getLabel();

    assert(order.maxFeeBips < 64, "maxFeeBips >= 64");
    assert(order.feeBips < 64, "feeBips >= 64");
    assert(order.rebateBips < 64, "rebateBips >= 64");
    assert(order.label < 2 ** 16, "order.label >= 2**16");

    // Sign the order
    return this.signOrder(order);
  }

  public getRandomInt(max: number) {
    return Math.floor(Math.random() * max);
  }

  public submitOrder(wallet: WalletAccount, request: OrderRequest) {
    this.currentWalletAccount = wallet;
    return this.setupOrder(request);
  }

  public signCancel(cancel: CancelRequest) {
    if (cancel.signature !== undefined) {
      return;
    }
    const account = cancel.account;
    const hasher = Poseidon.createHash(9, 6, 53);

    // Calculate hash
    const inputs = [
      config.getExchangeId(),
      account.accountId,
      cancel.orderTokenId,
      cancel.orderId,
      cancel.feeTokenId,
      cancel.feeInBN,
      cancel.label,
      account.nonce
    ];
    const hash = hasher(inputs).toString(10);

    // Create signature
    cancel.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, cancel.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return cancel;
  }

  public submitCancel(cancel: CancelRequest) {
    let orderToken, feeToken;
    if (!cancel.orderToken.startsWith("0x")) {
      orderToken = config.getTokenBySymbol(cancel.orderToken);
    } else {
      orderToken = config.getTokenByAddress(cancel.orderToken);
    }
    if (!cancel.feeToken.startsWith("0x")) {
      feeToken = config.getTokenBySymbol(cancel.feeToken);
    } else {
      feeToken = config.getTokenByAddress(cancel.feeToken);
    }
    cancel.feeTokenId = feeToken.id;
    cancel.orderTokenId = orderToken.id;

    let bigNumber = fm.toBig(cancel.fee).times("1e" + feeToken.digits);
    cancel.feeInBN = fm.toBN(bigNumber);

    cancel.label =
      cancel.label !== undefined ? cancel.label : config.getLabel();
    return this.signCancel(cancel);
  }

  public signGetApiKey(request: GetAPIKeyRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(4, 6, 53);

    // Calculate hash
    const inputs = [
      account.accountId,
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetDexNonce(request: GetDexNonceRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetOrderId(request: GetOrderIdRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(3, 6, 53);
    if (!request.tokenSell.startsWith("0x")) {
      request.tokenSId = config.getTokenBySymbol(request.tokenSell).id;
    } else {
      request.tokenSId = config.getTokenByAddress(request.tokenSell).id;
    }
    // Calculate hash
    const inputs = [account.accountId, request.tokenSId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetOrderDetail(request: GetOrderDetailRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(3, 6, 53);

    // Calculate hash
    const inputs = [account.accountId, request.orderHash];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetOrders(request: GetOrdersRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetUserBalance(request: GetUserBalanceRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetUserTransactions(request: GetUserTransactionsRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signUserActions(request: GetUserActionsRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetUserTrades(request: GetUserTradesRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }

  public signGetUserFeeRate(request: GetUserFeeRateRequest) {
    if (request.signature !== undefined) {
      return;
    }
    const account = request.account;
    const hasher = Poseidon.createHash(2, 6, 53);

    // Calculate hash
    const inputs = [account.accountId];
    const hash = hasher(inputs).toString(10);

    // Create signature
    request.signature = EdDSA.sign(account.keyPair.secretKey, hash);

    // Verify signature
    const success = EdDSA.verify(hash, request.signature, [
      account.keyPair.publicKeyX,
      account.keyPair.publicKeyY
    ]);
    assert(success, "Failed to verify signature");
    return request;
  }
}

export const exchange: Exchange = new Exchange();
