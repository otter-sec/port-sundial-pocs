import { describe } from 'mocha';
import { MockOraclesWrapper } from '@port.finance/mock-oracles';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { BN, Provider, setProvider } from '@project-serum/anchor';
import {
  INITIAL_MINT_AMOUNT,
  makeSDK,
  RESERVE_INIT_LIQUIDITY,
} from './workspace';
import {
  DEFAULT_RESERVE_CONFIG,
  DEFAULT_SUNDIAL_COLLATERAL_CONFIG,
  MOCK_ORACLES,
  PORT_LENDING,
} from './constants';
import {
  addCheckers,
  BNChecker,
  checkAfter,
  checkBefore,
  checkBNDiff,
  checkBNEqual,
  checkMintAmountDiff,
  checkTokenBalanceDiff,
  createDefaultReserve,
  createLendingMarket,
  divCeil,
  divCeiln,
  getPythPrice,
  KeyChecker,
  numberChecker,
  ReserveState,
} from './utils';
import {
  createAccountRentExempt,
  createMintAndVault,
  sleep,
} from '@project-serum/common';
import {
  initObligationInstruction,
  ParsedAccount,
  Port,
  PORT_PROFILE_DATA_SIZE,
  refreshObligationInstruction,
  refreshReserveInstruction,
  ReserveData,
  ReserveInfo,
  ReserveParser,
} from '@port.finance/port-sdk';
import { expectTX } from '@saberhq/chai-solana';
import { assert, expect } from 'chai';
import { getATAAddress, getOrCreateATA, MAX_U64 } from '@saberhq/token-utils';
import { TransactionEnvelope } from '@saberhq/solana-contrib';
import { Big } from 'big.js';
import {
  Buffer2BN,
  SundialCollateralConfig,
  SundialCollateralWrapper,
  SundialProfileCollateral,
  SundialProfileLoan,
  SundialWrapper,
  WAD,
} from '../src';
import invariant from 'tiny-invariant';

