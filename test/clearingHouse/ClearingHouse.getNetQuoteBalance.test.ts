import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse getNetQuoteBalance", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let accountBalance: AccountBalance
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        accountBalance = _clearingHouseFixture.accountBalance
        exchange = _clearingHouseFixture.exchange
        marketRegistry = _clearingHouseFixture.marketRegistry
        collateral = _clearingHouseFixture.USDC
        vault = _clearingHouseFixture.vault
        baseToken = _clearingHouseFixture.baseToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        // 1.0001 ^ 50400 = 154.4310960807
        await pool.initialize(encodePriceSqrt("154", "1"))
        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // prepare collateral for alice
        const aliceCollateral = parseUnits("100000", collateralDecimals)
        await collateral.mint(alice.address, aliceCollateral)
        await deposit(alice, vault, 100000, collateral)

        // prepare collateral for bob
        const bobCollateral = parseUnits("10000", collateralDecimals)
        await collateral.mint(bob.address, bobCollateral)
        await deposit(bob, vault, 10000, collateral)

        // prepare collateral for carol
        const carolCollateral = parseUnits("100000", collateralDecimals)
        await collateral.mint(carol.address, carolCollateral)
        await deposit(carol, vault, 10000, collateral)
    })

    describe("no swap, netQuoteBalance should be 0", () => {
        it("taker has no position", async () => {
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(parseEther("0"))
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(parseEther("0"))
        })

        it("maker adds liquidity below price with quote only", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerPosition: false,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(0)
        })

        it("maker adds liquidity above price with base only", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("3"),
                quote: parseEther("0"),
                lowerTick: 50400,
                upperTick: 50800,
                minBase: 0,
                minQuote: 0,
                useTakerPosition: false,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(parseEther("0"))
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(parseEther("0"))
        })

        it("maker adds liquidity with both quote and base", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("100"),
                lowerTick: 0, // $1
                upperTick: 100000, // $22015.4560485522
                minBase: 0,
                minQuote: 0,
                useTakerPosition: false,
                deadline: ethers.constants.MaxUint256,
            })
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.deep.eq(
                parseEther("0"),
            )
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.deep.eq(0)
        })
    })

    describe("netQuoteBalance != 0 after swaps", () => {
        it("a taker swaps and then closes position; the maker earns fee", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("100"),
                lowerTick: 0, // 1
                upperTick: 100000, // 22015.4560485522
                minBase: 0,
                minQuote: 0,
                useTakerPosition: false,
                deadline: ethers.constants.MaxUint256,
            })

            // taker swaps
            // base: 1
            // B2QFee: CH actually shorts 1 / 0.99 = 1.0101010101 and get 63.7442741703 quote
            // bob gets 63.7442741703 * 0.99 = 63.1068314286
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // current price = 26.3852759058

            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(parseEther("63.106831428587933867"))
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.be.closeTo(
                parseEther("-63.106831428587933867"),
                10,
            )

            // taker pays 63.7442741703 / 0.99 = 64.3881557276 quote to pay back 1 base
            await clearingHouse.connect(bob).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker sells all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

            // when taker swaps, maker gets 63.106831428587933867 / 0.99 * 0.01 = 0.6374427417
            // when taker closes position, maker gets 64.388155727566507365 * 0.01 = 0.6438815573
            // maker should get 0.6374427417 + 0.6438815573 = 1.281324299 quote as fee
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(parseEther("1.281324298978573495"))
        })

        it("two makers; a taker swaps and then one maker closes position", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("100"),
                lowerTick: 0, // 1
                upperTick: 100000, // 22015.4560485522
                minBase: 0,
                minQuote: 0,
                useTakerPosition: false,
                deadline: ethers.constants.MaxUint256,
            })

            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("100"),
                lowerTick: 50000, // 148.3760629231
                upperTick: 50800, // 160.7332272258
                minBase: 0,
                minQuote: 0,
                useTakerPosition: false,
                deadline: ethers.constants.MaxUint256,
            })

            // taker swaps 1 base to 133.884011906796397781 quote
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // current price = 70.3806594937

            // expect taker's netQuoteBalance == makers' netQuoteBalance
            const bobNetQuoteBalance = await accountBalance.getNetQuoteBalance(bob.address)
            const aliceNetQuoteBalance = await accountBalance.getNetQuoteBalance(alice.address)
            const carolNetQuoteBalance = await accountBalance.getNetQuoteBalance(carol.address)
            expect(aliceNetQuoteBalance.add(carolNetQuoteBalance).mul(-1)).to.be.closeTo(bobNetQuoteBalance, 10)

            await clearingHouse.connect(carol).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 50000,
                upperTick: 50800,
                liquidity: (await orderBook.getOpenOrder(carol.address, baseToken.address, 50000, 50800)).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            const carolDeltaQuote = (
                await clearingHouse.connect(carol).callStatic.closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            ).deltaQuote

            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // current price = 26.3852759058

            // carol's netQuoteBalance should be 0 after closing position
            expect(await accountBalance.getNetQuoteBalance(carol.address)).to.eq(0)

            // taker's netQuoteBalance won't change
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(bobNetQuoteBalance)

            // when bob shorts, carol is forced to long -> when carol closes position, it's short
            // thus, the last maker alice is forced to long more -> even smaller netQuoteBalance
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.be.eq(
                aliceNetQuoteBalance.sub(carolDeltaQuote),
            )
        })
    })
})
