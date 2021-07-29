import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse withdraw", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await clearingHouse.addPool(baseToken.address, "10000")
    })

    describe("# withdraw", () => {
        beforeEach(async () => {
            await collateral.mint(alice.address, toWei(20000, await collateral.decimals()))
            await deposit(alice, vault, 20000, collateral)
            const collateralAmount = toWei(1000, await collateral.decimals())
            await collateral.mint(bob.address, collateralAmount)
            await deposit(bob, vault, 1000, collateral)

            // alice as maker add liq. first
            await pool.initialize(encodePriceSqrt("151.373306", "1"))
            await clearingHouse.connect(alice).mint(baseToken.address, toWei(500))
            await clearingHouse.connect(alice).mint(quoteToken.address, toWei(50000))
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(500),
                quote: toWei(50000),
                lowerTick: 50000,
                upperTick: 50400,
            })
        })

        it("taker do nothing and then withdraw", async () => {
            const amount = toWei(1000, await collateral.decimals())
            expect(await vault.getFreeCollateral(bob.address)).to.eq(amount)

            await expect(vault.connect(bob).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, amount)
            expect(await collateral.balanceOf(bob.address)).to.eq(amount)
            expect(await vault.balanceOf(bob.address)).to.eq("0")
        })

        it("taker swap then withdraw and verify maker's free collateral ", async () => {
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(100))
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei(100),
                sqrtPriceLimitX96: 0,
            })

            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(1000, 1000 - 0.998049666(fee)) - (0 + 100) * 10% = 989.001950334009680713
            expect(await vault.getFreeCollateral(bob.address)).to.eq("989001950334009680713")

            await expect(vault.connect(bob).withdraw(collateral.address, "989001950334009680713"))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, "989001950334009680713")
            expect(await collateral.balanceOf(bob.address)).to.eq("989001950334009680713")
            expect(await vault.balanceOf(bob.address)).to.eq("10998049665990319287")

            // verify maker's free collateral
            // collateral = 20,000, base debt = 500, quote debt = 50,000
            // position size = 0.6539993895
            // free collateral = min(20,000, 20,000.998) - (500 * 100 + 50,000) * 0.1 = 10,000
            expect(await vault.getFreeCollateral(alice.address)).to.eq(toWei(10000, await collateral.decimals()))
        })

        it("maker withdraw after adding liquidity", async () => {
            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(20000, 20000) - (500 * 100 + 50000, 0) * 10% = 10000
            const amount = toWei(10000, await collateral.decimals())
            expect(await vault.getFreeCollateral(alice.address)).to.eq(amount)

            await expect(vault.connect(alice).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, amount)
            expect(await collateral.balanceOf(alice.address)).to.eq(amount)
            expect(await vault.balanceOf(alice.address)).to.eq(amount)
        })

        it("force error, withdraw without deposit", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, toWei(1000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEB")
        })

        it("force error, margin requirement is larger than accountValue", async () => {
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(10000))
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei(10000),
                sqrtPriceLimitX96: 0,
            })

            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(1000, accountValue) < (0 + 10,000) * 10% = 1000
            // accountValue = 1000 + PnL, PnL is negative due to fee
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, toWei(1000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, margin requirement is larger than collateral", async () => {
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(100))
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(100),
                sqrtPriceLimitX96: 0,
            })

            // carol open a short position to make price goes down.
            // So that Bob has profit
            const collateralAmount = toWei(1000, await collateral.decimals())
            await collateral.mint(carol.address, collateralAmount)
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).mint(baseToken.address, toWei(10))
            await clearingHouse.connect(carol).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(1),
                sqrtPriceLimitX96: 0,
            })

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("110", 6), 0, 0, 0]
            })

            // free collateral = min(collateral, accountValue) - (totalBaseDebt + totalQuoteDebt) * imRatio
            // min(1000, 1000 + profit) < (0 + 100 * 110) * 10% = 1100
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, toWei(1000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, withdrawal amount is more than collateral", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, toWei(5000, await collateral.decimals())),
            ).to.be.revertedWith("V_NEB")
        })
    })
})