describe('SundialCollateral', () => {
  setProvider(Provider.local());
  const provider = Provider.local();

  const sdk = makeSDK();
  const sundialUSDCWrapper = sdk.sundialWrapper;
  const sundialSerumCollateralWrapper = sdk.sundialCollateralWrapper;
  const sundialPortWrapper = sdk.sundialWrapper;
  const sundialSolCollateralWrapper = sdk.sundialCollateralWrapper;
  const sundialSaberWrapper = sdk.sundialWrapper;

  const sundialProfileWrapper = sdk.sundialProfileWrapper;

  const mockOraclesWrapper = new MockOraclesWrapper(provider, MOCK_ORACLES);
  let usdcOracleKP: Keypair;
  let serumOracleKP: Keypair;
  let portOracleKP: Keypair;
  let solOracleKP: Keypair;
  let saberOracleKP: Keypair;

  let lendingMarketKP: Keypair;

  let USDCReserveState: ReserveState;
  let serumReserveState: ReserveState;
  let portReserveState: ReserveState;
  let solReserveState: ReserveState;
  let saberReserveState: ReserveState;

  let sundialMarketBase: Keypair;
  let parsedUSDCReserve: ParsedAccount<ReserveData>;
  let parsedSolReserve: ParsedAccount<ReserveData>;
  let parsedPortReserve: ParsedAccount<ReserveData>;
  let parsedSerumReserve: ParsedAccount<ReserveData>;
  let parsedSaberReserve: ParsedAccount<ReserveData>;

  let serumReserveInfo: ReserveInfo;
  let USDCMint: PublicKey;
  let portMint: PublicKey;
  let saberMint: PublicKey;
  let usdcVault: PublicKey;
  let serumVault: PublicKey;
  let portVault: PublicKey;
  let solVault: PublicKey;
  let saberVault: PublicKey;
  const ACCURACY_TOLERANCE = new Big('1e-18');
  const port: Port = Port.forMainNet({
    connection: provider.connection,
  });

  const SERUM_PRICE = new BN(5);
  const USDC_PRICE = new BN(1);
  const PORT_PRICE = new BN(2);
  const SOL_PRICE = new BN(100);
  const SABER_PRICE = new BN(3);
  //Set up
  before(async () => {
    sundialMarketBase = await sdk.createSundialMarket();

    [usdcOracleKP, solOracleKP, portOracleKP, serumOracleKP, saberOracleKP] =
      await Promise.all(
        Array(...Array(5)).map(async () => {
          return await mockOraclesWrapper.createAccount(
            mockOraclesWrapper.PYTH_PRICE_ACCOUNT_SIZE,
          );
        }),
      );

    await Promise.all(
      [
        [USDC_PRICE, usdcOracleKP],
        [SOL_PRICE, solOracleKP],
        [PORT_PRICE, portOracleKP],
        [SERUM_PRICE, serumOracleKP],
        [SABER_PRICE, saberOracleKP],
      ].map(async ([price, oracle]: [BN, Keypair]) => {
        await mockOraclesWrapper.writePythPrice(oracle, {
          price: price,
          slot: new BN(await provider.connection.getSlot()),
        });
      }),
    );

    lendingMarketKP = await createLendingMarket(provider);

    [
      [USDCMint, usdcVault],
      [, serumVault],
      [portMint, portVault],
      [saberMint, saberVault],
    ] = await Promise.all(
      Array(...Array(5)).map(async () => {
        return await createMintAndVault(
          provider,
          INITIAL_MINT_AMOUNT,
          undefined,
          6,
        );
      }),
    );

    [, solVault] = await createMintAndVault(
      provider,
      INITIAL_MINT_AMOUNT,
      undefined,
      3,
    );

    USDCReserveState = await createDefaultReserve(
      provider,
      RESERVE_INIT_LIQUIDITY,
      usdcVault,
      lendingMarketKP.publicKey,
      DEFAULT_RESERVE_CONFIG,
    );

    await mockOraclesWrapper.writePythPrice(portOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    portReserveState = await createDefaultReserve(
      provider,
      RESERVE_INIT_LIQUIDITY,
      portVault,
      lendingMarketKP.publicKey,
      DEFAULT_RESERVE_CONFIG,
      portOracleKP.publicKey,
    );

    await mockOraclesWrapper.writePythPrice(saberOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    saberReserveState = await createDefaultReserve(
      provider,
      RESERVE_INIT_LIQUIDITY,
      saberVault,
      lendingMarketKP.publicKey,
      DEFAULT_RESERVE_CONFIG,
      saberOracleKP.publicKey,
    );

    await mockOraclesWrapper.writePythPrice(solOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    solReserveState = await createDefaultReserve(
      provider,
      RESERVE_INIT_LIQUIDITY,
      solVault,
      lendingMarketKP.publicKey,
      DEFAULT_RESERVE_CONFIG,
      solOracleKP.publicKey,
    );

    await mockOraclesWrapper.writePythPrice(serumOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    serumReserveState = await createDefaultReserve(
      provider,
      RESERVE_INIT_LIQUIDITY,
      serumVault,
      lendingMarketKP.publicKey,
      {
        ...DEFAULT_RESERVE_CONFIG,
        minBorrowRate: 200,
        maxBorrowRate: 200,
        optimalBorrowRate: 200,
        loanToValueRatio: 90,
        liquidationThreshold: 95,
      },
      serumOracleKP.publicKey,
    );

    [
      parsedSerumReserve,
      parsedUSDCReserve,
      parsedSolReserve,
      parsedPortReserve,
      parsedSaberReserve,
    ] = await Promise.all(
      [
        serumReserveState,
        USDCReserveState,
        solReserveState,
        portReserveState,
        saberReserveState,
      ].map(async reserveState =>
        ReserveParser({
          pubkey: reserveState.address,
          account: await provider.connection.getAccountInfo(
            reserveState.address,
          ),
        }),
      ),
    );

    await updateOraclesSlot();
    const depositAmount = INITIAL_MINT_AMOUNT.divn(2);
    await Promise.all(
      [
        [serumReserveState, parsedSerumReserve, serumVault],
        [solReserveState, parsedSolReserve, solVault],
      ].map(
        async ([reserveState, parsedRserve, liquidityVault]: [
          ReserveState,
          ParsedAccount<ReserveData>,
          PublicKey,
        ]) => {
          const reserveInfo = await port.getReserve(reserveState.address);
          const { address: lPVault, instruction: createATAIx } =
            await getOrCreateATA({
              provider: sdk.provider,
              mint: parsedRserve.data.collateral.mintPubkey,
            });
          const depositIxs = await reserveInfo.depositReserve({
            amount: depositAmount,
            userLiquidityWallet: liquidityVault,
            destinationCollateralWallet: lPVault,
            userTransferAuthority: provider.wallet.publicKey,
          });
          const tx = new TransactionEnvelope(sdk.provider, [
            createATAIx,
            ...depositIxs,
          ]);
          expectTX(tx, 'Deposit to get LP').to.be.fulfilled;
        },
      ),
    );

    serumReserveInfo = await port.getReserve(serumReserveState.address);

    const obligationKp = await createAccountRentExempt(
      provider,
      PORT_LENDING,
      PORT_PROFILE_DATA_SIZE,
    );

    const initObIx = initObligationInstruction(
      obligationKp.publicKey,
      lendingMarketKP.publicKey,
      provider.wallet.publicKey,
    );

    const collateralizeAmount = depositAmount.divn(2);
    const depositObligationCollateralIxs =
      await serumReserveInfo.depositObligationCollateral({
        amount: collateralizeAmount,
        userCollateralWallet: await getATAAddress({
          mint: parsedSerumReserve.data.collateral.mintPubkey,
          owner: provider.wallet.publicKey,
        }),
        obligation: obligationKp.publicKey,
        obligationOwner: provider.wallet.publicKey,
        userTransferAuthority: provider.wallet.publicKey,
      });

    const depositTx = new Transaction();

    depositTx.add(initObIx, ...depositObligationCollateralIxs);

    await mockOraclesWrapper.writePythPrice(serumOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });

    await provider.send(depositTx);

    const borrowTx = new Transaction();
    borrowTx.add(
      refreshReserveInstruction(
        serumReserveState.address,
        serumOracleKP.publicKey,
      ),
    );
    borrowTx.add(
      refreshObligationInstruction(
        obligationKp.publicKey,
        [serumReserveState.address],
        [],
      ),
    );

    const borrowObligationCollateralIxs =
      await serumReserveInfo.borrowObligationLiquidity({
        amount: collateralizeAmount.muln(8).divn(10),
        userWallet: serumVault,
        obligation: obligationKp.publicKey,
        owner: provider.wallet.publicKey,
        userTransferAuthority: provider.wallet.publicKey,
      });
    borrowTx.add(...borrowObligationCollateralIxs);
    await mockOraclesWrapper.writePythPrice(serumOracleKP, {
      price: SERUM_PRICE,
      slot: new BN(await provider.connection.getSlot()),
    });
    await provider.send(borrowTx);
  });

  const FEE_IN_BIPS = 10;
  const usdcSundialName = 'USDC';
  const portSundialName = 'Port';
  const saberSundialName = 'SABER';

  const solSundialCollateralName = 'SOL';
  const serumSundialCollateralName = 'Serum';

  const updateOraclesSlot = async () => {
    await mockOraclesWrapper.writePythPrice(serumOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    await mockOraclesWrapper.writePythPrice(usdcOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    await mockOraclesWrapper.writePythPrice(portOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    await mockOraclesWrapper.writePythPrice(solOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    await mockOraclesWrapper.writePythPrice(saberOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
  };

  const refreshProfile = async (
    ...collateralAndReserves: [
      SundialCollateralWrapper,
      ParsedAccount<ReserveData>,
    ][]
  ) => {
    await updateOraclesSlot();
    await Promise.all(
      collateralAndReserves.map(
        async ([sundialCollateralWrapper, parsedReserve]) => {
          await expectTX(
            await sundialCollateralWrapper.refreshSundialCollateral(
              parsedReserve,
            ),
          ).to.be.fulfilled;
          await expectTX(
            await sundialProfileWrapper.refreshSundialProfile(),
            'RefreshSundialCollateral',
          ).to.be.fulfilled;
          await sundialCollateralWrapper.reloadData();
        },
      ),
    );
    await sundialProfileWrapper.reloadData();
  };

  it('Initialize Sundial', async () => {
    const duration = new BN(3600); // 3600 seconds from now
    const createTx = await sundialUSDCWrapper.createSundial({
      sundialName: usdcSundialName,
      owner: provider.wallet.publicKey,
      durationInSeconds: duration,
      liquidityMint: USDCMint,
      reserve: parsedUSDCReserve,
      sundialMarket: sundialMarketBase.publicKey,
      oracle: usdcOracleKP.publicKey,
      lendingFeeInBips: FEE_IN_BIPS,
      borrowingFeeInBips: FEE_IN_BIPS,
    });
    const principleMintBump = (
      await sundialUSDCWrapper.getPrincipleMintAndBump()
    )[1];
    const yieldMintBump = (await sundialUSDCWrapper.getYieldMintAndBump())[1];

    await addCheckers(
      async () => {
        await expectTX(createTx, 'Create sundial').to.be.fulfilled;
        await sundialUSDCWrapper.reloadData();
      },
      checkAfter(
        async () => sundialUSDCWrapper.sundialData.durationInSeconds,
        new BNChecker(duration).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialUSDCWrapper.sundialData.reserve,
        new KeyChecker(parsedUSDCReserve.pubkey).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialUSDCWrapper.sundialData.bumps.principleMintBump,
        new numberChecker(principleMintBump).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialUSDCWrapper.sundialData.bumps.yieldMintBump,
        new numberChecker(yieldMintBump).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialUSDCWrapper.sundialData.portLendingProgram,
        new KeyChecker(PORT_LENDING).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialUSDCWrapper.sundialData.oracle,
        new KeyChecker(usdcOracleKP.publicKey).eq().toChecker(),
      ),
    );

    await mockOraclesWrapper.writePythPrice(saberOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });
    await expectTX(
      await sundialSaberWrapper.createSundial({
        sundialName: saberSundialName,
        owner: provider.wallet.publicKey,
        durationInSeconds: duration,
        liquidityMint: saberMint,
        reserve: parsedSaberReserve,
        sundialMarket: sundialMarketBase.publicKey,
        oracle: saberOracleKP.publicKey,
        lendingFeeInBips: FEE_IN_BIPS,
        borrowingFeeInBips: FEE_IN_BIPS,
      }),
      'Create sundial saber',
    ).to.be.fulfilled;
    await sundialSaberWrapper.reloadData();
  });

  const LIQUIDITY_CAP = new BN(10_000_000_000);
  it('Initialize Sundial Collateral', async () => {
    const createTx =
      await sundialSerumCollateralWrapper.createSundialCollateral({
        name: serumSundialCollateralName,
        reserve: parsedSerumReserve,
        sundialMarket: sundialMarketBase.publicKey,
        config: {
          ...DEFAULT_SUNDIAL_COLLATERAL_CONFIG,
          liquidityCap: LIQUIDITY_CAP,
        },
      });
    let sundialCollateralData;
    const authorityBump = (
      await sundialSerumCollateralWrapper.getAuthorityAndBump()
    )[1];

    const portLpBump = (
      await sundialSerumCollateralWrapper.getLPTokenSupplyAndBump()
    )[1];
    await addCheckers(
      async () => {
        await expectTX(createTx, 'Create sundialCollateral').to.be.fulfilled;
        await sundialSerumCollateralWrapper.reloadData();
        sundialCollateralData =
          sundialSerumCollateralWrapper.sundialCollateralData;
      },
      checkAfter(
        async () => sundialCollateralData.bumps.portLpBump,
        new numberChecker(portLpBump).eq('Check port Lp bump').toChecker(),
      ),
      checkAfter(
        async () => sundialCollateralData.bumps.authorityBump,
        new numberChecker(authorityBump).eq('Check authority bump').toChecker(),
      ),
      checkAfter(
        async () => sundialCollateralData.portCollateralReserve,
        new KeyChecker(parsedSerumReserve.pubkey).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialCollateralData.sundialMarket,
        new KeyChecker(sundialMarketBase.publicKey).eq().toChecker(),
      ),
    );

    //Create Sundial Sol Collateral
    await expectTX(
      await sundialSolCollateralWrapper.createSundialCollateral({
        name: solSundialCollateralName,
        reserve: parsedSolReserve,
        sundialMarket: sundialMarketBase.publicKey,
        config: DEFAULT_SUNDIAL_COLLATERAL_CONFIG,
      }),
    ).to.be.fulfilled;
    await sundialSolCollateralWrapper.reloadData();
  });

  it('Initialize Sundial Profile', async () => {
    let sundialProfileData;
    await addCheckers(
      async () => {
        const createTx = await sundialProfileWrapper.createSundialProfile(
          sundialMarketBase.publicKey,
        );

        await expectTX(createTx, 'Create sundial profile').to.be.fulfilled;
        await sundialProfileWrapper.reloadData();
        sundialProfileData = sundialProfileWrapper.sundialProfileData;
      },
      checkAfter(
        async () => sundialProfileData.sundialMarket,
        new KeyChecker(sundialMarketBase.publicKey).eq().toChecker(),
      ),
      checkAfter(
        async () => sundialProfileData.user,
        new KeyChecker(provider.wallet.publicKey).eq().toChecker(),
      ),
    );
  });

  const collateralBalanceDiffChecks = (
    depositAmount: BN,
    sundialCollateralWrapper: SundialCollateralWrapper,
  ) => [
    checkTokenBalanceDiff(
      sdk.provider,
      async () =>
        (await sundialCollateralWrapper.getCollateralWalletAndBump())[0],
      depositAmount,
    ),
    checkTokenBalanceDiff(
      sdk.provider,
      async () =>
        getATAAddress({
          mint: sundialCollateralWrapper.sundialCollateralData.collateralMint,
          owner: provider.wallet.publicKey,
        }),
      depositAmount.neg(),
    ),
  ];

  const sundialProfileCollateralStateChecks = (
    depositAmount: BN,
    sundialCollateralWrapper: SundialCollateralWrapper,
    msg = '',
  ) => [
    checkBNDiff(
      async () => {
        await sundialCollateralWrapper.reloadData();
        return sundialProfileWrapper.getCollateralAmount(
          sundialCollateralWrapper.publicKey,
        );
      },
      depositAmount,
      `Check sundial collateral lp wallet, ${msg}`,
    ),
    sundialProfileCollateralValidate(sundialCollateralWrapper, msg),
  ];

  const sundialProfileCollateralValidate = (
    sundialCollateralWrapper: SundialCollateralWrapper,
    msg = '',
  ) =>
    checkAfter(
      async () => {
        await sundialCollateralWrapper.reloadData();
        const data = sundialCollateralWrapper.sundialCollateralData;
        return [
          Buffer2BN(data.collateralPrice),
          data.sundialCollateralConfig,
          sundialProfileWrapper.getCollateral(
            sundialCollateralWrapper.publicKey,
          ),
        ];
      },
      async ([price, config, collateral]: [
        BN,
        SundialCollateralConfig,
        SundialProfileCollateral,
      ]) => {
        invariant(collateral, 'Sundial Profile Collateral Not Exist');
        expect(
          Buffer2BN(collateral.asset.totalValue),
          `Check collateral value in profile collateral, ${msg}`,
        ).to.bignumber.eq(price.mul(collateral.asset.amount));
        expect(
          collateral.sundialCollateral,
          `Check collateral pubkey in profile collateral, ${msg}`,
        ).eqAddress(sundialCollateralWrapper.publicKey);
        expect(
          collateral.config.ltv.ltv,
          `Check ltv in profile collateral, ${msg}`,
        ).eq(config.ltv.ltv);
        expect(
          collateral.config.liquidationConfig.liquidationThreshold,
          `Check liquidation threshold in profile collateral, ${msg}`,
        ).eq(config.liquidationConfig.liquidationThreshold);
        expect(
          collateral.config.liquidationConfig.liquidationPenalty,
          `Check liquidation penalty in profile collateral, ${msg}`,
        ).eq(config.liquidationConfig.liquidationPenalty);
      },
    );
  const checkSundialProfileNumOfCollateralDiff = (diff: number) =>
    checkBNDiff(
      async () =>
        new BN(sundialProfileWrapper.sundialProfileData.collaterals.length),
      new BN(diff),
    );

  it('Deposit Sundial Collateral (Init new collateral asset)', async () => {
    const depositAmount = new BN(10_000);
    await addCheckers(
      async () => {
        await mockOraclesWrapper.writePythPrice(serumOracleKP, {
          slot: new BN(await provider.connection.getSlot()),
        });
        await expectTX(
          await sundialSerumCollateralWrapper.refreshSundialCollateral(
            parsedSerumReserve,
          ),
          'RefreshSundialCollateral',
        ).to.be.fulfilled;
        const depositTx = await sundialProfileWrapper.depositSundialCollateral(
          depositAmount,
          sundialSerumCollateralWrapper,
        );
        await expectTX(depositTx, 'Deposit Collateral').to.be.fulfilled;

        await sundialProfileWrapper.reloadData();
        await sundialSerumCollateralWrapper.reloadData();
      },
      ...collateralBalanceDiffChecks(
        depositAmount,
        sundialSerumCollateralWrapper,
      ),
      ...sundialProfileCollateralStateChecks(
        depositAmount,
        sundialSerumCollateralWrapper,
      ),
      checkSundialProfileNumOfCollateralDiff(1),
      checkBefore(
        async () => sundialProfileWrapper.sundialProfileData.collaterals,
        async collaterals => {
          expect(collaterals).deep.equal([]);
        },
      ),
    );
  });

  it('Deposit Sundial Collateral (Existing collateral)', async () => {
    const depositAmount = new BN(10_000);
    await addCheckers(
      async () => {
        const depositTx = await sundialProfileWrapper.depositSundialCollateral(
          depositAmount,
          sundialSerumCollateralWrapper,
        );
        await expectTX(depositTx, 'Deposit Collateral').to.be.fulfilled;
        await sundialProfileWrapper.reloadData();
      },
      ...collateralBalanceDiffChecks(
        depositAmount,
        sundialSerumCollateralWrapper,
      ),
      ...sundialProfileCollateralStateChecks(
        depositAmount,
        sundialSerumCollateralWrapper,
      ),
      checkSundialProfileNumOfCollateralDiff(0),
    );
  });

  const checkCollateralSlot = (sundialCollateral: SundialCollateralWrapper) =>
    checkAfter(async () => {
      const currentSlot = await provider.connection.getSlot();
      return [
        new BN(currentSlot),
        sundialCollateral.sundialCollateralData.lastUpdatedSlot.slot,
      ];
    }, checkBNEqual('Check Slot is updated'));

  it('Refresh SundialCollateral', async () => {
    await addCheckers(
      async () => {
        await mockOraclesWrapper.writePythPrice(serumOracleKP, {
          slot: new BN(await provider.connection.getSlot()),
        });

        const refreshSundialCollateralTx =
          await sundialSerumCollateralWrapper.refreshSundialCollateral(
            parsedSerumReserve,
          );
        await expectTX(refreshSundialCollateralTx, 'RefreshSundialCollateral')
          .to.be.fulfilled;
        await sundialSerumCollateralWrapper.reloadData();
      },
      checkCollateralSlot(sundialSerumCollateralWrapper),
    );
  });

  const loanBalanceDiffChecks = (
    mintAmount: BN,
    sundialWrapper: SundialWrapper,
    msg = '',
  ) => {
    const borrowFee = sundialUSDCWrapper.getBorrowFee(mintAmount);
    return [
      checkMintAmountDiff(
        sdk.provider,
        async () => (await sundialWrapper.getPrincipleMintAndBump())[0],
        mintAmount,
        `Check minted loan token amount diff within the tx, ${msg}`,
      ),
      checkTokenBalanceDiff(
        sdk.provider,
        () => sundialWrapper.getUserPrincipleWallet(),
        mintAmount.sub(borrowFee),
        `Check user loan token diff within the tx, ${msg}`,
      ),
    ];
  };

  const sundialProfileLoanStateChecks = (
    mintAmount: BN,
    sundialWrapper: SundialWrapper,
    msg = '',
  ) => [
    checkBNDiff(
      async () => {
        await sundialProfileWrapper.reloadData();
        return sundialProfileWrapper.getLoanAmount(sundialWrapper.publicKey);
      },
      mintAmount,
      msg,
    ),
    sundialProfileLoanValidate(sundialWrapper, msg),
  ];

  const sundialProfileLoanValidate = (
    sundialWrapper: SundialWrapper,
    msg = '',
  ) =>
    checkAfter(
      async () => {
        await sundialProfileWrapper.reloadData();
        return sundialProfileWrapper.getLoan(sundialWrapper.publicKey);
      },
      async (loan: SundialProfileLoan) => {
        invariant(loan, 'Sundial Profile Loan Not Exist');

        const oracle = sundialWrapper.sundialData.oracle;
        const price = await getPythPrice(provider, oracle);

        expect(
          Buffer2BN(loan.asset.totalValue).muln(1000000),
          `Check asset value in profile loan ${msg}`,
        ).to.bignumber.eq(
          new BN(price.mul(WAD.toString()).toString()).mul(loan.asset.amount),
        );
        expect(loan.sundial, `Check sundial in profile loan ${msg}`).eqAddress(
          sundialUSDCWrapper.publicKey,
        );
        expect(loan.oracle, `Check oracle in profile loan ${msg}`).eqAddress(
          oracle,
        );
        expect(
          loan.maturityUnixTimestamp,
          `Check maturity timestamp in profile loan ${msg}`,
        ).to.bignumber.equal(sundialUSDCWrapper.sundialData.endUnixTimeStamp);
      },
    );

  const checkSundialProfileNumOfLoanDiff = (diff: number) =>
    checkBNDiff(
      async () => new BN(sundialProfileWrapper.sundialProfileData.loans.length),
      new BN(diff),
    );

  it('Mint Sundial pUSDC (Init new loan asset)', async () => {
    const mintAmount = new BN(10);
    await addCheckers(
      async () => {
        await expectTX(
          await sundialProfileWrapper.refreshSundialProfile(),
          'RefreshSundialProfile',
        ).to.be.fulfilled;
        await mockOraclesWrapper.writePythPrice(usdcOracleKP, {
          slot: new BN(await provider.connection.getSlot()),
        });
        const mintTx =
          await sundialProfileWrapper.mintSundialLiquidityWithCollateral(
            mintAmount,
            sundialUSDCWrapper,
          );
        await expectTX(mintTx).to.be.fulfilled;
        await sundialProfileWrapper.reloadData();
      },
      checkBefore(
        async () => sundialProfileWrapper.sundialProfileData.loans,
        async beforeLoanList => {
          expect(beforeLoanList).deep.equal([]);
        },
      ),
      checkSundialProfileNumOfLoanDiff(1),
      ...sundialProfileLoanStateChecks(mintAmount, sundialUSDCWrapper),
      ...loanBalanceDiffChecks(mintAmount, sundialUSDCWrapper),
    );
  });

  it('Refresh SundialProfile', async () => {
    await addCheckers(
      async () => {
        //Change USDC price for refresh profile, collateral price doesn't need change to check,
        //Since it is changing within the time with positive interest, and the collateral is refreshed after last
        //profile refreshment
        await mockOraclesWrapper.writePythPrice(usdcOracleKP, {
          price: USDC_PRICE.muln(2),
          slot: new BN(await provider.connection.getSlot()),
        });
        const refreshProfileTx =
          await sundialProfileWrapper.refreshSundialProfile();
        await expectTX(refreshProfileTx, 'RefreshSundialProfile').to.be
          .fulfilled;
        await sundialProfileWrapper.reloadData();
      },
      sundialProfileCollateralValidate(sundialSerumCollateralWrapper),
      sundialProfileLoanValidate(sundialUSDCWrapper),
    );

    //recover USDC price
    await mockOraclesWrapper.writePythPrice(usdcOracleKP, {
      price: USDC_PRICE,
      slot: new BN(await provider.connection.getSlot()),
    });
    await expectTX(
      await sundialProfileWrapper.refreshSundialProfile(),
      'RefreshSundialProfile',
    ).to.be.fulfilled;
    await sundialProfileWrapper.reloadData();
  });

  it('Mint Sundial pUSDC (Existing loan)', async () => {
    const mintAmount = new BN(10);
    await addCheckers(
      async () => {
        await mockOraclesWrapper.writePythPrice(serumOracleKP, {
          slot: new BN(await provider.connection.getSlot()),
        });

        await refreshProfile([
          sundialSerumCollateralWrapper,
          parsedSerumReserve,
        ]);

        const mintTx =
          await sundialProfileWrapper.mintSundialLiquidityWithCollateral(
            mintAmount,
            sundialUSDCWrapper,
          );
        await expectTX(mintTx).to.be.fulfilled;

        await sundialProfileWrapper.reloadData();
      },
      checkSundialProfileNumOfLoanDiff(0),
      ...sundialProfileLoanStateChecks(mintAmount, sundialUSDCWrapper),
      ...loanBalanceDiffChecks(mintAmount, sundialUSDCWrapper),
    );
  });

  it('Mint too much Sundial pUSDC ', async () => {
    await mockOraclesWrapper.writePythPrice(serumOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });

    await expectTX(
      await sundialProfileWrapper.refreshSundialProfile(),
      'RefreshSundialProfile',
    ).to.be.fulfilled;
    await mockOraclesWrapper.writePythPrice(usdcOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });

    await expectTX(
      await sundialProfileWrapper.mintSundialLiquidityWithCollateral(
        new BN('1000000000'),
        sundialUSDCWrapper,
      ),
    ).to.be.rejected;
  });

  it('Change Sundial Collateral Config', async () => {
    await addCheckers(
      async () => {
        const changeTx = sundialSerumCollateralWrapper.changeConfig(
          DEFAULT_SUNDIAL_COLLATERAL_CONFIG,
        );
        expectTX(changeTx).to.be.fulfilled;
        await refreshProfile(
          [sundialSerumCollateralWrapper, parsedSerumReserve],
          [sundialSolCollateralWrapper, parsedSolReserve],
        );
      },
      sundialProfileCollateralValidate(sundialSerumCollateralWrapper),
    );
  });

  // same test as before, this should fail but erroneously succeeds
  it('Mint too much Sundial pUSDC ', async () => {
    await mockOraclesWrapper.writePythPrice(serumOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });

    await expectTX(
      await sundialProfileWrapper.refreshSundialProfile(),
      'RefreshSundialProfile',
    ).to.be.fulfilled;
    await mockOraclesWrapper.writePythPrice(usdcOracleKP, {
      slot: new BN(await provider.connection.getSlot()),
    });

    await expectTX(
      await sundialProfileWrapper.mintSundialLiquidityWithCollateral(
        new BN('1000000000'),
        sundialUSDCWrapper,
      ),
    ).to.be.rejected;
  });
});
